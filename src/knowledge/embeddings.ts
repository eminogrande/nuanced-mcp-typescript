import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { KnowledgeGraph, searchKnowledge, type KnowledgeNode, type KnowledgeNodeType, type SearchResult } from "./graph.js";

export interface Embedder {
  readonly model: string;
  embed(inputs: string[]): Promise<number[][]>;
}

export interface EmbeddingEntry {
  id: string;
  nodeID: string;
  chunkIndex: number;
  textHash: string;
  vector: string;
  scale: number;
  norm: number;
}

export interface EmbeddingIndex {
  version: 1;
  model: string;
  generatedAt: string;
  entries: EmbeddingEntry[];
}

export class OllamaEmbedder implements Embedder {
  constructor(
    readonly model = "qwen3-embedding:0.6b",
    private readonly endpoint = "http://127.0.0.1:11434",
    private readonly timeoutMs = 120_000,
  ) {}

  async embed(inputs: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model: this.model, input: inputs, truncate: true }),
      });
      if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json() as { embeddings?: number[][] };
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== inputs.length) throw new Error("Ollama returned an invalid embedding batch");
      return payload.embeddings;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function loadEmbeddingIndex(path: string): Promise<EmbeddingIndex | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as EmbeddingIndex;
    return value.version === 1 && Array.isArray(value.entries) ? value : null;
  } catch {
    return null;
  }
}

export async function buildEmbeddingIndex(
  graph: KnowledgeGraph,
  path: string,
  embedder: Embedder,
  options: { batchSize?: number; maxChunksPerNode?: number } = {},
): Promise<{ entries: number; reused: number; embedded: number }> {
  const old = await loadEmbeddingIndex(path);
  const reusable = new Map((old?.model === embedder.model ? old.entries : []).map((entry) => [entry.id, entry]));
  const pending: Array<{ id: string; nodeID: string; chunkIndex: number; textHash: string; text: string }> = [];
  const entries: EmbeddingEntry[] = [];
  let reused = 0;
  const nodes = [...graph.nodes.values()].filter((node) => !["keyword", "recording", "project", "session", "function"].includes(node.type));
  for (const node of nodes) {
    for (const [chunkIndex, text] of chunks(`${node.label}\n${node.text}`, 1_800, 200, options.maxChunksPerNode ?? 120).entries()) {
      const textHash = stable(text);
      const id = stable(`${node.id}:${chunkIndex}:${textHash}`);
      const existing = reusable.get(id);
      if (existing) {
        entries.push(existing);
        reused += 1;
      } else {
        pending.push({ id, nodeID: node.id, chunkIndex, textHash, text });
      }
    }
  }
  const batchSize = options.batchSize ?? 16;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const vectors = await embedder.embed(batch.map((item) => item.text));
    for (let index = 0; index < batch.length; index += 1) {
      entries.push({ ...withoutText(batch[index]), ...quantize(vectors[index]) });
    }
  }
  const index: EmbeddingIndex = { version: 1, model: embedder.model, generatedAt: new Date().toISOString(), entries };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(index) + "\n", { mode: 0o600 });
  await rename(temporaryPath, path);
  return { entries: entries.length, reused, embedded: pending.length };
}

export async function hybridSearchKnowledge(
  graph: KnowledgeGraph,
  query: string,
  limit: number,
  index: EmbeddingIndex | null,
  embedder: Embedder | null,
  types?: KnowledgeNodeType[],
): Promise<SearchResult[]> {
  const lexical = searchKnowledge(graph, query, 40, types);
  if (!index || !embedder || index.model !== embedder.model) return lexical.slice(0, limit);
  let queryVector: number[];
  try {
    [queryVector] = await embedder.embed([query]);
  } catch {
    return lexical.slice(0, limit);
  }
  const vectorByNode = new Map<string, number>();
  for (const entry of index.entries) {
    if (!graph.nodes.has(entry.nodeID)) continue;
    const score = cosine(queryVector, entry);
    if (score > (vectorByNode.get(entry.nodeID) ?? -1)) vectorByNode.set(entry.nodeID, score);
  }
  const vector = [...vectorByNode.entries()].sort((left, right) => right[1] - left[1]).slice(0, 40);
  const fused = new Map<string, number>();
  lexical.forEach((item, rank) => fused.set(item.node.id, (fused.get(item.node.id) ?? 0) + 1 / (60 + rank + 1)));
  vector.forEach(([id], rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank + 1)));

  const seeds = [...fused.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12);
  for (const [id, seedScore] of seeds) {
    for (const edge of graph.edges) {
      if (!semanticEdges.has(edge.type)) continue;
      const neighbor = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (neighbor && graph.nodes.has(neighbor)) fused.set(neighbor, Math.max(fused.get(neighbor) ?? 0, seedScore * 0.35));
    }
  }

  const ranked = [...fused.entries()]
    .flatMap(([id, score]) => {
      const node = graph.nodes.get(id);
      return node && node.type !== "keyword" && (!types || types.includes(node.type)) ? [{ node, score }] : [];
    })
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label));
  const packed = packCanonicalEvidence(graph, ranked, types, limit, query);
  return packed.map(({ node, score }) => ({ node, score, related: relatedNodes(graph, node.id) }));
}

