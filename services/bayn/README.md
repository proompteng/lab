# Bayn

Bayn is a single-writer, paper-only quantitative qualification runtime. Its next protocol precommits the frozen
risk-balanced trend candidate on a five-sleeve cross-asset ETF universe. The deployed runtime remains pinned to the
terminal infrastructure-equity result and does not journal a new simulation to TigerBeetle. Alpaca credentials may
enable a bounded GET-only account preflight while authority remains `OBSERVE`.
The paper mutation capability, execution entry point, and capital-promotion path remain dormant.

## Runtime contract

- Node.js is the production runtime; Effect owns dependency acquisition, failure handling, and shutdown.
- Effect Config validates environment input. `BAYN_OPERATION_TIMEOUT_MS` bounds dependency operations, and
  `BAYN_HEALTH_INTERVAL_MS` controls the continuous health interval; both default to 30 seconds.
- `BAYN_MAXIMUM_AUTHORITY` is a closed `OBSERVE`/`PAPER` process ceiling and defaults to `OBSERVE`. It never creates a
  broker capability; the deployed runtime remains `OBSERVE` and does not compose the submit/cancel capability.
- Public egress is denied from the Bayn Pod. A separate CONNECT proxy permits only
  `paper-api.alpaca.markets:443`. A configured Alpaca credential is accepted only after account, position, order,
  order-lookup, and fill reads pass the runtime-decoded preflight through that proxy.
- Signal ClickHouse is read-only at runtime. Data publication and provider credentials are owned by the separate Signal
  adjusted-daily publisher; Bayn contains no DDL or backfill command.
- Bayn owns a two-instance CloudNativePG cluster. The runtime uses the generated application URI over verified TLS,
  runs versioned Effect SQL migrations at startup, and keeps a bounded two-connection pool.
- PostgreSQL stores paper mutation transitions in one append-only `mutation_events` table. Request identity, broker
  response identity, and the lookup delay are committed before use; unresolved outcomes block later exposure. The
  deployed observe-only runtime does not create mutation rows.
- Paper execution is long-only: risk blocks an existing short or a sell beyond reconciled long inventory before broker
  I/O. Fill accounting persists Alpaca's full source timestamp and orders equal timestamps by fill ID, rejects late
  predecessors, and records a receipt only after the complete TigerBeetle transaction-tag transfer set matches.
- The composition root builds one pure strategy value and passes it explicitly to the lifecycle. Effect services and
  layers are reserved for I/O resources. The compiled `bayn.risk-balanced-trend.protocol.v2` owns its authoritative
  universe and execution contract; the HTTP and startup lifecycle remain strategy-independent.
- The typed protocol is compiled into the image and runtime-decoded with Effect Schema. Strategies remain reviewed
  TypeScript rather than JSON.
- The executable embeds source, repository, and strategy-behavior identity. Startup verifies configured attribution,
  and status exposes the promoted image digest, parameter hash, and contract versions.
- The package `dev` and `start` scripts use explicit `development-configured` provenance because their artifacts are
  not OCI production builds. That mode is visible in status and cannot override an executable with embedded metadata;
  it does not change lifecycle or authority. The Nix image starts in the default production mode and fails closed if
  embedded facts are absent.
- The reader selects one configured finalized Signal snapshot by content-addressed ID. Before reading bars, it verifies
  the publisher manifest and exact exchange calendar and derives the candidate identity and evaluation window. After
  lock acquisition it verifies every bar, SIP/all provenance, the canonical universe, content hashes, and explicit
  data, lookback, and evaluation bounds before exposing numeric bars.
- The run ID binds source and image identity, compiled strategy behavior and decoded parameters, complete finalized
  snapshot provenance, calendar version, and explicit bounds.
- `BAYN_QUALIFICATION_RUN_ID` optionally pins one terminal qualification across operational image updates. Startup
  verifies the stored strategy and Signal bindings, then recovers it without inspecting bars, opening a lock,
  evaluating, journaling, or persisting.
- Production GitOps carries that pin outside an explicit one-shot qualification release. The release writer refuses a
  second source revision on the same unpinned snapshot, preventing operational releases from creating new trials.
- The compiled risk-balanced trend decision function records every normalized trend horizon, volatility estimate,
  portfolio-volatility scale, and target weight at a month-end close. Decisions may execute only at the next exchange
  session open.
- After exact TigerBeetle reconciliation, one PostgreSQL transaction records the immutable protocol lock, input
  snapshot reference, run identity, metrics, simulated orders, fills, cash changes, daily position marks, daily
  returns, turnover, fees, drawdown, aligned benchmark series, the full equity series, independent marked-equity
  proof, reconciliation receipt, gate outcomes, and status history. A content-addressed dossier manifest binds every
  artifact, event, and gate hash to the exact source, image, protocol, snapshot, calendar, and execution contract.
- Ordered artifacts can be read internally through contiguous pages capped at 256 items. PostgreSQL triggers make the
  complete evidence graph append-only and permit an evaluation row only its exact `WRITING` to `COMPLETE` transition.
- Every completed evaluation without a qualification lock is recorded once as a burned trial. Observed results cannot
  later be presented as untouched evidence, and the trial record cannot be updated, deleted, or truncated.
- Before reading candidate bars, Bayn atomically opens one immutable lock for the exact candidate run and snapshot. The
  lock binds the protocol, source and image, finalized data and bounds, universe rationale, every prior burned trial,
  every prior terminal qualification attempt, and content-hashed benchmark, threshold, statistical, and execution
  policies. Concurrent attempts converge on that same lock; a different lock for the candidate or snapshot fails
  closed.
