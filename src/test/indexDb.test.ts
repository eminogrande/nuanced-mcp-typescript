import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainIndexDb } from "../knowledge/indexDb.js";

function makeGraphFile(dir: string): string {
  const path = join(dir, "knowledge-graph.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    nodes: [
      { id: "decision:1", type: "decision", label: "Use Fn+R for meeting toggle", text: "We decided that Fn+R toggles a latched meeting recording instead of holding Fn.", path: "/notes/decision.md", metadata: {} },
      { id: "memory:1", type: "memory", label: "Nuri wallet types", text: "Nuri 3 wallet types: Onchain Single; Onchain 2-of-2 MuSig2+CSV; Arkade 2-of-2-of-3.", path: "/mem/MEMORY.md", metadata: {} },
      { id: "transcript:1", type: "transcript", label: "meeting recording discussion", text: "How do we handle meeting recording with microphone and Mac audio?", path: "/dict/1.txt", metadata: {} },
      { id: "function:1", type: "function", label: "resolveLightningBounds", text: "export function resolveLightningBounds(corridor) { return corridor; }", path: "/repo/lib/lightningLimits.ts", metadata: {} },
      { id: "keyword:1", type: "keyword", label: "ignored keyword", text: "must never be indexed", path: null, metadata: {} },
    ],
    edges: [
      { from: "transcript:1", to: "memory:1", type: "MENTIONS", weight: 1 },
    ],
  }), { mode: 0o600 });
  return path;
}

test("index rebuilds once, then serves fast trigram queries", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-index-"));
  const graphPath = makeGraphFile(dir);
  const index = new BrainIndexDb(join(dir, "index.sqlite"));
  try {
    const first = index.rebuildIfStale(graphPath);
    assert.equal(first.rebuilt, true);
    assert.equal(first.nodes, 4, "keyword nodes must be excluded");

    const second = index.rebuildIfStale(graphPath);
    assert.equal(second.rebuilt, false, "unchanged graph must not rebuild");

    const hits = index.search("MuSig2 wallet");
    assert.ok(hits.length > 0);
    assert.equal(hits[0].id, "memory:1");
    assert.ok(hits[0].excerpt.includes("MuSig2"));

    const meeting = index.search("meeting recording");
    assert.ok(meeting.some((hit) => hit.id === "transcript:1"));

    const typed = index.search("wallet", 10, ["decision"]);
    assert.ok(typed.every((hit) => hit.type === "decision"));

    assert.ok(!index.search("ignored keyword").some((hit) => hit.id === "keyword:1"));
  } finally {
    index.close();
  }
});

test("index rebuilds again when the graph file changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-index-"));
  const graphPath = makeGraphFile(dir);
  const index = new BrainIndexDb(join(dir, "index.sqlite"));
  try {
    index.rebuildIfStale(graphPath);
    const parsed = JSON.parse(readFileSync(graphPath, "utf8"));
    parsed.nodes.push({ id: "decision:2", type: "decision", label: "SQLite beats JSON scan", text: "Decision: replace per-query JSON scan with SQLite FTS5.", path: null, metadata: {} });
    writeFileSync(graphPath, JSON.stringify(parsed), { mode: 0o600 });
    const rebuild = index.rebuildIfStale(graphPath);
    assert.equal(rebuild.rebuilt, true);
    assert.equal(rebuild.nodes, 5);
    assert.ok(index.search("SQLite beats JSON").some((hit) => hit.id === "decision:2"));
  } finally {
    index.close();
  }
});
