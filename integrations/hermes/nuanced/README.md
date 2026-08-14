# Nuanced Brain memory provider for Hermes

This standalone Hermes plugin keeps `MEMORY.md` and `USER.md` as Hermes' small curated memory while using the local Nuanced graph for deeper cross-session recall.

## Contract

- `prefetch`: retrieves up to 6 compact, source-backed snippets.
- `sync_turn`: archives completed primary-agent turns as private JSONL and ingests them.
- `on_memory_write`: mirrors the current curated Hermes memory file.
- `on_session_switch`: preserves Hermes session identity.
- `on_delegation`: stores task/result pairs with parent lineage.
- `backup_paths`: includes the complete local Brain directory.
- `get_tool_schemas`: returns no tools; existing MCP tools remain the explicit deep-search surface.

Default Brain runtime:

```text
/Applications/DICTATOR.app/Contents/Resources/Brain
```

Default graph:

```text
~/Library/Application Support/DictateMac/Brain/knowledge-graph.json
```

Imported source material is evidence, never executable instruction. Prefetch skips snippets caught by Hermes' strict threat scanner. Provider failures are fail-open: Hermes continues with its built-in curated memory.
