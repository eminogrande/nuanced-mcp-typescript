import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { initPythonGraph } from "../graph/pythonBackend.js";
import { initTsGraph } from "../graph/tsBackend.js";
import { KnowledgeGraph, ingestRepositoryFiles, mergeCodeGraph, removeRepositoryKnowledge } from "./graph.js";

export interface ManagedRepositorySpec {
  slug: string;
  rank: number;
  commits90d: number;
}

export interface ManagedRepositoryEntry {
  slug: string;
  url: string;
  localPath: string;
  defaultBranch: string;
  visibility: string;
  indexedCommit: string;
  files: number;
  functions: number;
  lastCheckedAt: string;
  lastIndexedAt: string | null;
  error: string | null;
}

export interface ManagedRepositoryState {
  version: 1;
  activityWindowDays: 90;
  activityMeasuredAt: string;
  lastRefreshAt: string | null;
  entries: ManagedRepositoryEntry[];
}

export interface ManagedRefreshResult {
  due: boolean;
  checked: number;
  updated: number;
  unchanged: number;
  failed: number;
  entries: ManagedRepositoryEntry[];
}

export const NURI_MANAGED_REPOSITORIES: ManagedRepositorySpec[] = [
  { slug: "nuri-com/nuri-expo", rank: 1, commits90d: 1510 },
  { slug: "nuri-com/nuri-mcp-bitcoin-swapkit", rank: 2, commits90d: 453 },
  { slug: "nuri-com/nuri-swapkit-observatory", rank: 3, commits90d: 231 },
  { slug: "nuri-com/nuri-design-system", rank: 4, commits90d: 210 },
  { slug: "nuri-com/nuri-wirex-mcp", rank: 5, commits90d: 178 },
  { slug: "nuri-com/nuri-server-musig2-v4-arkade", rank: 6, commits90d: 134 },
  { slug: "nuri-com/nuri-agent-ready-website", rank: 7, commits90d: 117 },
  { slug: "nuri-com/nuri-passkey-prf-smartcard", rank: 8, commits90d: 96 },
  { slug: "nuri-com/nuri-phone-hermes", rank: 9, commits90d: 88 },
  { slug: "nuri-com/nuri-monerium", rank: 10, commits90d: 87 },
];

export async function refreshManagedRepositories(options: {
  graphPath: string;
  repositoriesRoot: string;
  statePath: string;
  specs?: ManagedRepositorySpec[];
  force?: boolean;
  maxAgeHours?: number;
}): Promise<ManagedRefreshResult> {
  const specs = options.specs ?? NURI_MANAGED_REPOSITORIES;
  const state = await loadManagedRepositoryState(options.statePath);
  const maxAgeHours = options.maxAgeHours ?? 24;
  const due = options.force === true || !state.lastRefreshAt || Date.now() - Date.parse(state.lastRefreshAt) >= maxAgeHours * 3_600_000;
  if (!due) return { due: false, checked: 0, updated: 0, unchanged: specs.length, failed: 0, entries: state.entries };

  await mkdir(options.repositoriesRoot, { recursive: true });
  let graph = await KnowledgeGraph.load(options.graphPath);
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const spec of specs) {
    const now = new Date().toISOString();
    const url = `https://github.com/${spec.slug}`;
    const localPath = join(options.repositoriesRoot, spec.slug.replace("/", "--"));
    const previous = state.entries.find((entry) => entry.slug === spec.slug);
    let entry: ManagedRepositoryEntry = previous ?? {
      slug: spec.slug,
      url,
      localPath,
      defaultBranch: "",
      visibility: "unknown",
      indexedCommit: "",
      files: 0,
      functions: 0,
      lastCheckedAt: now,
      lastIndexedAt: null,
      error: null,
    };
    try {
      await updateCheckout(spec.slug, localPath);
      const visibility = await repositoryVisibility(spec.slug);
      const defaultBranch = await repositoryDefaultBranch(localPath);
      const commit = (await command("/usr/bin/git", ["-C", localPath, "rev-parse", `origin/${defaultBranch}`])).trim();
      entry = { ...entry, defaultBranch, visibility, lastCheckedAt: now, error: null };
      if (entry.indexedCommit === commit) {
        unchanged += 1;
      } else {
        await command("/usr/bin/git", ["-C", localPath, "checkout", "--force", "-B", defaultBranch, `origin/${defaultBranch}`]);
        const candidate = cloneGraph(graph);
        removeRepositoryKnowledge(candidate, localPath);
        const files = await ingestRepositoryFiles(candidate, localPath, url);
        const language = detectLanguage(localPath);
        let functions = 0;
        if (language === "typescript") {
          const analyzed = await initTsGraph(localPath);
          mergeCodeGraph(candidate, localPath, analyzed.graph);
          functions = Object.keys(analyzed.graph).length;
        } else if (language === "python") {
          const analyzed = await initPythonGraph(localPath);
          mergeCodeGraph(candidate, localPath, analyzed.graph);
          functions = Object.keys(analyzed.graph).length;
        }
        attachRepositoryProvenance(candidate, localPath, url, defaultBranch, commit);
        candidate.connectRelated();
        await candidate.save(options.graphPath);
        graph = candidate;
        entry = { ...entry, indexedCommit: commit, files, functions, lastIndexedAt: now };
        updated += 1;
      }
    } catch (error) {
      entry = { ...entry, lastCheckedAt: now, error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000) };
      failed += 1;
    }
    state.entries = [...state.entries.filter((item) => item.slug !== spec.slug), entry]
      .sort((left, right) => (specs.find((item) => item.slug === left.slug)?.rank ?? 999) - (specs.find((item) => item.slug === right.slug)?.rank ?? 999));
    await writeState(options.statePath, state);
  }

  state.lastRefreshAt = new Date().toISOString();
  await writeState(options.statePath, state);
  return { due: true, checked: specs.length, updated, unchanged, failed, entries: state.entries };
}

