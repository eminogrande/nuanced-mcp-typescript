import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { KnowledgeGraph, searchKnowledge, type SearchResult } from "./knowledge/graph.js";

const CaseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  expectedFacts: z.array(z.string().min(1)).default([]),
  goldSourceIDs: z.array(z.string().min(1)).default([]),
  goldSourcePaths: z.array(z.string().min(1)).default([]),
  expectedNodeTypes: z.array(z.string().min(1)).default([]),
  forbiddenClaims: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).min(1),
  minimumGoldSources: z.number().int().min(1).default(1),
}).superRefine((value, context) => {
  if (value.goldSourceIDs.length + value.goldSourcePaths.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one gold source ID or path is required" });
  }
  if (value.minimumGoldSources > value.goldSourceIDs.length + value.goldSourcePaths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "minimumGoldSources exceeds the gold source count" });
  }
});

const SuiteSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  cases: z.array(CaseSchema).min(1),
});

export type BenchmarkCase = z.infer<typeof CaseSchema>;
export type BenchmarkSuite = z.infer<typeof SuiteSchema>;

export interface BenchmarkCaseReport {
  id: string;
  question: string;
  tags: string[];
  retrieved: Array<{ id: string; type: string; path: string | null; score: number }>;
  goldSources: number;
  goldFoundAt1: number;
  goldFoundAt5: number;
  recallAt1: number;
  recallAt5: number;
  reciprocalRank: number;
  factCoverage: number;
  forbiddenHitRate: number;
  redundancyRate: number;
  latencyMs: number;
  passesGoldMinimum: boolean;
}

export interface BenchmarkReport {
  version: 1;
  suite: string;
  graph: { nodes: number; edges: number };
  generatedAt: string;
  metrics: {
    cases: number;
    recallAt1: number;
    recallAt5: number;
    meanReciprocalRank: number;
    factCoverage: number;
    forbiddenHitRate: number;
    redundancyRate: number;
    meanLatencyMs: number;
    goldMinimumPassRate: number;
  };
  byTag: Record<string, { cases: number; recallAt5: number; meanReciprocalRank: number; factCoverage: number }>;
  cases: BenchmarkCaseReport[];
}

export async function loadBenchmarkSuite(path: string): Promise<BenchmarkSuite> {
  return SuiteSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function runBenchmark(graph: KnowledgeGraph, suite: BenchmarkSuite): BenchmarkReport {
  const cases = suite.cases.map((item) => runCase(graph, item));
  const metrics = summarize(cases);
  const tags = [...new Set(cases.flatMap((item) => item.tags))].sort();
  const byTag = Object.fromEntries(tags.map((tag) => {
    const matching = cases.filter((item) => item.tags.includes(tag));
    const summary = summarize(matching);
    return [tag, {
      cases: matching.length,
      recallAt5: summary.recallAt5,
      meanReciprocalRank: summary.meanReciprocalRank,
      factCoverage: summary.factCoverage,
    }];
  }));
  return {
    version: 1,
    suite: suite.name,
    graph: { nodes: graph.nodes.size, edges: graph.edges.length },
    generatedAt: new Date().toISOString(),
    metrics,
    byTag,
    cases,
  };
}

export async function runBenchmarkWithSearch(
  graph: KnowledgeGraph,
  suite: BenchmarkSuite,
  search: (query: string, limit: number) => Promise<SearchResult[]>,
): Promise<BenchmarkReport> {
  const cases: BenchmarkCaseReport[] = [];
  for (const item of suite.cases) {
    const start = performance.now();
    const results = await search(item.question, 5);
    cases.push(evaluateCase(item, results, performance.now() - start));
  }
  const metrics = summarize(cases);
  const tags = [...new Set(cases.flatMap((item) => item.tags))].sort();
  const byTag = Object.fromEntries(tags.map((tag) => {
    const matching = cases.filter((item) => item.tags.includes(tag));
    const summary = summarize(matching);
    return [tag, {
      cases: matching.length,
      recallAt5: summary.recallAt5,
      meanReciprocalRank: summary.meanReciprocalRank,
      factCoverage: summary.factCoverage,
    }];
  }));
  return {
    version: 1,
    suite: suite.name,
    graph: { nodes: graph.nodes.size, edges: graph.edges.length },
    generatedAt: new Date().toISOString(),
    metrics,
    byTag,
    cases,
  };
}

export async function writeBenchmarkReport(report: BenchmarkReport, jsonPath: string): Promise<void> {
  await mkdir(dirname(jsonPath), { recursive: true });
  const markdownPath = jsonPath.replace(/\.json$/i, "") + ".md";
  await privateAtomicWrite(jsonPath, JSON.stringify(report, null, 2) + "\n");
  await privateAtomicWrite(markdownPath, benchmarkMarkdown(report));
}

async function privateAtomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export function benchmarkMarkdown(report: BenchmarkReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `# ${report.suite}`,
    "",
    `Generated: ${report.generatedAt}`,
    `Graph: ${report.graph.nodes} nodes · ${report.graph.edges} edges`,
    "",
    "## Baseline metrics",
    "",
    `- Cases: ${report.metrics.cases}`,
    `- Gold-source recall@1: ${percent(report.metrics.recallAt1)}`,
    `- Gold-source recall@5: ${percent(report.metrics.recallAt5)}`,
    `- Mean reciprocal rank: ${report.metrics.meanReciprocalRank.toFixed(3)}`,
    `- Expected-fact coverage: ${percent(report.metrics.factCoverage)}`,
    `- Forbidden-hit rate: ${percent(report.metrics.forbiddenHitRate)}`,
    `- Result redundancy: ${percent(report.metrics.redundancyRate)}`,
    `- Mean latency: ${report.metrics.meanLatencyMs.toFixed(2)} ms`,
    `- Gold-minimum pass rate: ${percent(report.metrics.goldMinimumPassRate)}`,
    "",
    "## Cases",
    "",
    "| Case | Recall@5 | MRR | Facts | Gold minimum |",
    "|---|---:|---:|---:|:---:|",
    ...report.cases.map((item) => `| ${item.id} | ${percent(item.recallAt5)} | ${item.reciprocalRank.toFixed(3)} | ${percent(item.factCoverage)} | ${item.passesGoldMinimum ? "yes" : "no"} |`),
    "",
  ];
  return lines.join("\n");
}