- Qualification uses deterministic paired complete-rebalance-block bootstrap inference, Bonferroni-adjusted one-sided
  bounds, an explicit power requirement, and expanding-origin walk-forward gates. `QUALIFIED` requires both the
  economic evaluation and every statistical gate to pass; every other terminal outcome is `REJECTED`.
- The complete evaluation graph and its single terminal qualification result commit in one PostgreSQL transaction.
  Any terminal-result failure rolls the evaluation graph back and leaves the lock visibly incomplete. An incomplete
  lock is never silently retried and blocks every new candidate; a locked candidate cannot bypass the terminal result
  through the ordinary persistence path.
- The current-only migration chain owns the unprefixed evidence, qualification, intent, and mutation schema. Startup
  rejects a legacy migration tracker or retired migration history after the hard cut; it never reads, converts, or
  falls back to legacy records.
- The Alpaca read adapter may be acquired while maximum authority is `OBSERVE`, but it performs GET-only preflight and
  does not build the paper store, reserve the writer fence, start reconciliation, or change PostgreSQL or TigerBeetle.
  The mutation adapter and recovery coordinator remain dormant source foundations.
- The execution path and independent reducer use integer micros for cash, quantity, prices, spread, slippage, fees,
  cash yield, positions, and every marked-equity point. Full, partial, and rejected orders are durable. Evaluation and
  recovery require exact zero-difference cash, fee, position, and equity reconstruction.
- On restart, Bayn derives the expected run ID from the verified Signal manifest and current executable identity. An
  exact terminal lock recovers the complete runtime-decoded PostgreSQL record without reading bars or mutating
  TigerBeetle. An opened lock without a terminal result, or altered or incompatible evidence, fails closed.
- After startup, one scoped Effect loop continuously checks PostgreSQL, the configured Signal manifest, the active
  TigerBeetle run, and the complete durable evidence record without loading bars or writing accounting state. Readiness
  closes on any defect and reopens only after every check succeeds; the last valid evidence remains observable.
- A transient dependency failure during startup exits the scoped process after releasing HTTP and clients so the
  Deployment can restart it. Deterministic contract, identity, or evidence failures remain observable as `FAILED`
  with readiness closed.
- A run becomes ready only after ClickHouse validation, evaluation, TigerBeetle journal creation, exact reconciliation,
  the PostgreSQL commit, and one successful continuous check. Strategy rejection is an auditable economic
  `FAIL_CLOSED`; it remains separate from operational health and never expands authority.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency, evidence, and accounting readiness.
- `GET /v1/status`: operational dependencies, data and evidence identity, terminal qualification, economic verdict,
  accounting, current build provenance, qualification-execution provenance, and the configured authority ceiling.
- `GET /v1/evaluations/:runId`: complete content-hashed evidence for one exact run ID. The service is ClusterIP-only
  and the Bayn network policy limits HTTP ingress to the namespace.

## Validation

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn build
bun run --filter @proompteng/bayn lint:oxlint
```

For a terminal locked candidate, `audit:qualification` performs an operator-side, read-only reproduction. It reads the
evidence graph in one PostgreSQL `REPEATABLE READ, READ ONLY` transaction, reloads the finalized Signal snapshot,
replays the candidate and all benchmarks without importing the production strategy, checks ClickHouse query-start
chronology on every physical ClickHouse replica with a separately supplied audit principal, and checks authoritative
`origin/main` history. It emits one `bayn.qualification-audit.v2` JSON report and exits nonzero on any failed check. Run
it twice and require identical `auditHash` values.

```sh
BAYN_AUDIT_RUN_ID=<run-id> \
BAYN_AUDIT_POSTGRES_URL=<authenticated-postgres-uri> \
BAYN_AUDIT_SIGNAL_URL=<signal-clickhouse-url> \
BAYN_AUDIT_SIGNAL_USERNAME=<readonly-bayn-user> \
BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME=<signal-publisher-user> \
BAYN_AUDIT_SIGNAL_PASSWORD=<readonly-bayn-password> \
BAYN_AUDIT_CLICKHOUSE_URLS=<replica-0-audit-url>,<replica-1-audit-url> \
BAYN_AUDIT_CLICKHOUSE_USERNAME=<query-log-audit-user> \
BAYN_AUDIT_CLICKHOUSE_PASSWORD=<query-log-audit-password> \
BAYN_AUDIT_REPOSITORY_PATH=<lab-checkout> \
  bun run --filter @proompteng/bayn audit:qualification
```

The audit command is not part of the deployed runtime and never calls TigerBeetle or a broker. Its privileged
ClickHouse credential is operator-supplied only to read `system.query_log`; the service keeps its normal Signal
read-only identity.

Set `BAYN_AUDIT_OUTPUT=dossier` on the same command to emit `bayn.qualification-dossier.v2`. The deterministic dossier
binds the full audited subject, evidence-set hashes, immutable lock/result, prior trials, contamination records,
verdict, and observe-only authority. It is an operator evidence artifact, not runtime configuration.

The PostgreSQL integration suite requires an isolated local database whose name ends in `_test`:

```sh
BAYN_TEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:5432/bayn_test \
  bun test services/bayn/src/db/evidence-store.integration.test.ts
```

The current candidate reads `adjusted_daily_bars_v2`, `exchange_sessions_v1`, and `snapshot_manifests_v2` through the
official Effect ClickHouse client. Bayn's Signal identity is read-only and has no DDL, insert, or mutation authority.
