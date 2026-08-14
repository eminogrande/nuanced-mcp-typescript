import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Graph } from "../graph/analyzer.js";

export type KnowledgeNodeType =
  | "project"
  | "file"
  | "function"
  | "recording"
  | "transcript"
  | "prompt"
  | "document"
  | "memory"
  | "session"
  | "turn"
  | "keyword";
export type KnowledgeEdgeType =
  | "CONTAINS"
  | "CALLS"
  | "HAS_TRANSCRIPT"
  | "HAS_TURN"
  | "NEXT"
  | "TAGGED"
  | "MENTIONS"
  | "RELATED";

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

export interface KnowledgeIngestSummary {
  documents: number;
  memories: number;
  sessions: number;
  turns: number;
}

export interface KnowledgeIngestOptions {
  kind?: string;
  label?: string;
}

export class KnowledgeGraph {
  readonly nodes = new Map<string, KnowledgeNode>();
  edges: KnowledgeEdge[] = [];

  upsertNode(node: KnowledgeNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: KnowledgeEdge): void {
    if (edge.from === edge.to || !this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    const existing = this.edges.find((item) => item.from === edge.from && item.to === edge.to && item.type === edge.type);
    if (existing) existing.weight = Math.max(existing.weight, edge.weight);
    else this.edges.push(edge);
  }

  connectRelated(): void {
    this.edges = this.edges.filter((edge) => edge.type !== "RELATED");
    const documents = [...this.nodes.values()].filter((node) => !["keyword", "project", "file", "session"].includes(node.type));
    const terms = new Map(documents.map((node) => [node.id, new Set(tokenize(`${node.label} ${node.text}`))]));
    for (let leftIndex = 0; leftIndex < documents.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex += 1) {
        const left = terms.get(documents[leftIndex].id)!;
        const right = terms.get(documents[rightIndex].id)!;
        const overlap = [...left].filter((term) => right.has(term)).length;
        if (overlap === 0) continue;
        this.addEdge({ from: documents[leftIndex].id, to: documents[rightIndex].id, type: "RELATED", weight: overlap });
        this.addEdge({ from: documents[rightIndex].id, to: documents[leftIndex].id, type: "RELATED", weight: overlap });
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
    const existingFile = target.nodes.get(fileID);
    target.upsertNode({
      id: fileID,
      type: "file",
      label: existingFile?.label ?? relative(repo, value.filepath),
      text: existingFile?.text ?? value.filepath,
      path: value.filepath,
      metadata: { ...existingFile?.metadata, project: repo }
    });
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
  removeNodes(graph, stale);

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
    graph.upsertNode({ id: transcriptID, type: "transcript", label: `${label} transcript`, text: transcript, path: transcriptPath, metadata: { sessionID: id, source: "dictator" } });
    graph.addEdge({ from: recordingID, to: transcriptID, type: "HAS_TRANSCRIPT", weight: 1 });
    const keywords = Array.isArray(metadata.keywords) ? metadata.keywords.map(String) : tokenize(transcript).slice(0, 12);
    addTermEdges(graph, recordingID, keywords);
    addTermEdges(graph, transcriptID, keywords);
    count += 1;
  }
  removeOrphanKeywords(graph);
  return count;
}

export async function ingestRepositoryFiles(graph: KnowledgeGraph, repoPath: string, sourceURL?: string): Promise<number> {
  const repo = resolve(repoPath);
  const projectID = `project:${stable(repo)}`;
  graph.upsertNode({ id: projectID, type: "project", label: basename(repo), text: repo, path: repo, metadata: sourceURL ? { sourceURL } : {} });
  const sourceExtensions = new Set([".swift", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp", ".md"]);
  let count = 0;
  for (const path of await walk(repo)) {
    if (!sourceExtensions.has(extname(path).toLowerCase())) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    if (!text.trim()) continue;
    const id = `file:${stable(path)}`;
    graph.upsertNode({ id, type: "file", label: relative(repo, path), text: text.slice(0, 200_000), path, metadata: { project: repo, ...(sourceURL ? { sourceURL } : {}) } });
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
    graph.upsertNode({ id, type: "prompt", label: basename(path), text: text.slice(0, 100_000), path, metadata: { kind: "prompt" } });
    addTermEdges(graph, id, tokenize(text).slice(0, 20));
    count += 1;
  }
  return count;
}

export async function ingestKnowledgePath(
  graph: KnowledgeGraph,
  sourcePath: string,
  options: KnowledgeIngestOptions = {},
): Promise<KnowledgeIngestSummary> {
  const path = resolve(sourcePath);
  const summary: KnowledgeIngestSummary = { documents: 0, memories: 0, sessions: 0, turns: 0 };
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`Source does not exist: ${path}`);
  if (info.isDirectory()) {
    for (const child of await walk(path)) {
      const childSummary = await ingestKnowledgePath(graph, child, options);
      mergeSummary(summary, childSummary);
    }
    return summary;
  }

  const text = await readFile(path, "utf8");
  if (!text.trim()) return summary;
  removeNodesForPath(graph, path, ["document", "memory", "session", "turn"]);

  if (["MEMORY.md", "USER.md"].includes(basename(path))) {
    const target = basename(path) === "USER.md" ? "user" : "memory";
    const entries = text.split(/\n§\n/).map((entry) => entry.trim()).filter(Boolean);
    entries.forEach((entry, index) => {
      const id = `memory:${stable(`${path}:${index}:${entry}`)}`;
      graph.upsertNode({
        id,
        type: "memory",
        label: firstLine(entry, 80),
        text: entry,
        path,
        metadata: { target, source: "hermes", kind: "curated-memory", index },
      });
      addTermEdges(graph, id, tokenize(entry).slice(0, 24));
      summary.memories += 1;
    });
    return summary;
  }

  const records = parseStructuredRecords(text, extname(path).toLowerCase());
  if (records.length > 0) {
    const sessions = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      ingestSessionRecord(graph, records[index], path, index, sessions, summary);
    }
    summary.sessions = sessions.size;
    if (summary.turns > 0) return summary;
  }

  const id = `document:${stable(path)}`;
  graph.upsertNode({
    id,
    type: "document",
    label: options.label?.trim() || basename(path),
    text: text.slice(0, 300_000),
    path,
    metadata: { kind: options.kind ?? "document", source: "import" },
  });
  addTermEdges(graph, id, tokenize(text).slice(0, 30));
  summary.documents = 1;
  return summary;
}

export function browseKnowledge(graph: KnowledgeGraph, type?: KnowledgeNodeType, limit = 50): SearchResult[] {
  return [...graph.nodes.values()]
    .filter((node) => node.type !== "keyword" && (!type || node.type === type))
    .sort((left, right) => {
      const leftDate = nodeDate(left);
      const rightDate = nodeDate(right);
      return rightDate - leftDate || left.label.localeCompare(right.label);
    })
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map((node) => ({ node, score: 0, related: relatedNodes(graph, node.id) }));
}

export function searchKnowledge(graph: KnowledgeGraph, query: string, limit = 20, types?: KnowledgeNodeType[]): SearchResult[] {
  const wanted = [...new Set(tokenize(query))];
  if (wanted.length === 0) return [];
  return [...graph.nodes.values()]
    .filter((node) => node.type !== "keyword" && (!types || types.includes(node.type)))
    .map((node) => {
      const label = tokenize(node.label);
      const body = tokenize(node.text);
      const labelSet = new Set(label);
      const bodySet = new Set(body);
      let score = 0;
      for (const term of wanted) {
        if (labelSet.has(term)) score += 5;
        if (bodySet.has(term)) score += 2;
        if (!labelSet.has(term) && label.some((candidate) => phoneticMatch(term, candidate))) score += 3;
        if (!bodySet.has(term) && body.some((candidate) => phoneticMatch(term, candidate))) score += 1;
      }
      return { node, score, related: relatedNodes(graph, node.id) };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || nodeDate(right.node) - nodeDate(left.node) || left.node.label.localeCompare(right.node.label))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export function excerptFor(text: string, query: string, limit = 700): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  const lower = clean.toLowerCase();
  const wanted = tokenize(query);
  let match = wanted.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? -1;
  if (match < 0) {
    const candidate = tokenize(clean).find((term) => wanted.some((queryTerm) => phoneticMatch(queryTerm, term)));
    if (candidate) match = lower.indexOf(candidate);
  }
  if (match < 0) return clean.slice(0, limit);
  const start = Math.max(0, match - Math.floor(limit / 3));
  const end = Math.min(clean.length, start + limit);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

function ingestSessionRecord(
  graph: KnowledgeGraph,
  raw: unknown,
  path: string,
  recordIndex: number,
  sessions: Set<string>,
  summary: KnowledgeIngestSummary,
): void {
  if (!isRecord(raw)) return;

  if (Array.isArray(raw.messages)) {
    const sessionID = stringValue(raw.id) || stringValue(raw.session_id) || `import-${stable(`${path}:${recordIndex}`)}`;
    const title = stringValue(raw.title) || sessionID;
    const sessionNodeID = upsertSession(graph, sessionID, title, path, raw);
    sessions.add(sessionID);
    let previousTurnID: string | null = null;
    raw.messages.forEach((message, index) => {
      if (!isRecord(message) || stringValue(message.role) === "system") return;
      const turnID = upsertTurn(graph, sessionNodeID, sessionID, message, path, index);
      if (!turnID) return;
      if (previousTurnID) graph.addEdge({ from: previousTurnID, to: turnID, type: "NEXT", weight: 1 });
      previousTurnID = turnID;
      summary.turns += 1;
    });
    return;
  }

  const promptText = stringValue(raw.text);
  const promptSessionID = stringValue(raw.session_id);
  if (promptText && promptSessionID) {
    const sessionNodeID = upsertSession(graph, promptSessionID, promptSessionID, path, raw);
    sessions.add(promptSessionID);
    const message = { ...raw, content: promptText };
    const turnID = upsertTurn(graph, sessionNodeID, promptSessionID, message, path, numberValue(raw.index) ?? recordIndex);
    if (turnID) summary.turns += 1;
    return;
  }

  if (isRecord(raw.message) && ["user", "assistant", "tool"].includes(stringValue(raw.type))) {
    const sessionID = stringValue(raw.session_id) || stringValue(raw.sessionId) || `import-${stable(path)}`;
    const sessionNodeID = upsertSession(graph, sessionID, sessionID, path, raw);
    sessions.add(sessionID);
    const message = { ...raw.message, role: stringValue(raw.message.role) || stringValue(raw.type) };
    const turnID = upsertTurn(graph, sessionNodeID, sessionID, message, path, recordIndex);
    if (turnID) summary.turns += 1;
  }
}

function upsertSession(graph: KnowledgeGraph, sessionID: string, label: string, path: string, metadata: Record<string, unknown>): string {
  const id = `session:${stable(`${path}:${sessionID}`)}`;
  const existing = graph.nodes.get(id);
  graph.upsertNode({
    id,
    type: "session",
    label,
    text: existing?.text ?? "",
    path,
    metadata: {
      sessionID,
      source: stringValue(metadata.source) || "agent-export",
      model: stringValue(metadata.model) || undefined,
      startedAt: metadata.started_at ?? metadata.startedAt ?? metadata.created_at,
      parentSessionID: metadata.parent_session_id ?? metadata.parentSessionID,
      kind: "agent-session",
    },
  });
  return id;
}

function upsertTurn(
  graph: KnowledgeGraph,
  sessionNodeID: string,
  sessionID: string,
  message: Record<string, unknown>,
  path: string,
  index: number,
): string | null {
  const role = stringValue(message.role) || "unknown";
  const text = messageText(message.content);
  if (!text.trim()) return null;
  const messageID = stringValue(message.id) || stringValue(message.message_id) || String(index);
  const id = `turn:${stable(`${path}:${sessionID}:${messageID}:${role}`)}`;
  graph.upsertNode({
    id,
    type: "turn",
    label: `${role} ${index + 1}`,
    text: text.slice(0, 100_000),
    path,
    metadata: {
      sessionID,
      role,
      index,
      messageID,
      timestamp: message.timestamp ?? message.created_at,
      toolName: message.tool_name ?? message.name,
      kind: "agent-turn",
    },
  });
  const session = graph.nodes.get(sessionNodeID);
  if (session && !session.text.includes(text)) session.text = `${session.text}\n${text}`.trim().slice(0, 300_000);
  graph.addEdge({ from: sessionNodeID, to: id, type: "HAS_TURN", weight: 1 });
  addTermEdges(graph, id, tokenize(text).slice(0, 24));
  return id;
}

function parseStructuredRecords(text: string, extension: string): unknown[] {
  if (extension === ".jsonl") {
    const records: unknown[] = [];
    for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      try { records.push(JSON.parse(line)); } catch { return []; }
    }
    return records;
  }
  if (extension === ".json") {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (isRecord(parsed) && Array.isArray(parsed.sessions)) return parsed.sessions;
      return [parsed];
    } catch { return []; }
  }
  return [];
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(messageText).filter(Boolean).join("\n");
  if (isRecord(content)) return stringValue(content.text) || stringValue(content.content) || JSON.stringify(content);
  if (content == null) return "";
  return String(content);
}

function relatedNodes(graph: KnowledgeGraph, id: string): KnowledgeNode[] {
  const ids = graph.edges
    .filter((edge) => edge.from === id && ["RELATED", "CALLS", "HAS_TRANSCRIPT", "HAS_TURN", "NEXT", "CONTAINS"].includes(edge.type))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 5)
    .map((edge) => edge.to);
  return ids.map((relatedID) => graph.nodes.get(relatedID)).filter((item): item is KnowledgeNode => Boolean(item));
}

function addTermEdges(graph: KnowledgeGraph, from: string, values: string[]): void {
  for (const term of [...new Set(values.map(normalize).filter((value) => value.length >= 3))].slice(0, 24)) {
    const id = `keyword:${term}`;
    graph.upsertNode({ id, type: "keyword", label: term, text: term, path: null, metadata: {} });
    graph.addEdge({ from, to: id, type: "TAGGED", weight: 1 });
  }
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .map(normalize)
    .filter((part) => (/^\d+$/.test(part) || part.length >= 3) && !STOP.has(part));
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function phoneticMatch(left: string, right: string): boolean {
  if (left === right || left.length < 5 || right.length < 5) return false;
  const a = phoneticSignature(left);
  const b = phoneticSignature(right);
  return Math.abs(a.length - b.length) <= 1 && editDistanceAtMostOne(a, b);
}

function phoneticSignature(value: string): string {
  return normalize(value)
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/qu/g, "k")
    .replace(/ee/g, "i")
    .replace(/[cq]/g, "k")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) edits += 1;
  return edits <= 1;
}

