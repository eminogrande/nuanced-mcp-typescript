#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  KnowledgeGraph,
  browseKnowledge,
  excerptFor,
  ingestDictatorArchive,
  ingestKnowledgePath,
  ingestPromptDirectory,
  ingestRepositoryFiles,
  mergeCodeGraph,
  searchKnowledge,
} from "./knowledge/graph.js";
import { initPythonGraph } from "./graph/pythonBackend.js";
import { initTsGraph } from "./graph/tsBackend.js";
import { loadBenchmarkSuite, runBenchmark, runBenchmarkWithSearch, writeBenchmarkReport } from "./benchmark.js";
import { buildEmbeddingIndex, hybridSearchKnowledge, loadEmbeddingIndex, OllamaEmbedder } from "./knowledge/embeddings.js";
import { BrainIndexDb, defaultIndexPath } from "./knowledge/indexDb.js";
import { OllamaSemanticExtractor, refreshSemanticKnowledge } from "./knowledge/semantic.js";
import { loadManagedRepositoryState, refreshManagedRepositories } from "./knowledge/managedRepositories.js";

const support = join(homedir(), "Library", "Application Support", "DictateMac");
const graphPath = process.env.NUANCED_KNOWLEDGE_GRAPH ?? join(support, "Brain", "knowledge-graph.json");
const archivePath = process.env.DICTATOR_ARCHIVE ?? join(support, "Dictations");
const brainDirectory = dirname(graphPath);
const repositoriesPath = process.env.NUANCED_REPOSITORIES_ROOT ?? join(brainDirectory, "Repositories");
const managedRepositoriesStatePath = process.env.NUANCED_REPOSITORY_STATE ?? join(brainDirectory, "managed-repositories.json");
const embeddingsPath = process.env.NUANCED_EMBEDDING_INDEX ?? join(dirname(graphPath), "semantic-index.json");
const [command = "ingest", ...args] = process.argv.slice(2);