export async function loadManagedRepositoryState(path: string): Promise<ManagedRepositoryState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as ManagedRepositoryState;
    if (value.version === 1 && Array.isArray(value.entries)) return value;
  } catch {}
  return { version: 1, activityWindowDays: 90, activityMeasuredAt: "2026-08-14T00:00:00.000Z", lastRefreshAt: null, entries: [] };
}

async function updateCheckout(slug: string, localPath: string): Promise<void> {
  if (!existsSync(join(localPath, ".git"))) {
    await command(githubCLI(), ["repo", "clone", slug, localPath, "--", "--filter=blob:none"]);
  }
  await command("/usr/bin/git", ["-C", localPath, "fetch", "--prune", "--filter=blob:none", "origin"]);
  await command("/usr/bin/git", ["-C", localPath, "remote", "set-head", "origin", "--auto"]);
}

function githubCLI(): string {
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", join(homedir(), ".local/bin/gh")]
    .find(existsSync) ?? "gh";
}

async function repositoryVisibility(slug: string): Promise<string> {
  const output = await command(githubCLI(), ["repo", "view", slug, "--json", "visibility"]);
  const visibility = (JSON.parse(output) as { visibility?: unknown }).visibility;
  return typeof visibility === "string" ? visibility.toLowerCase() : "unknown";
}

async function repositoryDefaultBranch(localPath: string): Promise<string> {
  const reference = (await command("/usr/bin/git", ["-C", localPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
  const branch = reference.replace(/^origin\//, "");
  if (!branch || branch === reference) throw new Error(`Cannot resolve default branch for ${localPath}`);
  return branch;
}

function detectLanguage(repo: string): "typescript" | "python" | "generic" {
  if (existsSync(join(repo, "package.json"))) return "typescript";
  if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "requirements.txt"))) return "python";
  return "generic";
}

function attachRepositoryProvenance(graph: KnowledgeGraph, repoPath: string, url: string, branch: string, commit: string): void {
  const repo = resolve(repoPath);
  for (const node of graph.nodes.values()) {
    if (node.path !== repo && node.metadata.project !== repo) continue;
    node.metadata = {
      ...node.metadata,
      repository: url,
      branch,
      commit,
      relativePath: node.path && node.path !== repo ? node.path.slice(repo.length + 1) : null,
    };
  }
}

function cloneGraph(source: KnowledgeGraph): KnowledgeGraph {
  const graph = new KnowledgeGraph();
  for (const node of source.nodes.values()) graph.upsertNode(structuredClone(node));
  graph.edges = source.edges.map((edge) => structuredClone(edge));
  return graph;
}

async function writeState(path: string, state: ManagedRepositoryState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, path);
}

function command(executable: string, arguments_: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(output) : reject(new Error(error.trim() || `${basename(executable)} exited ${code}`)));
  });
}
