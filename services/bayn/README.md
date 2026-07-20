# Bayn

Bayn is a single-writer, paper-only quantitative research runtime. Its first protocol evaluates a frozen long-or-cash
time-series momentum strategy on adjusted ETF daily bars, compares it with buy-and-hold and direct-volatility timing,
and journals the resulting simulation to TigerBeetle. It contains no broker client and has no capital-promotion path.

## Runtime contract

- Node.js is the production runtime; Effect owns dependency acquisition, failure handling, and shutdown.
- Effect Config validates environment input, and `BAYN_OPERATION_TIMEOUT_MS` bounds each ClickHouse or TigerBeetle
  startup operation (30 seconds by default).
- Signal ClickHouse is read-only at runtime. `backfill.ts` is an operator-only data preparation command and is not part
  of the Deployment.
- The composition root selects one strategy capability. TSMOM is the first implementation and owns its protocol and
  universe; the HTTP and startup lifecycle do not depend on TSMOM directly.
- The protocol is committed at `protocols/tsmom-v1.json` and runtime-decoded with Effect Schema before use. JSON holds
  immutable parameters only; the reviewed TypeScript implementation remains compiled into the image.
- The executable embeds source, repository, and strategy-behavior identity. Startup verifies configured attribution,
  and status exposes the promoted image digest, parameter hash, and contract versions.
- The transitional run ID binds runtime provenance and the exact ClickHouse input-manifest hash. It remains distinct
  from the target finalized-snapshot run identity until bounded Signal publications are adopted.
- Signals are formed at a month-end close and may execute only at the next common session open.
- A run becomes ready only after ClickHouse validation, evaluation, TigerBeetle journal creation, and exact
  reconciliation. Strategy rejection is an auditable economic `FAIL_CLOSED`; dependency or accounting failure keeps
  the Kubernetes readiness probe closed.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: dependency/evaluation/accounting readiness.
- `GET /v1/status`: authority boundary, input manifest, metrics, verdict, and reconciliation receipt.

## Validation

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn build
bun run --filter @proompteng/bayn lint:oxlint
```

The backfill requires an explicit start, end, feed, and dataset version plus an administrative ClickHouse identity and
Alpaca market-data credentials. Those credentials are never mounted into the Bayn runtime.
