// Shared graph data model. Mirrors the `nuanced` Python graph format:
//   { "dotted.path.fn": { filepath, callees: [...], lineno, end_lineno } }
// Both the Python backend (loads JSON from `nuanced`) and the TS/JS backend
// (builds the graph with ts-morph) emit this shape.

import { resolve } from "node:path";

export interface GraphNode {
  filepath: string;
  callees: string[];
  lineno?: number | null;
  end_lineno?: number | null;
}

export type Graph = Record<string, GraphNode>;

export interface EnrichmentResult {
  errors: string[];
  result: Graph | null;
}

const BUILTIN_PREFIX = "_"; // nuanced marks builtins with a leading underscore path

export function enrich(graph: Graph, filePath: string, functionName: string): EnrichmentResult {
  const abs = resolveAbs(filePath);
  const entrypointKeys = Object.keys(graph).filter(
    (k) => graph[k].filepath === abs && k.endsWith("." + functionName),
  );

  if (entrypointKeys.length > 1) {
    return {
      errors: [`Multiple definitions for ${functionName} found in ${filePath}: ${entrypointKeys.join(", ")}`],
      result: null,
    };
  }
  if (entrypointKeys.length === 0) {
    return { errors: [], result: null };
  }

  // BFS subgraph build: entrypoint + transitive callees present in graph.
  const subgraph: Graph = {};
  const visited = new Set<string>();
  const entryKey = entrypointKeys[0];
  const entryNode = graph[entryKey];
  if (!entryNode) return { errors: [], result: null };

  subgraph[entryKey] = entryNode;
  visited.add(entryKey);
  const queue = [...stripBuiltins(entryNode.callees)];

  while (queue.length > 0) {
    const callee = queue.shift()!;
    if (visited.has(callee)) continue;
    visited.add(callee);
    const node = graph[callee];
    if (!node) continue;
    subgraph[callee] = node;
    queue.push(...stripBuiltins(node.callees));
  }

  return { errors: [], result: subgraph };
}

function stripBuiltins(callees: string[]): string[] {
  return (callees ?? []).filter((c) => !c.startsWith(BUILTIN_PREFIX));
}

// Find all functions whose callees intersect target nodes (i.e. callers of targets).
export function findDependents(graph: Graph, targetKeys: string[]): Map<string, string[]> {
  const targetSet = new Set(targetKeys);
  const dependents = new Map<string, string[]>();
  for (const [key, node] of Object.entries(graph)) {
    if ((node.callees ?? []).some((c) => targetSet.has(c))) {
      const fn = key.split(".").pop()!;
      const list = dependents.get(node.filepath) ?? [];
      if (!list.includes(fn)) list.push(fn);
      dependents.set(node.filepath, list);
    }
  }
  return dependents;
}

export function findDirectCallers(graph: Graph, entryKey: string): Array<{ key: string; node: GraphNode }> {
  const out: Array<{ key: string; node: GraphNode }> = [];
  for (const [key, node] of Object.entries(graph)) {
    if (key === entryKey) continue;
    if ((node.callees ?? []).includes(entryKey)) out.push({ key, node });
  }
  return out;
}

// BFS indirect callers up to maxDepth (returns depth-tagged callers, excluding direct ones).
export function findIndirectCallers(
  graph: Graph,
  startKeys: string[],
  maxDepth = 3,
): Array<{ key: string; node: GraphNode; depth: number }> {
  const visited = new Set(startKeys);
  const queue: Array<{ key: string; depth: number }> = startKeys.map((k) => ({ key: k, depth: 1 }));
  const results: Array<{ key: string; node: GraphNode; depth: number }> = [];

  while (queue.length > 0) {
    const { key: current, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    for (const [k, node] of Object.entries(graph)) {
      if (visited.has(k)) continue;
      if ((node.callees ?? []).includes(current)) {
        visited.add(k);
        queue.push({ key: k, depth: depth + 1 });
        results.push({ key: k, node, depth });
      }
    }
  }
  return results;
}

function resolveAbs(p: string): string {
  return resolve(p);
}
