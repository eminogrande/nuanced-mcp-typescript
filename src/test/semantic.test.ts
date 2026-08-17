import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeGraph } from "../knowledge/graph.js";
import { refreshSemanticKnowledge, type SemanticExtractor } from "../knowledge/semantic.js";
import { buildEmbeddingIndex, hybridSearchKnowledge, loadEmbeddingIndex, type Embedder } from "../knowledge/embeddings.js";

class FixedExtractor implements SemanticExtractor {
  readonly model = "test-extractor";
  calls = 0;
  async extract() {
    this.calls += 1;
    return {
      items: [{
        kind: "preference" as const,
        statement: "Emin requires a minimum font size of 16 pixels.",
        evidence: "minimum font size is 16 pixels",
        entities: [{ name: "Emin", kind: "person" }, { name: "DICTATOR", kind: "project" }],
        subject: "Emin",
        predicate: "requires",
        object: "minimum font size of 16 pixels",
        timestamp: "",
        confidence: 0.98,
      }],
    };
  }
}

class HallucinatingExtractor implements SemanticExtractor {
  readonly model = "hallucinating-test";
  async extract() {
    return { items: [{ kind: "claim" as const, statement: "Unsupported", evidence: "not in source", entities: [], subject: "", predicate: "", object: "", timestamp: "", confidence: 0.9 }] };
  }
}

class FailingExtractor implements SemanticExtractor {
  readonly model = "failing-test";
  async extract(): Promise<never> {
    throw new Error("model unavailable");
  }
}

class SemanticTestEmbedder implements Embedder {
  readonly model = "test-embedding";
  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((input) => /typography|schrift|font/i.test(input) ? [1, 0, 0] : [0, 1, 0]);
  }
}

test("semantic extraction creates source-backed typed nodes and stable entities", async () => {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "memory:design", type: "memory", label: "Design preference", text: "The minimum font size is 16 pixels in DICTATOR.", path: "/MEMORY.md", metadata: {} });
  const extractor = new FixedExtractor();

  const first = await refreshSemanticKnowledge(graph, extractor);
  const preference = [...graph.nodes.values()].find((node) => node.type === "preference");
  assert.equal(first.derived, 1);
  assert.equal(first.entities, 2);
  assert.equal(preference?.metadata.evidence, "minimum font size is 16 pixels");
  assert.equal(preference?.metadata.sourceID, "memory:design");
  assert.ok(graph.edges.some((edge) => edge.type === "DERIVED_FROM" && edge.from === preference?.id && edge.to === "memory:design"));
  assert.equal([...graph.nodes.values()].filter((node) => node.type === "entity").length, 2);

  const second = await refreshSemanticKnowledge(graph, extractor);
  assert.equal(second.skipped, 1);
  assert.equal(extractor.calls, 1);
});

test("semantic extraction rejects claims without verbatim source evidence", async () => {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "memory:one", type: "memory", label: "One", text: "Only exact evidence is accepted.", path: "/MEMORY.md", metadata: {} });
  const result = await refreshSemanticKnowledge(graph, new HallucinatingExtractor());
  assert.equal(result.rejected, 1);
  assert.equal([...graph.nodes.values()].some((node) => node.type === "claim"), false);
});

test("failed extraction preserves the previous source-backed semantic index", async () => {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "memory:one", type: "memory", label: "One", text: "Only exact evidence is accepted.", path: "/MEMORY.md", metadata: {} });
  graph.upsertNode({ id: "claim:old", type: "claim", label: "Old", text: "Old", path: "/MEMORY.md", metadata: { sourceID: "memory:one", sourceHash: "old", extractionModel: "old-model", evidence: "exact evidence" } });
  graph.addEdge({ from: "claim:old", to: "memory:one", type: "DERIVED_FROM", weight: 1 });

  const result = await refreshSemanticKnowledge(graph, new FailingExtractor());

  assert.equal(result.errors.length, 1);
  assert.ok(graph.nodes.has("claim:old"));
  assert.ok(graph.edges.some((edge) => edge.from === "claim:old" && edge.to === "memory:one"));
});

test("semantic vectors rank canonical evidence unless semantic types are requested", async () => {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "memory:design", type: "memory", label: "Design source", text: "Minimum font size is 16 pixels.", path: "/MEMORY.md", metadata: {} });
  graph.upsertNode({ id: "preference:design", type: "preference", label: "Font preference", text: "Typography uses a 16 pixel minimum.", path: "/MEMORY.md", metadata: { sourceID: "memory:design" } });
  graph.addEdge({ from: "preference:design", to: "memory:design", type: "DERIVED_FROM", weight: 1 });
  const root = await mkdtemp(join(tmpdir(), "nuanced-projection-"));
  const path = join(root, "index.json");
  const embedder = new SemanticTestEmbedder();
  await buildEmbeddingIndex(graph, path, embedder);
  const index = await loadEmbeddingIndex(path);

  const evidence = await hybridSearchKnowledge(graph, "kleinste Schriftgröße", 5, index, embedder);
  const preferences = await hybridSearchKnowledge(graph, "kleinste Schriftgröße", 5, index, embedder, ["preference"]);

  assert.deepEqual(evidence.map((item) => item.node.id), ["memory:design"]);
  assert.deepEqual(preferences.map((item) => item.node.id), ["preference:design"]);
});

test("multilingual embedding fusion retrieves evidence with no shared query token", async () => {
  const graph = new KnowledgeGraph();
  graph.upsertNode({ id: "file:design", type: "file", label: "Design rules", text: "The typography constraint is sixteen pixels minimum.", path: "/Design.swift", metadata: {} });
  graph.upsertNode({ id: "file:other", type: "file", label: "Network rules", text: "The server retries failed requests.", path: "/Network.swift", metadata: {} });
  graph.upsertNode({ id: "function:design", type: "function", label: "minimumFontSize", text: "minimumFontSize returns 16", path: "/Design.swift", metadata: { project: "/repo" } });
  const root = await mkdtemp(join(tmpdir(), "nuanced-embeddings-"));
  const path = join(root, "index.json");
  const embedder = new SemanticTestEmbedder();

  const built = await buildEmbeddingIndex(graph, path, embedder);
  const index = await loadEmbeddingIndex(path);
  const results = await hybridSearchKnowledge(graph, "kleinste Schriftgröße", 2, index, embedder);

  assert.equal(built.entries, 2);
  assert.equal(results[0].node.id, "file:design");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});
