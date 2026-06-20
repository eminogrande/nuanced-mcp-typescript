// Python backend: produces a `Graph` by shelling out to the `nuanced` Python
// library via `uv run`. We do NOT keep a persistent Python process; one shot
// per init. The library's `init`/`enrich` API is pure dict manipulation, so we
// only need the raw graph JSON and do traversal in TS.

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Graph } from "./analyzer.js";

const NUANCED_GRAPH_DIR = ".nuanced";
const NUANCED_GRAPH_FILE = "nuanced-graph.json";

export interface PythonBackendOptions {
  uvPath?: string; // override `uv` binary
  pythonPath?: string; // override python interpreter (uses uv by default)
  timeoutSeconds?: number;
}

// Runs `CodeGraph.init(repoPath)` in Python and returns the produced graph.
// Uses `uv run --with nuanced --with typing_extensions` so the user does not
// need a venv; the `nuanced` CLI is currently broken upstream, so we go via the
// library API directly.
export async function initPythonGraph(repoPath: string, opts: PythonBackendOptions = {}): Promise<{ graph: Graph; errors: string[] }> {
  const errors: string[] = [];
  const timeout = (opts.timeoutSeconds ?? 60) * 1000;

  const script = buildInitScript(repoPath);

  const result = await runUv(script, opts, timeout);
  if (result.exitCode !== 0) {
    errors.push(`nuanced init failed (exit ${result.exitCode}): ${result.stderr}`);
    return { graph: {}, errors };
  }

  // The script writes the graph JSON to <repo>/.nuanced/nuanced-graph.json
  const graphFile = join(repoPath, NUANCED_GRAPH_DIR, NUANCED_GRAPH_FILE);
  if (!existsSync(graphFile)) {
    errors.push(`nuanced produced no graph file at ${graphFile}`);
    if (result.stdout) errors.push(`stdout: ${result.stdout}`);
    return { graph: {}, errors };
  }

  try {
    const raw = await readFile(graphFile, "utf8");
    const graph = JSON.parse(raw) as Graph;
    return { graph, errors };
  } catch (e) {
    errors.push(`Failed to parse graph file: ${(e as Error).message}`);
    return { graph: {}, errors };
  }
}

// One-shot uv run of a Python snippet. Returns combined stdout/stderr.
function runUv(script: string, opts: PythonBackendOptions, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cmd = opts.uvPath ?? "uv";
    const args = ["run", "--with", "nuanced", "--with", "typing_extensions", "python3", "-c", script];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + "\n[timed out]", exitCode: 124 });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: 1 });
    });
  });
}

function buildInitScript(repoPath: string): string {
  // JSON-escape the path into Python.
  const pyPath = JSON.stringify(repoPath);
  return `
import json, sys, os
sys.path.insert(0, os.getcwd())
try:
    from nuanced import CodeGraph
except Exception as e:
    print("IMPORT_ERROR:" + str(e), file=sys.stderr)
    sys.exit(2)
try:
    result = CodeGraph.init(${pyPath})
    if result.errors:
        for e in result.errors:
            print("ERROR:" + str(e), file=sys.stderr)
    cg = result.code_graph
    if cg is None:
        print("NO_GRAPH", file=sys.stderr)
        sys.exit(3)
    out = os.path.join(${pyPath}, ".nuanced", "nuanced-graph.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(cg.graph, f)
    print("OK " + out)
except Exception as e:
    print("EXC:" + str(e), file=sys.stderr)
    sys.exit(4)
`;
}

// ponytail: no persistent Python worker. Each init is a fresh `uv run` (~1s).
// Upgrade path: keep a long-lived python -u process speaking JSON-lines if
// init latency becomes a problem for multi-repo workflows.
export async function cleanupPythonGraph(repoPath: string): Promise<void> {
  const dir = join(repoPath, NUANCED_GRAPH_DIR);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