if (command === "ingest") {
  const graph = await loadFresh();
  let prompts = 0;
  for (const path of args) prompts += await ingestPromptDirectory(graph, resolve(path));
  await save(graph);
  output(graph, { prompts });
} else if (command === "search") {
  const query = args.join(" ");
  await refreshGraphFromArchiveIfNewer();
  const index = new BrainIndexDb(defaultIndexPath(graphPath));
  try {
    index.rebuildIfStale(graphPath);
    const results = index.search(query, 24);
    console.log(JSON.stringify({ query, results }));
  } finally {
    index.close();
  }
} else if (command === "search-slow") {
  const graph = await loadFresh();
  const query = args.join(" ");
  const results = (await hybridSearchKnowledge(
    graph,
    query,
    24,
    await loadEmbeddingIndex(embeddingsPath),
    new OllamaEmbedder(),
  )).map(({ node, score, related }) => ({
    id: node.id, type: node.type, label: node.label, path: node.path, score,
    excerpt: excerptFor(node.text, query, 700),
    related: related.map((item) => ({ id: item.id, type: item.type, label: item.label, path: item.path })),
  }));
  console.log(JSON.stringify({ query, results }));
} else if (command === "stats") {
  const graph = await loadFresh();
  output(graph, {});
} else if (command === "browse") {
  const graph = await loadFresh();
  const rawType = args[0] ?? "all";
  const allowed = new Set(["project", "file", "function", "recording", "transcript", "prompt", "document", "memory", "session", "turn"]);
  if (rawType !== "all" && !allowed.has(rawType)) throw new Error(`Unknown source type: ${rawType}`);
  const limit = Number.parseInt(args[1] ?? "50", 10);
  const results = browseKnowledge(graph, rawType === "all" ? undefined : rawType as Parameters<typeof browseKnowledge>[1], limit).map(({ node, score, related }) => ({
    id: node.id, type: node.type, label: node.label, path: node.path, score,
    excerpt: node.text.slice(0, 700),
    related: related.map((item) => ({ id: item.id, type: item.type, label: item.label, path: item.path })),
  }));
  console.log(JSON.stringify({ query: "", results }));
} else if (command === "visualize") {
  const graph = await loadFresh();
  const hits = searchKnowledge(graph, args.join(" "), 18);
  const ids = new Set(hits.flatMap((hit) => [hit.node.id, ...hit.related.map((node) => node.id)]));
  const nodes = [...ids].map((id) => graph.nodes.get(id)).filter(Boolean).slice(0, 40);
  const visible = new Set(nodes.map((node) => node!.id));
  const edges = graph.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)).slice(0, 100);
  console.log(JSON.stringify({ nodes, edges }));
} else if (command === "import-repo") {
  const source = args[0];
  if (!source) throw new Error("GitHub URL or local repository path required");
  await mkdir(repositoriesPath, { recursive: true });
  const repo = await checkout(source);
  const graph = await loadFresh();
  const files = await ingestRepositoryFiles(graph, repo, existsSync(source) ? undefined : source);
  let functions = 0;
  const language = detectLanguage(repo);
  if (language === "typescript") {
    const result = await initTsGraph(repo);
    mergeCodeGraph(graph, repo, result.graph);
    functions = Object.keys(result.graph).length;
  } else if (language === "python") {
    const result = await initPythonGraph(repo);
    mergeCodeGraph(graph, repo, result.graph);
    functions = Object.keys(result.graph).length;
  }
  await save(graph);
  output(graph, { repository: repo, language, files, functions });
} else if (command === "benchmark") {
  const casesPath = args[0];
  const reportPath = args[1];
  if (!casesPath || !reportPath) throw new Error("Benchmark cases and report paths required");
  const graph = await KnowledgeGraph.load(graphPath);
  const suite = await loadBenchmarkSuite(resolve(casesPath));
  const report = runBenchmark(graph, suite);
  await writeBenchmarkReport(report, resolve(reportPath));
  console.log(JSON.stringify({ report: resolve(reportPath), metrics: report.metrics }));
} else if (command === "benchmark-hybrid") {
  const casesPath = args[0];
  const reportPath = args[1];
  if (!casesPath || !reportPath) throw new Error("Benchmark cases and report paths required");
  const graph = await KnowledgeGraph.load(graphPath);
  const index = await loadEmbeddingIndex(embeddingsPath);
  if (!index) throw new Error("No semantic embedding index; run embedding-refresh first");
  const embedder = new OllamaEmbedder(index.model);
  const suite = await loadBenchmarkSuite(resolve(casesPath));
  const report = await runBenchmarkWithSearch(
    graph,
    suite,
    (query, limit) => hybridSearchKnowledge(graph, query, limit, index, embedder),
  );
  await writeBenchmarkReport(report, resolve(reportPath));
  console.log(JSON.stringify({ report: resolve(reportPath), model: index.model, metrics: report.metrics }));
} else if (command === "semantic-refresh") {
  const graph = await loadFresh();
  const maxSources = args[0] ? Number.parseInt(args[0], 10) : undefined;
  if (maxSources !== undefined && (!Number.isFinite(maxSources) || maxSources < 1)) throw new Error("max-sources must be a positive integer");
  const semantic = await refreshSemanticKnowledge(graph, new OllamaSemanticExtractor(), { maxSources });
  await save(graph);
  output(graph, { semantic });
} else if (command === "embedding-refresh") {
  const graph = await KnowledgeGraph.load(graphPath);
  const embedder = new OllamaEmbedder();
  const embeddings = await buildEmbeddingIndex(graph, embeddingsPath, embedder);
  output(graph, { embeddingsPath, embeddingModel: embedder.model, embeddings });
} else if (command === "managed-repos-refresh") {
  const force = args.includes("--force");
  const repositories = await refreshManagedRepositories({
    graphPath,
    repositoriesRoot: repositoriesPath,
    statePath: managedRepositoriesStatePath,
    force,
  });
  console.log(JSON.stringify({ repositories, embeddings: null, embeddingError: null }));
} else if (command === "hermes-sync") {
  const graph = await loadFresh();
  const imported = { documents: 0, memories: 0, sessions: 0, turns: 0 };
  const memoryRoot = join(homedir(), ".hermes", "memories");
  for (const name of ["MEMORY.md", "USER.md"]) {
    const source = join(memoryRoot, name);
    if (existsSync(source)) mergeImport(imported, await ingestKnowledgePath(graph, source));
  }
  const sessions = join(brainDirectory, "AgentSessions");
  if (existsSync(sessions)) mergeImport(imported, await ingestKnowledgePath(graph, sessions));
  await save(graph);
  output(graph, { imported });
} else if (command === "managed-repos-status") {
  console.log(JSON.stringify(await loadManagedRepositoryState(managedRepositoriesStatePath)));
} else if (command === "ingest-file") {
  const source = args[0];
  if (!source) throw new Error("File or directory path required");
  const kind = args[1];
  const label = args.slice(2).join(" ") || undefined;
  const graph = await loadFresh();
  const imported = await ingestKnowledgePath(graph, source, { kind, label });
  await save(graph);
  output(graph, { source: resolve(source), imported });
} else {
  throw new Error("Usage: brain-cli ingest [prompt-dir ...] | ingest-file <path> [kind] [label] | search <query> | browse <type|all> [limit] | stats | visualize <query> | import-repo <github-url> | hermes-sync | managed-repos-refresh [--force] | managed-repos-status | semantic-refresh [max-sources] | embedding-refresh | benchmark <cases.json> <report.json> | benchmark-hybrid <cases.json> <report.json>");
}

