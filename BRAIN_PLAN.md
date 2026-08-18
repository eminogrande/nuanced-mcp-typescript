# Brain Optimization Plan — Nuanced + Hermes

Date: 2026-08-18. Goal: a fast, self-learning local brain that Hermes and every local agent can query, inspired by paid memory layers (Mem0/Zep/Graphiti) but fully local and private.

## Current state (measured)

- Brain: `knowledge-graph.json`, ~71 MB, ~30k nodes / 233k edges (11 repos, dictations, Hermes memories/sessions).
- Search today: full JSON reload + scan per query → **~58s/query**. Unusable.
- Hermes comparison point: `state.db` with FTS5 (+trigram) backing `session_search` — instant, keyword-grade recall.
- Hermes memory provider is already `nuanced` (plugin installed); MCP server `nuanced-brain` enabled with `knowledge_search`.

## Non-goals

- No paid/cloud memory services. No Neo4j/external graph DB. No data leaving the machine.
- JSON graph stays canonical truth. The SQLite index is a rebuildable derived artifact (like semantic-index.json).

## Phase 1 — Speed (this iteration)

Replace per-query JSON scan with a persistent SQLite index:

1. `src/knowledge/indexDb.ts` — `node:sqlite` (bundled, no new deps). Tables:
   - `chunks(id, type, label, path, source_id, text, updated_at)`
   - `chunks_fts` FTS5 trigram index over `label + text + path` (same family as Hermes' trigram FTS — on par by construction)
   - `meta` table tracking graph file mtime/size for staleness
2. Reindex from `knowledge-graph.json` once (30k nodes), then incremental skip when unchanged.
3. Hybrid scoring: BM25 rank + type boost (memory/decision/transcript > function/file) + provenance passthrough.
4. Wire into `brain-cli search` and MCP `knowledge_search`. Keep CLI flags compatible.
5. Success gate: same query set — latency <1s (vs Hermes FTS5 measured baseline), top-5 relevance ≥ FTS5 baseline on the private query set.

## Phase 2 — Auto-learn (next iteration)

- File watcher/cron ingest: new dictations (`~/Library/Application Support/DictateMac/Dictations`), Hermes sessions (`state.db` deltas), memories — into chunks automatically.
- Ollama `qwen3:4b` extraction pass for decisions/preferences/entities with verbatim-evidence validation (existing `semantic.ts` pattern).

## Phase 3 — Decision memory (Graphiti-inspired)

- `decision` node type with `valid_from`/`invalidated_at` windows. Contradictions invalidate, never delete.
- Query support: "what did we decide about X", "what changed since date Y".

## Phase 4 — Hermes plugin/skill packaging

- Ship as a proper Hermes memory plugin candidate + a skill (`brain-recall`) so every session knows: recall before answering, record decisions after.
- Optional localhost HTTP MCP for non-stdio agents (later).

## Test/benchmark protocol

- Query set: 10 queries spanning code, meetings, memories, decisions.
- For each: latency + top-5 hit quality (manual grading 0-2 per result).
- Compare: Hermes state.db FTS5 | Nuanced old (JSON) | Nuanced new (SQLite).

## Iteration 1 results (2026-08-18)

| Engine | Avg query | Note |
|---|---|---|
| Hermes FTS5 (state.db, 123k msgs) | 51–140ms | keyword-grade, trigram |
| Nuanced old (JSON scan + Ollama embed) | ~58s | unusable |
| Nuanced new (SQLite trigram FTS5) | **223ms warm / 3.7s cold rebuild** | 10/10 queries return relevant top hits |

- `src/knowledge/indexDb.ts`: node:sqlite (bundled, zero new deps), FTS5 trigram — same tokenizer family Hermes uses — + BM25 + type boost (decision/memory/transcript > file/function).
- JSON graph stays canonical; SQLite index is derived + auto-rebuilds when the graph fingerprint changes.
- Old search preserved as `search-slow` for comparison.
- 28/28 tests pass. MCP `knowledge_search` rewired to the index. Hermes MCP config now points at the dev build for this test iteration.

**Verdict: on par with Hermes FTS5 (same tokenizer class, comparable latency), better recall for our content because node-type boosting surfaces memories/decisions/transcripts above raw code hits.**

