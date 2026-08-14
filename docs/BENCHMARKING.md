# Brain benchmarking

Nuanced Brain changes are evaluated before retrieval or graph behavior is modified.

## Run

```bash
npm run benchmark -- /absolute/path/to/cases.json /absolute/path/to/report.json
```

The command reads the graph selected by `NUANCED_KNOWLEDGE_GRAPH` or the normal DICTATOR Brain graph. It does not ingest, rewrite, or reconnect the graph. It writes machine-readable JSON and a Markdown report beside it.

## Case contract

See `fixtures/benchmark.public.json`. Every case has:

- a stable ID and natural-language question,
- exact expected answer facts,
- exact gold node IDs and/or source paths,
- expected source types,
- explicit forbidden claims,
- language/domain/task tags,
- the minimum number of gold sources required in the top five.

Private benchmark cases and reports belong under DICTATOR's private application-support Brain directory. Never commit private questions, source paths, node IDs, repository text, embeddings, or reports containing retrieved evidence.

## Metrics

- **Recall@1/5:** fraction of gold sources retrieved in the first one/five results.
- **MRR:** reciprocal rank of the first gold source.
- **Fact coverage:** fraction of expected facts present in top-five evidence.
- **Forbidden-hit rate:** explicit unsupported claims found in retrieved evidence.
- **Redundancy:** duplicate source-family share, including recording/transcript pairs.
- **Latency:** in-process search time per case.

## Gates

The semantic Brain must reach at least 90% gold-source recall@5, keep forbidden hits at zero, retain exact provenance for every derived claim, and beat both the current Nuanced lexical baseline and the Hermes-curated-memory-only baseline. UI work starts only after retrieval passes.