async function loadFresh(): Promise<KnowledgeGraph> {
  const graph = await KnowledgeGraph.load(graphPath);
  await ingestDictatorArchive(graph, archivePath);
  return graph;
}

async function refreshGraphFromArchiveIfNewer(): Promise<void> {
  const graphStat = await stat(graphPath).catch(() => undefined);
  const archiveStat = await stat(archivePath).catch(() => undefined);
  if (!archiveStat || (graphStat && archiveStat.mtimeMs <= graphStat.mtimeMs)) return;
  const graph = await loadFresh();
  await save(graph);
}

async function save(graph: KnowledgeGraph): Promise<void> {
  graph.connectRelated();
  await graph.save(graphPath);
}

function mergeImport(target: { documents: number; memories: number; sessions: number; turns: number }, extra: { documents: number; memories: number; sessions: number; turns: number }): void {
  target.documents += extra.documents;
  target.memories += extra.memories;
  target.sessions += extra.sessions;
  target.turns += extra.turns;
}

function output(graph: KnowledgeGraph, extra: Record<string, unknown>): void {
  const nodeTypes: Record<string, number> = {};
  for (const node of graph.nodes.values()) nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
  console.log(JSON.stringify({ graphPath, nodes: graph.nodes.size, edges: graph.edges.length, nodeTypes, ...extra }));
}

async function checkout(source: string): Promise<string> {
  if (existsSync(source)) return resolve(source);
  const slug = basename(source.replace(/\.git$/, "")).replace(/[^a-zA-Z0-9._-]/g, "-");
  const destination = join(repositoriesPath, slug);
  if (existsSync(destination)) await run("/usr/bin/git", ["-C", destination, "pull", "--ff-only"]);
  else await run("/usr/bin/git", ["clone", "--depth", "1", source, destination]);
  return destination;
}

function detectLanguage(repo: string): "typescript" | "python" | "generic" {
  if (existsSync(join(repo, "package.json"))) return "typescript";
  if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "requirements.txt"))) return "python";
  return "generic";
}

function run(executable: string, arguments_: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(error || `${executable} exited ${code}`)));
  });
}
