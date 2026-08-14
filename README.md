# Nuanced MCP Server (TypeScript)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides call graph analysis to LLMs, ported from [mattmorgis/nuanced-mcp](https://github.com/mattmorgis/nuanced-mcp) (Python) to TypeScript.

This is a fork of the original Python MCP server. The Python implementation is preserved in git history; the working tree is now TypeScript.

## What's different from the original

- **TypeScript, not Python.** Built on the official `@modelcontextprotocol/sdk` over stdio.
- **Two analysis backends, one server:**
  - **Python repos:** shells out to the [`nuanced`](https://github.com/nuanced-dev/nuanced) library via `uv run` to produce the call graph, then loads it. No persistent Python process.
  - **TypeScript/JavaScript repos:** builds the call graph natively with [`ts-morph`](https://ts-morph.dev/), no Python dependency at all.
- Same 6 tools, 3 resources, and 3 prompts as the original, with an added `language` argument on `initialize_graph`.

## API

### Tools

- **initialize_graph** — Initialize a code graph for a repo.
  - `repo_path` (string)
  - `language` (`"python"` | `"typescript"`, default `"python"`)
- **switch_repository** — Switch to a different initialized repo. `repo_path` (string).
- **list_repositories** — List all initialized repositories.
- **get_function_call_graph** — Get the call graph for a specific function.
  - `file_path` (string), `function_name` (string), `repo_path` (string, optional)
- **analyze_dependencies** — Find all functions that depend on a file or module.
  - `file_path` (string, optional), `module_name` (string, optional)
- **analyze_change_impact** — Analyze the impact of changing a function.
  - `file_path` (string), `function_name` (string)

### Resources

- `graph://summary` — Summary of the currently loaded graph.
- `graph://repo/{repo_path}/summary` — Summary of a specific repo.
- `graph://function/{file_path}/{function_name}` — Details for a specific function.

### Prompts

- `analyze_function` — Analyze a function with its call graph.
- `impact_analysis` — Analyze the impact of changing a function.
- `analyze_dependencies_prompt` — Analyze dependencies of a file or module.

## Requirements

- Node.js >= 18
- `uv` on PATH (only required for analyzing Python repos; the TS backend needs nothing extra)

## Install & run

```bash
npm install
npm run build

# stdio server, for any MCP client (Claude Desktop, etc.)
node dist/index.js

# self-check tests
npm test
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nuanced": {
      "command": "node",
      "args": ["/absolute/path/to/nuanced-mcp-typescript/dist/index.js"]
    }
  }
}
```

## How it works

The graph data model mirrors the `nuanced` Python format: a flat dict of `dotted.path.fn -> { filepath, callees, lineno, end_lineno }`. The graph-traversal logic (`enrich`, dependency lookup, impact analysis) is written once in pure TypeScript and shared by both backends.

- **Python backend:** one-shot `uv run --with nuanced python3` to dump the graph JSON, then load it. No persistent worker.
- **TS/JS backend:** `ts-morph` collects function-like declarations, resolves callees via TypeScript symbol resolution with a dotted-key fallback.

## License

MIT, inherited from the upstream repo.


## Unified Knowledge Brain

The server extends the code call graph with a persistent heterogeneous graph for DICTATOR recordings/transcripts, prompts/documents, repositories, source files, functions, and keywords.

MCP tools:

- `knowledge_ingest` — refresh initialized repositories, DICTATOR history, and document directories.
- `knowledge_search` — token-bounded source-backed search with related graph nodes.
- `knowledge_stats` — node/edge counts by type.

Direct app/CLI commands:

```bash
npm run build
node dist/brain-cli.js import-repo https://github.com/owner/repository
node dist/brain-cli.js managed-repos-refresh --force
node dist/brain-cli.js managed-repos-status
node dist/brain-cli.js semantic-refresh
node dist/brain-cli.js embedding-refresh
node dist/brain-cli.js search "minimum font size 16"
node dist/brain-cli.js stats
npm run benchmark -- /absolute/path/to/cases.json /absolute/path/to/report.json
node dist/brain-cli.js benchmark-hybrid /absolute/path/to/cases.json /absolute/path/to/report.json
```

Semantic extraction and multilingual retrieval run locally through Ollama:

```bash
ollama pull qwen3:4b
ollama pull qwen3-embedding:0.6b
```

Normal ingestion and lexical search remain available when Ollama is stopped. Derived semantic nodes are accepted only when their evidence is an exact source substring. The embedding index stores quantized vectors, not copied source text.

`managed-repos-refresh` manages the ten most active non-archived, non-fork `nuri-com` repositories measured over the preceding 90 days on 2026-08-14. It records visibility, default branch, and indexed commit; skips unchanged repositories; removes stale file/function nodes after deletes or renames; and isolates failures per repository. Without `--force`, it checks at most once per 24 hours. `--force` checks immediately but still skips unchanged commits.

The default graph is `~/Library/Application Support/DictateMac/Brain/knowledge-graph.json`. Archive refresh replaces stale recording/transcript nodes while preserving repository knowledge.

Benchmark design, privacy boundaries, metrics, and gates are documented in [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md). The first aggregate baseline is in [`docs/benchmarks/2026-08-14-baseline.md`](docs/benchmarks/2026-08-14-baseline.md). Private benchmark cases and detailed reports remain outside git.

Release history and rationale: [`CHANGELOG.md`](CHANGELOG.md).