function removeNodesForPath(graph: KnowledgeGraph, path: string, types: KnowledgeNodeType[]): void {
  const ids = new Set([...graph.nodes.values()]
    .filter((node) => node.path === path && types.includes(node.type))
    .map((node) => node.id));
  removeNodes(graph, ids);
}

function removeNodes(graph: KnowledgeGraph, ids: Set<string>): void {
  for (const id of ids) graph.nodes.delete(id);
  graph.edges = graph.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
}

function removeOrphanKeywords(graph: KnowledgeGraph): void {
  const tagged = new Set(graph.edges.filter((edge) => edge.type === "TAGGED").map((edge) => edge.to));
  for (const node of [...graph.nodes.values()]) {
    if (node.type === "keyword" && !tagged.has(node.id)) graph.nodes.delete(node.id);
  }
}

function mergeSummary(target: KnowledgeIngestSummary, source: KnowledgeIngestSummary): void {
  target.documents += source.documents;
  target.memories += source.memories;
  target.sessions += source.sessions;
  target.turns += source.turns;
}

function firstLine(value: string, limit: number): string {
  return value.split(/\r?\n/)[0].trim().slice(0, limit) || "Untitled memory";
}

function nodeDate(node: KnowledgeNode): number {
  return Date.parse(String(node.metadata.startedAt ?? node.metadata.timestamp ?? "")) || 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