function runCase(graph: KnowledgeGraph, item: BenchmarkCase): BenchmarkCaseReport {
  const start = performance.now();
  const results = searchKnowledge(graph, item.question, 5);
  return evaluateCase(item, results, performance.now() - start);
}

function evaluateCase(item: BenchmarkCase, results: SearchResult[], latencyMs: number): BenchmarkCaseReport {
  const gold = new Set([
    ...item.goldSourceIDs.map((value) => `id:${value}`),
    ...item.goldSourcePaths.map((value) => `path:${normalizePath(value)}`),
  ]);
  const matchingGold = (node: { id: string; path: string | null; metadata: Record<string, unknown> }): string[] => {
    const sourceID = typeof node.metadata.sourceID === "string" ? node.metadata.sourceID : null;
    const sourcePath = typeof node.metadata.sourcePath === "string" ? node.metadata.sourcePath : null;
    return [
      `id:${node.id}`,
      sourceID ? `id:${sourceID}` : null,
      node.path ? `path:${normalizePath(node.path)}` : null,
      sourcePath ? `path:${normalizePath(sourcePath)}` : null,
    ].filter((key): key is string => Boolean(key && gold.has(key)));
  };
  const foundAt1 = new Set(results.slice(0, 1).flatMap(({ node }) => matchingGold(node))).size;
  const foundAt5 = new Set(results.flatMap(({ node }) => matchingGold(node))).size;
  const firstGold = results.findIndex(({ node }) => matchingGold(node).length > 0);
  const combined = normalize(results.map(({ node }) => `${node.label}\n${node.text}`).join("\n"));
  const factHits = item.expectedFacts.filter((fact) => combined.includes(normalize(fact))).length;
  const forbiddenHits = item.forbiddenClaims.filter((claim) => combined.includes(normalize(claim))).length;
  const families = results.map(({ node }) => sourceFamily(node.id, node.path, node.metadata));
  return {
    id: item.id,
    question: item.question,
    tags: item.tags,
    retrieved: results.map(({ node, score }) => ({ id: node.id, type: node.type, path: node.path, score })),
    goldSources: gold.size,
    goldFoundAt1: foundAt1,
    goldFoundAt5: foundAt5,
    recallAt1: ratio(foundAt1, gold.size),
    recallAt5: ratio(foundAt5, gold.size),
    reciprocalRank: firstGold < 0 ? 0 : 1 / (firstGold + 1),
    factCoverage: ratio(factHits, item.expectedFacts.length),
    forbiddenHitRate: ratio(forbiddenHits, item.forbiddenClaims.length),
    redundancyRate: families.length === 0 ? 0 : 1 - new Set(families).size / families.length,
    latencyMs,
    passesGoldMinimum: foundAt5 >= item.minimumGoldSources,
  };
}

function summarize(cases: BenchmarkCaseReport[]): BenchmarkReport["metrics"] {
  const mean = (values: number[]) => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    cases: cases.length,
    recallAt1: mean(cases.map((item) => item.recallAt1)),
    recallAt5: mean(cases.map((item) => item.recallAt5)),
    meanReciprocalRank: mean(cases.map((item) => item.reciprocalRank)),
    factCoverage: mean(cases.map((item) => item.factCoverage)),
    forbiddenHitRate: mean(cases.map((item) => item.forbiddenHitRate)),
    redundancyRate: mean(cases.map((item) => item.redundancyRate)),
    meanLatencyMs: mean(cases.map((item) => item.latencyMs)),
    goldMinimumPassRate: mean(cases.map((item) => item.passesGoldMinimum ? 1 : 0)),
  };
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizePath(value: string): string {
  return value.replace(/^~(?=\/)/, process.env.HOME ?? "~").replace(/\/$/, "");
}

function sourceFamily(id: string, path: string | null, metadata: Record<string, unknown>): string {
  const session = metadata.sessionID ?? metadata.session_id;
  if (typeof session === "string" && session) return `session:${session}`;
  if (id.startsWith("recording:") || id.startsWith("transcript:")) return id.replace(/^(recording|transcript):/, "dictation:");
  return path ? normalizePath(path).replace(/\.[^.\/]+$/, "") : id;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}
