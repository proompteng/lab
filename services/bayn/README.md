# Bayn

Bayn is a single-writer, paper-only quantitative research runtime. Its first protocol evaluates a frozen long-or-cash
time-series momentum strategy on adjusted ETF daily bars, compares it with buy-and-hold and direct-volatility timing,
and journals the resulting simulation to TigerBeetle. It contains no broker client and has no capital-promotion path.

## Runtime contract

- Node.js is the production runtime; Effect owns dependency acquisition, failure handling, and shutdown.
- Effect Config validates environment input, and `BAYN_OPERATION_TIMEOUT_MS` bounds each ClickHouse or TigerBeetle
  startup operation (30 seconds by default).
- Signal ClickHouse is read-only at runtime. Data publication and provider credentials are owned by the separate Signal
  adjusted-daily publisher; Bayn contains no DDL or backfill command.
- Bayn owns a two-instance CloudNativePG cluster. The runtime uses the generated application URI over verified TLS,
  runs additive Effect SQL migrations at startup, and keeps a two-connection pool for its single-writer operation plus
  query cancellation.
- The composition root selects one strategy capability. TSMOM is the first implementation and owns its protocol and
  universe; the HTTP and startup lifecycle do not depend on TSMOM directly.
- The protocol is committed at `protocols/tsmom-v1.json` and runtime-decoded with Effect Schema before use. JSON holds
  immutable parameters only; the reviewed TypeScript implementation remains compiled into the image.
- The executable embeds source, repository, and strategy-behavior identity. Startup verifies configured attribution,
  and status exposes the promoted image digest, parameter hash, and contract versions.
- The package `dev` and `start` scripts use explicit `development-configured` provenance because their artifacts are
  not OCI production builds. That mode is visible in status and cannot override an executable with embedded metadata;
  it also forces startup evaluation and journaling off. The Nix image starts in the default production mode and fails
  closed if embedded facts are absent.
- The reader selects one configured finalized Signal snapshot by content-addressed ID. It verifies the publisher
  manifest, sessions, every bar, exact SIP/all provenance, the canonical universe, content hashes, and explicit data,
  lookback, and evaluation bounds before exposing numeric bars.
- The run ID binds source and image identity, compiled strategy behavior and decoded parameters, complete finalized
  snapshot provenance, calendar version, and explicit bounds.
- Signals are formed at a month-end close and may execute only at the next exchange session open.
- After exact TigerBeetle reconciliation, one PostgreSQL transaction records the immutable protocol lock, input
  snapshot reference, run identity, metrics, reconciliation receipt, ordered events, gate outcomes, and status
  history. An exact replay returns the existing complete receipt only after every stored payload and content hash is
  revalidated; conflicting, altered, or partial evidence fails closed.
- A run becomes ready only after ClickHouse validation, evaluation, TigerBeetle journal creation, exact reconciliation,
  and the PostgreSQL commit. Strategy rejection is an auditable economic `FAIL_CLOSED`; dependency, accounting, or
  persistence failure keeps the Kubernetes readiness probe closed.

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

The PostgreSQL integration suite requires an isolated local database whose name ends in `_test`:

```sh
BAYN_TEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:5432/bayn_test \
  bun test services/bayn/src/db/evidence-store.integration.test.ts
```

Bayn reads the fixed `adjusted_daily_bars_v2`, `exchange_sessions_v1`, and `snapshot_manifests_v1` tables through the
official Effect ClickHouse client. Its Signal identity is read-only and has no DDL, insert, or mutation authority.
