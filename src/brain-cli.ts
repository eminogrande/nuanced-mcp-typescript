#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  KnowledgeGraph,
  ingestDictatorArchive,
  ingestPromptDirectory,
  ingestRepositoryFiles,
  mergeCodeGraph,
  searchKnowledge,
} from "./knowledge/graph.js";
import { initPythonGraph } from "./graph/pythonBackend.js";
import { initTsGraph } from "./graph/tsBackend.js";

const support = join(homedir(), "Library", "Application Support", "DictateMac");
const graphPath = process.env.NUANCED_KNOWLEDGE_GRAPH ?? join(support, "Brain", "knowledge-graph.json");
const archivePath = process.env.DICTATOR_ARCHIVE ?? join(support, "Dictations");
const repositoriesPath = join(support, "Brain", "Repositories");
const [command = "ingest", ...args] = process.argv.slice(2);

if (command === "ingest") {
  const graph = await loadFresh();
  let prompts = 0;
  for (const path of args) prompts += await ingestPromptDirectory(graph, resolve(path));
  await save(graph);
  output(graph, { prompts });
} else if (command === "search") {
  const graph = await loadFresh();
  await save(graph);
  const results = searchKnowledge(graph, args.join(" "), 24).map(({ node, score, related }) => ({
    id: node.id, type: node.type, label: node.label, path: node.path, score,
    excerpt: node.text.slice(0, 700),
    related: related.map((item) => ({ id: item.id, type: item.type, label: item.label, path: item.path })),
  }));
  console.log(JSON.stringify({ query: args.join(" "), results }));
} else if (command === "stats") {
  const graph = await loadFresh();
  await save(graph);
  output(graph, {});
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
  const files = await ingestRepositoryFiles(graph, repo);
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
} else {
  throw new Error("Usage: brain-cli ingest [prompt-dir ...] | search <query> | stats | visualize <query> | import-repo <github-url>");
}

async function loadFresh(): Promise<KnowledgeGraph> {
  const graph = await KnowledgeGraph.load(graphPath);
  await ingestDictatorArchive(graph, archivePath);
  return graph;
}

async function save(graph: KnowledgeGraph): Promise<void> {
  graph.connectRelated();
  await graph.save(graphPath);
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
