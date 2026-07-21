# Bayn

Bayn is a single-writer, paper-only quantitative research runtime. Its first protocol evaluates a frozen long-or-cash
time-series momentum strategy on adjusted ETF daily bars, compares it with buy-and-hold and direct-volatility timing,
and journals the resulting simulation to TigerBeetle. It contains no broker client and has no capital-promotion path.

## Runtime contract

- Node.js is the production runtime; Effect owns dependency acquisition, failure handling, and shutdown.
- Effect Config validates environment input. `BAYN_OPERATION_TIMEOUT_MS` bounds dependency operations, and
  `BAYN_HEALTH_INTERVAL_MS` controls the continuous health interval; both default to 30 seconds.
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
  it does not change lifecycle or authority. The Nix image starts in the default production mode and fails closed if
  embedded facts are absent.
- The reader selects one configured finalized Signal snapshot by content-addressed ID. It verifies the publisher
  manifest, sessions, every bar, exact SIP/all provenance, the canonical universe, content hashes, and explicit data,
  lookback, and evaluation bounds before exposing numeric bars.
- The run ID binds source and image identity, compiled strategy behavior and decoded parameters, complete finalized
  snapshot provenance, calendar version, and explicit bounds.
- One pure compiled TSMOM decision function records each lookback return, direction vote, score, active symbol, and
  target weight at a month-end close. Historical evaluation uses that function directly; any later paper planner must
  reuse it. Decisions may execute only at the next exchange session open.
- After exact TigerBeetle reconciliation, one PostgreSQL transaction records the immutable protocol lock, input
  snapshot reference, run identity, metrics, simulated orders, fills, cash changes, daily position marks, daily
  returns, turnover, fees, drawdown, aligned benchmark series, the full equity series, independent marked-equity
  proof, reconciliation receipt, gate outcomes, and status history. A content-addressed dossier manifest binds every
  artifact, event, and gate hash to the exact source, image, protocol, snapshot, calendar, and execution contract.
- Ordered artifacts can be read internally through contiguous pages capped at 256 items. PostgreSQL triggers make the
  complete evidence graph append-only and permit an evaluation row only its exact `WRITING` to `COMPLETE` transition.
- Every completed pre-qualification run is recorded once as a burned trial. Observed results cannot later be presented
  as an untouched qualification window, and the trial record cannot be updated or deleted.
- A future qualification lock must bind the exact protocol, source and image, finalized snapshot and bounds, universe
  rationale, prior trials, and content-hashed benchmark, threshold, uncertainty, and execution policies. Lock rows are
  append-only, and the result table permits exactly one immutable `QUALIFIED` or `REJECTED` run per lock. No active
  lock or qualification result exists until the remaining M2 policies are complete.
- The independent reducer rebuilds protocol costs, cash, positions, and every marked-equity point with integer micros.
  Evaluation and recovery fail if lineage diverges or fees or equity differ by more than one cent; the exact measured
  differences remain part of the receipt.
- On restart, Bayn derives the expected run ID from the verified Signal manifest and current executable identity. It
  resumes only an exact, complete, runtime-decoded PostgreSQL record; missing evidence triggers one evaluation, while
  partial, altered, or incompatible evidence fails closed without another TigerBeetle mutation.
- After startup, one scoped Effect loop continuously checks PostgreSQL, the configured Signal manifest, the active
  TigerBeetle run, and the complete durable evidence record without loading bars or writing accounting state. Readiness
  closes on any defect and reopens only after every check succeeds; the last valid evidence remains observable.
- A run becomes ready only after ClickHouse validation, evaluation, TigerBeetle journal creation, exact reconciliation,
  the PostgreSQL commit, and one successful continuous check. Strategy rejection is an auditable economic
  `FAIL_CLOSED`; it remains separate from operational health and never expands authority.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency, evidence, and accounting readiness.
- `GET /v1/status`: operational dependencies, data and evidence identity, economic verdict, accounting, build
  provenance, and fixed observe-only authority.
- `GET /v1/evaluations/:runId`: complete content-hashed evidence for one exact run ID. The service is ClusterIP-only
  and the Bayn network policy limits HTTP ingress to the namespace.

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