function packCanonicalEvidence(
  graph: KnowledgeGraph,
  ranked: Array<{ node: KnowledgeNode; score: number }>,
  types: KnowledgeNodeType[] | undefined,
  limit: number,
  query: string,
): Array<{ node: KnowledgeNode; score: number }> {
  if (types?.some((type) => semanticNodeTypes.has(type))) return ranked.slice(0, limit);
  const preferenceIntent = /\b(should|prefer|preference|require|want|soll|sollen|mochte|wunscht)\b/i.test(normalizeForIntent(query));
  const groups = new Map<string, { node: KnowledgeNode; scores: number[] }>();
  for (const item of ranked) {
    if (item.node.type === "entity") continue;
    const sourceID = derivedNodeTypes.has(item.node.type) && typeof item.node.metadata.sourceID === "string"
      ? item.node.metadata.sourceID
      : item.node.id;
    const node = graph.nodes.get(sourceID);
    if (!node) continue;
    const intentBoost = preferenceIntent && item.node.type === "preference" ? 1.6
      : preferenceIntent && item.node.type === "task" ? 1.15
      : 1;
    const group = groups.get(sourceID) ?? { node, scores: [] };
    group.scores.push(item.score * intentBoost);
    groups.set(sourceID, group);
  }
  const candidates = [...groups.values()].map(({ node, scores }) => {
    scores.sort((left, right) => right - left);
    return { node, score: scores[0] + scores.slice(1, 3).reduce((sum, score) => sum + score * 0.12, 0) };
  }).sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label));
  if (limit < 5) return candidates.slice(0, limit);
  const packed: Array<{ node: KnowledgeNode; score: number }> = [];
  const deferred: Array<{ node: KnowledgeNode; score: number }> = [];
  const typeCounts = new Map<KnowledgeNodeType, number>();
  for (const candidate of candidates) {
    if ((typeCounts.get(candidate.node.type) ?? 0) >= 4) deferred.push(candidate);
    else {
      packed.push(candidate);
      typeCounts.set(candidate.node.type, (typeCounts.get(candidate.node.type) ?? 0) + 1);
    }
    if (packed.length === limit) break;
  }
  for (const candidate of deferred) {
    if (packed.length === limit) break;
    packed.push(candidate);
  }
  return packed;
}

function normalizeForIntent(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function relatedNodes(graph: KnowledgeGraph, id: string): KnowledgeNode[] {
  const weighted = graph.edges.flatMap((edge) => {
    if (!semanticEdges.has(edge.type)) return [];
    if (edge.from === id) return [{ id: edge.to, weight: edge.weight }];
    if (edge.to === id) return [{ id: edge.from, weight: edge.weight }];
    return [];
  });
  return weighted.sort((left, right) => right.weight - left.weight).slice(0, 5)
    .map((item) => graph.nodes.get(item.id)).filter((item): item is KnowledgeNode => Boolean(item));
}

const semanticEdges = new Set(["DERIVED_FROM", "MENTIONS", "CONTRADICTS", "SUPERSEDES", "HAS_TRANSCRIPT", "HAS_TURN", "NEXT", "CONTAINS", "CALLS"]);
const derivedNodeTypes = new Set<KnowledgeNodeType>(["claim", "decision", "preference", "task", "event"]);
const semanticNodeTypes = new Set<KnowledgeNodeType>([...derivedNodeTypes, "entity"]);

function quantize(vector: number[]): Pick<EmbeddingEntry, "vector" | "scale" | "norm"> {
  const max = Math.max(...vector.map((value) => Math.abs(value)), Number.EPSILON);
  const scale = max / 127;
  const values = Int8Array.from(vector.map((value) => Math.max(-127, Math.min(127, Math.round(value / scale)))));
  const norm = Math.sqrt(values.reduce((sum, value) => sum + (value * scale) ** 2, 0));
  return { vector: Buffer.from(values.buffer).toString("base64"), scale, norm };
}

function cosine(query: number[], entry: EmbeddingEntry): number {
  const bytes = Buffer.from(entry.vector, "base64");
  const values = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Math.min(query.length, values.length);
  let dot = 0;
  let queryNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += query[index] * values[index] * entry.scale;
    queryNorm += query[index] ** 2;
  }
  return dot / (Math.sqrt(queryNorm) * entry.norm || 1);
}

function chunks(value: string, size: number, overlap: number, limit: number): string[] {
  const output: string[] = [];
  for (let start = 0; start < value.length && output.length < limit; start += size - overlap) output.push(value.slice(start, start + size));
  return output.length ? output : [value];
}

function stable(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function withoutText(value: { id: string; nodeID: string; chunkIndex: number; textHash: string; text: string }): Omit<typeof value, "text"> {
  const { text: _text, ...rest } = value;
  return rest;
}
