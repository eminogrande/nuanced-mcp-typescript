import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchmarkMarkdown, loadBenchmarkSuite, runBenchmark, writeBenchmarkReport } from "../benchmark.js";
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
});
