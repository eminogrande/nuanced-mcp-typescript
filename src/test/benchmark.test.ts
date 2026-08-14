import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchmarkMarkdown, loadBenchmarkSuite, runBenchmark, runBenchmarkWithSearch, writeBenchmarkReport, type BenchmarkSuite } from "../benchmark.js";
import { KnowledgeGraph } from "../knowledge/graph.js";

function fixtureGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "memory:wallet", type: "memory", label: "Wallet recovery", text: "Wallet recovery uses a backup key.", path: "/memory.md", metadata: {} });
  graph.upsertNode({ id: "file:design", type: "file", label: "Design system", text: "Minimum font size is 16 pixels. Kleinste Schriftgröße: 16 Pixel.", path: "/Design.swift", metadata: {} });
  graph.upsertNode({ id: "turn:waveform", type: "turn", label: "Waveform decision", text: "The waveform stays above the transcript in a fixed header.", path: "/session.jsonl", metadata: { sessionID: "layout" } });
  graph.upsertNode({ id: "document:architecture", type: "document", label: "Memory architecture", text: "Nuanced Brain is the active external memory provider; no second vector database is used.", path: "/architecture.md", metadata: {} });
  graph.upsertNode({ id: "document:no-aurora-answer", type: "document", label: "Project index", text: "No source contains an approved Project Aurora launch date.", path: "/projects.md", metadata: {} });
  return graph;
}

test("loads and validates the public benchmark fixture", async () => {
  const suite = await loadBenchmarkSuite(resolve("fixtures/benchmark.public.json"));
  assert.equal(suite.cases.length, 5);
});

test("benchmark reports retrieval, fact, forbidden, redundancy, and latency metrics", async () => {
  const suite = await loadBenchmarkSuite(resolve("fixtures/benchmark.public.json"));
  const report = runBenchmark(fixtureGraph(), suite);
  assert.equal(report.metrics.cases, 5);
  assert.ok(report.metrics.recallAt5 >= 0.8);
  assert.ok(report.metrics.meanReciprocalRank > 0);
  assert.ok(report.metrics.factCoverage >= 0.8);
  assert.equal(report.metrics.forbiddenHitRate, 0);
  assert.ok(report.metrics.meanLatencyMs >= 0);
  assert.match(benchmarkMarkdown(report), /Gold-source recall@5/);
});

test("writes machine-readable and Markdown reports", async () => {
  const suite = await loadBenchmarkSuite(resolve("fixtures/benchmark.public.json"));
  const report = runBenchmark(fixtureGraph(), suite);
  const root = await mkdtemp(join(tmpdir(), "nuanced-benchmark-"));
  const path = join(root, "baseline.json");
  await writeBenchmarkReport(report, path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).suite, suite.name);
  assert.match(await readFile(join(root, "baseline.md"), "utf8"), /Baseline metrics/);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("credits a derived result through its exact source provenance", async () => {
  const graph = fixtureGraph();
  graph.upsertNode({
    id: "preference:wallet",
    type: "preference",
    label: "Wallet recovery uses a backup key",
    text: "Wallet recovery uses a backup key.",
    path: "/memory.md",
    metadata: { sourceID: "memory:wallet", sourcePath: "/memory.md", evidence: "Wallet recovery uses a backup key." },
  });
  graph.upsertNode({
    id: "claim:wallet",
    type: "claim",
    label: "Recovery has a backup",
    text: "Recovery has a backup key.",
    path: "/memory.md",
    metadata: { sourceID: "memory:wallet", sourcePath: "/memory.md", evidence: "backup key" },
  });
  const suite: BenchmarkSuite = {
    version: 1,
    name: "Derived provenance",
    createdAt: "2026-08-14T00:00:00.000Z",
    cases: [{
      id: "derived",
      question: "How does recovery work?",
      expectedFacts: ["backup key"],
      goldSourceIDs: ["memory:wallet"],
      goldSourcePaths: [],
      expectedNodeTypes: ["preference"],
      forbiddenClaims: [],
      tags: ["provenance"],
      minimumGoldSources: 1,
    }],
  };
  const report = await runBenchmarkWithSearch(graph, suite, async () => [
    { node: graph.nodes.get("preference:wallet")!, score: 1, related: [] },
    { node: graph.nodes.get("claim:wallet")!, score: 0.9, related: [] },
  ]);
  assert.equal(report.metrics.recallAt1, 1);
  assert.equal(report.metrics.recallAt5, 1);
  assert.equal(report.metrics.goldMinimumPassRate, 1);
});
