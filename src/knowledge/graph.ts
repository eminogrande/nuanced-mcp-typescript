import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Graph } from "../graph/analyzer.js";

export type KnowledgeNodeType = "project" | "file" | "function" | "recording" | "transcript" | "prompt" | "keyword";
export type KnowledgeEdgeType = "CONTAINS" | "CALLS" | "HAS_TRANSCRIPT" | "TAGGED" | "MENTIONS" | "RELATED";

export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  label: string;
  text: string;
  path: string | null;
  metadata: Record<string, unknown>;
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  type: KnowledgeEdgeType;
  weight: number;
}

interface StoredGraph {
  version: 1;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface SearchResult {
  node: KnowledgeNode;
  score: number;
  related: KnowledgeNode[];
}

export class KnowledgeGraph {
  readonly nodes = new Map<string, KnowledgeNode>();
  edges: KnowledgeEdge[] = [];

  upsertNode(node: KnowledgeNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: KnowledgeEdge): void {
    if (edge.from === edge.to || !this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    const existing = this.edges.find((e) => e.from === edge.from && e.to === edge.to && e.type === edge.type);
    if (existing) existing.weight = Math.max(existing.weight, edge.weight);
    else this.edges.push(edge);
  }

  connectRelated(): void {
    this.edges = this.edges.filter((e) => e.type !== "RELATED");
    const documents = [...this.nodes.values()].filter((n) => !["keyword", "project", "file"].includes(n.type));
    const terms = new Map(documents.map((n) => [n.id, new Set(tokenize(`${n.label} ${n.text}`))]));
    for (let i = 0; i < documents.length; i += 1) {
      for (let j = i + 1; j < documents.length; j += 1) {
        const left = terms.get(documents[i].id)!;
        const right = terms.get(documents[j].id)!;
        const overlap = [...left].filter((term) => right.has(term)).length;
        if (overlap === 0) continue;
        this.addEdge({ from: documents[i].id, to: documents[j].id, type: "RELATED", weight: overlap });
        this.addEdge({ from: documents[j].id, to: documents[i].id, type: "RELATED", weight: overlap });
      }
    }
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const data: StoredGraph = { version: 1, nodes: [...this.nodes.values()], edges: this.edges };
    await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  }

  static async load(path: string): Promise<KnowledgeGraph> {
    const graph = new KnowledgeGraph();
    if (!existsSync(path)) return graph;
    const data = JSON.parse(await readFile(path, "utf8")) as StoredGraph;
    for (const node of data.nodes ?? []) graph.upsertNode(node);
    graph.edges = data.edges ?? [];
    return graph;
  }
}

export function mergeCodeGraph(target: KnowledgeGraph, repoPath: string, code: Graph): void {
  const repo = resolve(repoPath);
  const projectID = `project:${stable(repo)}`;
  target.upsertNode({ id: projectID, type: "project", label: basename(repo), text: repo, path: repo, metadata: {} });
  const functionIDs = new Map<string, string>();
  for (const [key, value] of Object.entries(code)) {
    const fileID = `file:${stable(value.filepath)}`;
    const functionID = `function:${stable(`${repo}:${key}`)}`;
    functionIDs.set(key, functionID);
    target.upsertNode({ id: fileID, type: "file", label: relative(repo, value.filepath), text: value.filepath, path: value.filepath, metadata: { project: repo } });
    target.upsertNode({ id: functionID, type: "function", label: key, text: `${key} ${relative(repo, value.filepath)}`, path: value.filepath, metadata: { lineno: value.lineno, end_lineno: value.end_lineno, project: repo } });
    target.addEdge({ from: projectID, to: fileID, type: "CONTAINS", weight: 1 });
    target.addEdge({ from: fileID, to: functionID, type: "CONTAINS", weight: 1 });
    addTermEdges(target, functionID, tokenize(key));
  }
  for (const [key, value] of Object.entries(code)) {
    const from = functionIDs.get(key);
    if (!from) continue;
    for (const callee of value.callees ?? []) {
      const to = functionIDs.get(callee);
      if (to) target.addEdge({ from, to, type: "CALLS", weight: 1 });
    }
  }
}

export async function ingestDictatorArchive(graph: KnowledgeGraph, archivePath: string): Promise<number> {
  const archiveRoot = resolve(archivePath) + "/";
  const stale = new Set([...graph.nodes.values()]
    .filter((node) => ["recording", "transcript"].includes(node.type) && node.path && resolve(node.path).startsWith(archiveRoot))
    .map((node) => node.id));
  for (const id of stale) graph.nodes.delete(id);
  graph.edges = graph.edges.filter((edge) => !stale.has(edge.from) && !stale.has(edge.to));

  const paths = await walkIncludingHidden(archivePath);
  let count = 0;
  for (const metadataPath of paths) {
    if (basename(metadataPath) === "graph.json" || extname(metadataPath) !== ".json") continue;
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); } catch { continue; }
    if (metadata.status !== "completed" || typeof metadata.sessionID !== "string") continue;
    const directory = dirname(metadataPath);
    const id = metadata.sessionID;
    const transcriptFilename = String(metadata.transcriptFilename ?? "transcript.txt");
    const audioFilename = String(metadata.audioFilename ?? "audio.wav");
    const transcriptPath = join(directory, transcriptFilename);
    const audioPath = join(directory, audioFilename);
    const transcript = await readFile(transcriptPath, "utf8").catch(() => "");
    if (!transcript.trim()) continue;
    const recordingID = `recording:${id}`;
    const transcriptID = `transcript:${id}`;
    const fallbackLabel = transcript.split(/[.!?]/)[0].trim().split(/\s+/).slice(0, 8).join(" ") || id;
    const label = String(metadata.headline ?? fallbackLabel);
    graph.upsertNode({ id: recordingID, type: "recording", label, text: String(metadata.summary ?? transcript), path: audioPath, metadata });
    graph.upsertNode({ id: transcriptID, type: "transcript", label: `${label} transcript`, text: transcript, path: transcriptPath, metadata: { sessionID: id } });
    graph.addEdge({ from: recordingID, to: transcriptID, type: "HAS_TRANSCRIPT", weight: 1 });
    const keywords = Array.isArray(metadata.keywords) ? metadata.keywords.map(String) : tokenize(transcript).slice(0, 12);
    addTermEdges(graph, recordingID, keywords);
    addTermEdges(graph, transcriptID, keywords);
    count += 1;
  }
  const tagged = new Set(graph.edges.filter((edge) => edge.type === "TAGGED").map((edge) => edge.to));
  for (const node of [...graph.nodes.values()]) {
    if (node.type === "keyword" && !tagged.has(node.id)) graph.nodes.delete(node.id);
  }
  return count;
}

