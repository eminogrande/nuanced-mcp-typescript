# Changelog

## Unreleased

- Add a versioned Brain benchmark schema, validator, baseline runner, sanitized public fixture, and JSON/Markdown reports.
- Measure source recall, ranking, fact coverage, forbidden hits, redundancy, and latency before changing retrieval.
- Define managed GitHub repository refresh and semantic-memory work in GitHub issue 1.

### Rationale

Retrieval quality must be measured against exact source-backed questions before semantic extraction, embeddings, graph traversal, or UI changes can be judged useful.

## 0.2.0

- Add unified ingestion for code, recordings, transcripts, documents, Hermes memory, and agent sessions.
- Add persistent search, browse, visualization, and GitHub/local repository import commands.
- Add a Hermes-compatible Nuanced memory-provider integration.

## 0.1.0

- Port the Nuanced MCP server to TypeScript with Python and TypeScript call-graph analysis.