# Changelog

## Unreleased

- Add a versioned Brain benchmark schema, validator, baseline runner, sanitized public fixture, and JSON/Markdown reports.
- Measure source recall, ranking, fact coverage, forbidden hits, redundancy, and latency before changing retrieval.
- Define managed GitHub repository refresh and semantic-memory work in GitHub issue 1.
- Add local Qwen semantic extraction with exact verbatim evidence spans and stable typed claim, decision, preference, task, event, and entity nodes.
- Add a quantized multilingual embedding index and reciprocal-rank fusion with lexical search; embed canonical sources rather than duplicate function wrappers, and keep normal search fail-open when Ollama is unavailable.
- Stop generating generic token-overlap `RELATED` edges and expand only explicit structural or semantic relationships.
- Add commit-aware managed refresh for the ten most active `nuri-com` repositories, including stale-file removal, visibility/default-branch/commit provenance, 24-hour due checks, and failure isolation.
- Improve the private 32-case benchmark from 81.3% to 93.8% recall@5 and from 0.657 to 0.795 MRR.
- Keep managed repository refresh successful when optional Ollama embedding is unavailable; lexical evidence remains immediately usable.
- Do not rewrite the graph on stats, browse, search, or MCP search. Repository refresh no longer waits on embedding. `hermes-sync` imports Hermes MEMORY.md, USER.md, and saved agent sessions.

### Rationale

Retrieval quality must be measured against exact source-backed questions before semantic extraction, embeddings, graph traversal, or UI changes can be judged useful. Derived knowledge remains replaceable index data: every statement must retain an exact source ID, path, verbatim evidence span, extraction model, and source hash.

## 0.2.0

- Add unified ingestion for code, recordings, transcripts, documents, Hermes memory, and agent sessions.
- Add persistent search, browse, visualization, and GitHub/local repository import commands.
- Add a Hermes-compatible Nuanced memory-provider integration.

## 0.1.0

- Port the Nuanced MCP server to TypeScript with Python and TypeScript call-graph analysis.