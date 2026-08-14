import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeGraph,
  browseKnowledge,
  ingestDictatorArchive,
  ingestKnowledgePath,
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

test("function graph merging preserves repository source contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-source-preservation-"));
  const path = join(root, "PasskeyManager.ts");
  const source = "export function verifyPasskey() { return 'WebAuthn assertion'; }";
  await writeFile(path, source);
  const graph = new KnowledgeGraph();
  await ingestRepositoryFiles(graph, root);
  mergeCodeGraph(graph, root, {
    "PasskeyManager.verifyPasskey": { filepath: path, callees: [], lineno: 1, end_lineno: 1 }
  });

  const file = [...graph.nodes.values()].find((node) => node.type === "file" && node.path === path);
  assert.equal(file?.text, source);
  assert.ok(searchKnowledge(graph, "WebAuthn assertion", 10).some((result) => result.node.id === file?.id));
});

test("browser lists source types with newest recordings first", () => {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "recording:old", type: "recording", label: "Old meeting", text: "old", path: "/old.wav", metadata: { startedAt: "2026-01-01T10:00:00Z" } });
  graph.upsertNode({ id: "recording:new", type: "recording", label: "New meeting", text: "new", path: "/new.wav", metadata: { startedAt: "2026-08-14T10:00:00Z" } });
  graph.upsertNode({ id: "file:one", type: "file", label: "Design.swift", text: "code", path: "/Design.swift", metadata: {} });
  graph.upsertNode({ id: "keyword:hidden", type: "keyword", label: "hidden", text: "hidden", path: null, metadata: {} });

  assert.deepEqual(browseKnowledge(graph, "recording", 10).map((result) => result.node.id), ["recording:new", "recording:old"]);
  assert.deepEqual(browseKnowledge(graph, "file", 10).map((result) => result.node.id), ["file:one"]);
  assert.equal(browseKnowledge(graph, undefined, 10).some((result) => result.node.type === "keyword"), false);
});

test("ingests Hermes memory files as separate curated memory entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-hermes-memory-"));
  const memoryPath = join(root, "MEMORY.md");
  await writeFile(memoryPath, "Project uses passkeys.\n§\nUser prefers stable streaming text.\n");
  const graph = new KnowledgeGraph();

  const result = await ingestKnowledgePath(graph, memoryPath);

  assert.equal(result.memories, 2);
  assert.equal([...graph.nodes.values()].filter((node) => node.type === "memory").length, 2);
  assert.ok(searchKnowledge(graph, "passkey", 10).some((item) => item.node.type === "memory"));
});

test("ingests Hermes full-session and prompt-only JSONL with lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-hermes-session-"));
  const exportPath = join(root, "sessions.jsonl");
  await writeFile(exportPath, [
    JSON.stringify({
      id: "session-full",
      title: "Passkey implementation",
      source: "desktop",
      started_at: "2026-08-14T12:00:00Z",
      messages: [
        { id: 1, role: "user", content: "Implement passkey authentication", timestamp: "2026-08-14T12:00:01Z" },
        { id: 2, role: "assistant", content: "Added WebAuthn verification", timestamp: "2026-08-14T12:00:02Z" }
      ]
    }),
    JSON.stringify({ session_id: "session-prompts", index: 1, created_at: "2026-08-14T13:00:00Z", role: "user", text: "Review wallet recovery" })
  ].join("\n") + "\n");
  const graph = new KnowledgeGraph();

  const result = await ingestKnowledgePath(graph, exportPath);

  assert.equal(result.sessions, 2);
  assert.equal(result.turns, 3);
  assert.ok(graph.edges.some((edge) => edge.type === "HAS_TURN"));
  assert.ok(graph.edges.some((edge) => edge.type === "NEXT"));
  assert.ok(searchKnowledge(graph, "WebAuthn", 10).some((item) => item.node.type === "turn"));
});

test("ingests pasted text as a provenance-preserving document", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-paste-"));
  const path = join(root, "dictator-context.txt");
  await writeFile(path, "The Dictator HUD must grow automatically with the live transcript.");
  const graph = new KnowledgeGraph();

  const result = await ingestKnowledgePath(graph, path, { kind: "paste", label: "DICTATOR feedback" });

  assert.equal(result.documents, 1);
  const node = [...graph.nodes.values()].find((item) => item.type === "document");
  assert.equal(node?.label, "DICTATOR feedback");
  assert.equal(node?.path, path);
  assert.equal(node?.metadata.kind, "paste");
});

test("phonetic retrieval connects Whisper PASCII to passkey evidence", () => {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "file:passkey", type: "file", label: "PasskeyManager.swift", text: "Verify passkey WebAuthn assertions.", path: "/repo/PasskeyManager.swift", metadata: {} });

  const results = searchKnowledge(graph, "PASCII authentication", 10);

  assert.ok(results.some((item) => item.node.id === "file:passkey"));
});
