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