export async function ingestRepositoryFiles(graph: KnowledgeGraph, repoPath: string): Promise<number> {
  const repo = resolve(repoPath);
  const projectID = `project:${stable(repo)}`;
  graph.upsertNode({ id: projectID, type: "project", label: basename(repo), text: repo, path: repo, metadata: {} });
  const sourceExtensions = new Set([".swift", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp", ".md"]);
  let count = 0;
  for (const path of await walk(repo)) {
    if (!sourceExtensions.has(extname(path).toLowerCase())) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    if (!text.trim()) continue;
    const id = `file:${stable(path)}`;
    graph.upsertNode({ id, type: "file", label: relative(repo, path), text: text.slice(0, 200_000), path, metadata: { project: repo } });
    graph.addEdge({ from: projectID, to: id, type: "CONTAINS", weight: 1 });
    addTermEdges(graph, id, tokenize(text).slice(0, 30));
    count += 1;
  }
  return count;
}

export async function ingestPromptDirectory(graph: KnowledgeGraph, promptPath: string): Promise<number> {
  const paths = await walk(promptPath);
  let count = 0;
  for (const path of paths) {
    if (![".md", ".txt", ".json", ".jsonl"].includes(extname(path).toLowerCase())) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    if (!text.trim()) continue;
    const id = `prompt:${stable(path)}`;
    graph.upsertNode({ id, type: "prompt", label: basename(path), text: text.slice(0, 100_000), path, metadata: {} });
    addTermEdges(graph, id, tokenize(text).slice(0, 20));
    count += 1;
  }
  return count;
}

export function searchKnowledge(graph: KnowledgeGraph, query: string, limit = 20, types?: KnowledgeNodeType[]): SearchResult[] {
  const wanted = new Set(tokenize(query));
  if (wanted.size === 0) return [];
  return [...graph.nodes.values()]
    .filter((node) => node.type !== "keyword" && (!types || types.includes(node.type)))
    .map((node) => {
      const label = new Set(tokenize(node.label));
      const body = new Set(tokenize(node.text));
      let score = 0;
      for (const term of wanted) {
        if (label.has(term)) score += 5;
        if (body.has(term)) score += 2;
      }
      const relatedIDs = graph.edges.filter((e) => e.from === node.id && ["RELATED", "CALLS", "HAS_TRANSCRIPT"].includes(e.type)).sort((a, b) => b.weight - a.weight).slice(0, 5).map((e) => e.to);
      return { node, score, related: relatedIDs.map((id) => graph.nodes.get(id)).filter((n): n is KnowledgeNode => Boolean(n)) };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

function addTermEdges(graph: KnowledgeGraph, from: string, values: string[]): void {
  for (const term of [...new Set(values.map(normalize).filter((v) => v.length >= 3))].slice(0, 24)) {
    const id = `keyword:${term}`;
    graph.upsertNode({ id, type: "keyword", label: term, text: term, path: null, metadata: {} });
    graph.addEdge({ from, to: id, type: "TAGGED", weight: 1 });
  }
}

function tokenize(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).map(normalize).filter((part) => (/^\d+$/.test(part) || part.length >= 3) && !STOP.has(part));
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

async function walk(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [root];
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "build"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}


async function walkIncludingHidden(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [root];
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walkIncludingHidden(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function stable(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

const STOP = new Set(["and", "are", "das", "der", "die", "ein", "eine", "for", "from", "have", "ich", "ist", "mit", "not", "oder", "that", "the", "this", "und", "von", "was", "with", "you"]);
