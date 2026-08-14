import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeGraph } from "../knowledge/graph.js";
import { loadManagedRepositoryState, refreshManagedRepositories } from "../knowledge/managedRepositories.js";

test("managed repository state starts empty and private", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-managed-state-"));
  const path = join(root, "managed-repositories.json");
  const state = await loadManagedRepositoryState(path);
  assert.equal(state.version, 1);
  assert.deepEqual(state.entries, []);
});

test("managed refresh honors the 24-hour due window without network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "nuanced-managed-due-"));
  const graphPath = join(root, "knowledge-graph.json");
  const statePath = join(root, "managed-repositories.json");
  await new KnowledgeGraph().save(graphPath);
  await writeFile(statePath, JSON.stringify({
    version: 1,
    activityWindowDays: 90,
    activityMeasuredAt: "2026-08-14T00:00:00.000Z",
    lastRefreshAt: new Date().toISOString(),
    entries: [],
  }));

  const result = await refreshManagedRepositories({
    graphPath,
    repositoriesRoot: join(root, "Repositories"),
    statePath,
    specs: [{ slug: "invalid/no-network-call", rank: 1, commits90d: 1 }],
  });

  assert.equal(result.due, false);
  assert.equal(result.checked, 0);
  assert.equal(result.failed, 0);
});
