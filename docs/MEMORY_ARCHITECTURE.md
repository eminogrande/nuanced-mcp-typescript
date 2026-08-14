# Nuanced Brain memory architecture

## Decision

Nuanced remains the only deep knowledge graph. Hermes keeps its native, bounded `MEMORY.md` and `USER.md` files for curated always-on facts. A thin `MemoryProvider` adapter connects both layers; no second vector database is introduced.

## Hermes compatibility

The adapter implements the current open `MemoryProvider` contract:

- `initialize`: profile-aware startup and curated-memory ingestion.
- `prefetch` and `recall_status`: compact local evidence before a turn.
- `sync_turn`: durable asynchronous primary-session capture.
- `on_session_switch`: session identity rotation without losing lineage.
- `on_memory_write`: mirror successful built-in memory mutations by re-reading the canonical Markdown file.
- `on_delegation`: preserve parent/child task evidence.
- `backup_paths`: include all Brain sources and graph state in `hermes backup`.
- `get_tool_schemas`: empty. Existing Nuanced MCP tools remain the explicit deep-search surface, avoiding prompt-schema bloat.

The built-in memory is not replaced. Hermes' frozen system-prompt snapshot, `§` delimiter, atomic writes, drift guard, threat scan, and profile scoping remain authoritative.

## Imported source formats

One additive ingestion contract handles:

- Hermes `MEMORY.md` and `USER.md`, one graph node per `§`-delimited entry.
- Hermes full-session JSONL: one session object per line with a `messages` array.
- Hermes prompt-only JSONL: `session_id`, `index`, `created_at`, `role`, and `text`.
- OpenAI-style session JSON/JSONL with role/content messages.
- Claude-style trace rows with `type` and nested `message`.
- Markdown, text, JSON, JSONL, pasted context, local repositories, and GitHub repositories.

Every imported node retains its raw source path, source kind, session ID, role, timestamp where available, and graph relationships. Pasted text is first saved as a private source file; the graph never becomes the only copy.

## Ideas reviewed and reused

| System | Useful idea | Decision |
|---|---|---|
| Hermes built-in | tiny curated memory, frozen prompt snapshot, profile scoping, lifecycle hooks | Adopted as the compatibility contract |
| OpenViking / ByteRover | filesystem hierarchy and tiered retrieval for code/resources | Reused as source type + repository/session hierarchy; no extra service |
| Hindsight | consolidated observations are denser than repeated raw facts | Future consolidation layer; raw evidence remains immutable first |
| Honcho | per-session/per-repository identity and asynchronous turn writes | Adopted through session IDs, parent lineage, and background `sync_turn` |
| Holographic | local trust/feedback and entity relationships | Relationship provenance adopted; trust must be evidence-derived before ranking |
| Mem0 | semantic extraction and hybrid retrieval | Not added: it would require another LLM, embedder, and vector store beside Nuanced |

Cloud-only or API-dependent providers are not dependencies of DICTATOR. Their concepts may be reused only when the implementation remains local, source-backed, and license-compatible.

## Coding-agent retrieval

Repository files and function call graphs live beside sessions, transcripts, memories, and documents. Search combines:

1. exact label matches,
2. exact body matches,
3. conservative phonetic matching for likely speech-recognition variants,
4. graph-connected evidence,
5. source-centered excerpts around the actual match.

Example: a transcript token such as `PASCII` can retrieve `passkey` evidence from a repository or prior session. This does not itself rewrite the transcript. The enhancement LLM may propose the correction only when the returned evidence contains the replacement and the existing local confidence/edit guards accept it.

## Safety and durability

- Audio, raw transcripts, source files, and Hermes memory files remain canonical and immutable by retrieval.
- Imported source text is evidence, never instruction; provider prefetch uses Hermes' strict threat scanner.
- Provider failures are fail-open and never block Hermes or local dictation.
- No credentials enter graph metadata, process arguments, archives, or source files.
- Graph changes are additive and preserve the existing version-1 JSON structure.
