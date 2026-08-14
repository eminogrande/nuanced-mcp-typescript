import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeGraph,
  ingestDictatorArchive,
  ingestPromptDirectory,
  ingestRepositoryFiles,
  mergeCodeGraph,
  searchKnowledge,
} from "../knowledge/graph.js";
import type { Graph } from "../graph/analyzer.js";

test("unified graph connects code, recording, transcript, prompt, and keyword nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-brain-"));
  const archive = join(root, "Dictations");
  const prompts = join(root, "Prompts");
  await mkdir(archive);
  await mkdir(prompts);
  await writeFile(join(archive, "000001_2026-08-13_20-00_wallet-recovery.wav"), "RIFF");
  await writeFile(join(archive, "000001_2026-08-13_20-00_wallet-recovery.txt"), "Wallet recovery uses a backup key.");
  await writeFile(join(archive, "000001_2026-08-13_20-00_wallet-recovery.json"), JSON.stringify({
    sessionID: "000001_2026-08-13_20-00_wallet-recovery",
    sequence: 1,
    startedAt: "2026-08-13T18:00:00.000Z",
    headline: "wallet recovery",
    summary: "Wallet recovery uses a backup key.",
    keywords: ["wallet", "recovery", "backup", "key"],
    audioFilename: "000001_2026-08-13_20-00_wallet-recovery.wav",
    transcriptFilename: "000001_2026-08-13_20-00_wallet-recovery.txt",
    metadataFilename: "000001_2026-08-13_20-00_wallet-recovery.json",
    status: "completed"
  }));
  await writeFile(join(prompts, "wallet.md"), "Design the wallet recovery flow with backup keys.");

  const graph = new KnowledgeGraph();
  await ingestDictatorArchive(graph, archive);
  await ingestPromptDirectory(graph, prompts);
  const code: Graph = {
    "src.wallet.recover": { filepath: join(root, "src/wallet.ts"), callees: [], lineno: 10, end_lineno: 20 }
  };
  mergeCodeGraph(graph, root, code);
  graph.connectRelated();

  const results = searchKnowledge(graph, "wallet recovery", 10);
  assert.ok(results.some((r) => r.node.type === "recording"));
  assert.ok(results.some((r) => r.node.type === "prompt"));
  assert.ok(results.some((r) => r.node.type === "function"));
  assert.ok(graph.edges.some((e) => e.type === "HAS_TRANSCRIPT"));
  assert.ok(graph.edges.some((e) => e.type === "TAGGED"));
  assert.ok(graph.edges.some((e) => e.type === "RELATED"));

  await rm(join(archive, "000001_2026-08-13_20-00_wallet-recovery.json"));
  await ingestDictatorArchive(graph, archive);
  assert.equal([...graph.nodes.values()].filter((node) => node.type === "recording").length, 0);
});

test("graph round-trips through persistent JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-store-"));
  const file = join(root, "knowledge-graph.json");
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "prompt:one", type: "prompt", label: "One", text: "searchable prompt", path: null, metadata: {} });
  await graph.save(file);
  const loaded = await KnowledgeGraph.load(file);
  assert.equal(loaded.nodes.get("prompt:one")?.text, "searchable prompt");
});

test("generic repository ingestion makes Swift preferences searchable", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-swift-"));
  await writeFile(join(root, "DesignSystem.swift"), "let minimumFontSize = 16 // Never use smaller text");
  const graph = new KnowledgeGraph();
  const files = await ingestRepositoryFiles(graph, root);
  graph.connectRelated();
  const results = searchKnowledge(graph, "minimum font size 16", 10);
  assert.equal(files, 1);
  assert.ok(results.some((result) => result.node.type === "file" && result.node.label === "DesignSystem.swift"));
  assert.ok(searchKnowledge(graph, "16", 10).some((result) => result.node.label === "DesignSystem.swift"));
});
