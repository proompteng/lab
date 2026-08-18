# Bayn

Bayn is a single-writer quantitative research and execution runtime. Its active strategy is
`bayn.risk-balanced-trend.protocol.v4`: normalized horizon trends are clipped before a median aggregate, at least three
of four horizons must be positive, and eligible sleeves are risk-budgeted by conviction per unit annualized volatility.
The universe, monthly rebalance, 35% sleeve cap, 10% portfolio-volatility ceiling, execution costs, benchmarks,
uncertainty policy, and economic gates are source-controlled. A terminal qualification result never grants broker or
capital authority by itself. The deployed controller currently has read-only broker access and no capital authority.
Sandbox versus live selects only the broker adapter/configuration; final authorization, intent, risk, reconciliation,
recovery, and mutation logic are account-environment agnostic. A bounded `ExecutionMandate` exists only when a
separately reviewed durable capital grant is present.

## Runtime contract

- Node.js is the production runtime; Effect owns dependency acquisition, failure handling, and shutdown.
- Effect Config validates environment input. `BAYN_OPERATION_TIMEOUT_MS` bounds dependency operations, and
  `BAYN_HEALTH_INTERVAL_MS` controls the continuous health interval; both default to 30 seconds.
- `BAYN_BROKER_ACCESS` and `BAYN_CAPITAL_AUTHORITY` are the only runtime authority selectors. They default to
  `read-only` and `none`; submit/cancel capability requires mutation broker access plus an exact durable capital grant,
  reviewed activation, build/account identity, and broker preflight. Historical `OBSERVE`/`PAPER` values remain only in
  persisted wire contracts and hashes.
- Public egress is denied from the Bayn Pod. A separate CONNECT proxy permits only
  the configured Alpaca adapter host (`paper-api.alpaca.markets:443` for the sandbox deployment). A configured Alpaca
  credential is accepted only after account, position, order,
  order-lookup, and fill reads pass the runtime-decoded preflight through that proxy.
- Signal ClickHouse is read-only at runtime. Data publication and provider credentials are owned by the separate Signal
  adjusted-daily publisher; Bayn contains no DDL or backfill command.
- Bayn owns a two-instance CloudNativePG cluster. The runtime uses the generated application URI over verified TLS,
  runs versioned Effect SQL migrations at startup, and keeps a bounded two-connection pool.
- PostgreSQL stores execution mutation transitions in one append-only `mutation_events` table. Request identity, broker
  response identity, and the lookup delay are committed before use; unresolved outcomes block later exposure. An
  observe-only generation cannot create mutation rows, while an authorized execution mandate must durably commit its
  intent and risk binding before broker mutation I/O.
- Execution is long-only: risk blocks an existing short or a sell beyond reconciled long inventory before broker
  I/O. Fill accounting persists Alpaca's full source timestamp and orders equal timestamps by fill ID, rejects late
  predecessors, and records a receipt only after the complete TigerBeetle transaction-tag transfer set matches.
- The composition root builds one pure strategy value and passes it explicitly to the lifecycle. Effect services and
  layers are reserved for I/O resources. The compiled `bayn.risk-balanced-trend.protocol.v4` owns its authoritative
  universe and causal execution contract; the HTTP and startup lifecycle remain strategy-independent. Protocol v2
  remains decodable only so immutable historical evidence can be recovered.
- The typed protocol is compiled into the image and runtime-decoded with Effect Schema. Strategies remain reviewed
  TypeScript rather than JSON. Protocol v4 is the current candidate; v2 and v3 remain decodable only for immutable
  historical evidence.
- The executable embeds source, repository, and strategy-behavior identity. Startup verifies the compiled behavior and
  parameter hashes against those embedded facts, and status exposes the promoted image digest, parameter hash, and
  contract versions. The v4 precommit uses behavior hash
  `dde55f6292080b185554148cbfe4380e729626df1d11cbb47392645a80ce6c46` and parameter hash
  `150f22c28829c60d6c5947ee44361de1e4c53c18269fa3585e3a81cb5b3e3d1b`.
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
- Production GitOps carries that pin outside an explicit one-shot qualification release. Once a fresh candidate is
  deployed without a pin, its source, image digest, compiled strategy, and complete runtime are immutable until the
  exact independently accepted terminal run is pinned. Fresh-candidate deployment and pin installation cannot be
  combined, and automatic image promotion supplies neither candidate material nor a run ID. Once pinned, a later
  operational release may change source only while preserving compiled strategy and qualification identity. This
  prevents extra trials or rebinding evidence to implicit inputs.
- The compiled risk-balanced trend decision function records every normalized trend horizon, volatility estimate,
  portfolio-volatility scale, and target weight at a month-end close. Quantities are planned only after that Signal
  session is finalized, using its close prices and reconciled broker state observed before planning. Ordinary
  non-extended `DAY` market orders may be submitted only after the plan is committed and before the fixed 15-minute
  pre-open cutoff. The next exchange-session open affects fills and performance, never planned quantities; planned
  buys reserve only pre-submit cash and cannot spend proceeds from planned sells.
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
- Credentials currently provide GET-only Alpaca access under `OBSERVE`. A validated bounded execution mandate may
  additionally compose `BrokerMutation`, intent and mutation stores, and the coordinator. Recovery and reconciliation run before
  new work; each intent and risk decision is committed before broker I/O; the final submit revalidates authority and
  risk under `WriterFence`. Missing or inconsistent activation, identity, mutation, or reconciliation evidence falls
  back to read-only behavior or fails closed.
- Exact Alpaca asset reads preserve the returned status, tradability, fractionability, and normalized attributes as
  content-hashed evidence; the read adapter does not decide execution eligibility.
- The bounded Alpaca calendar observation is content-hashed with its request range, source/version, and normalized UTC
  sessions. A causal execution-session binding retains and revalidates that complete observation, selects its first
  post-signal session, and binds the session's exact open, close, pre-open cutoff, finalized Signal identity, and
  reconciled planning-state identity. Execution risk approves only in `[submissionOpenAt, submissionCutoffAt)` and
  reserves aggregate buying power across planned buys. The submit path rechecks the committed risk-decision expiry
  with the Effect clock, then atomically revalidates it in the fenced mutation-start transaction immediately before
  POST; the cutoff instant permits no new exposure and no durable `SUBMIT_STARTED` event. Cancellation is restricted
  to the exact broker order identified by the durable submit, the writer fence, execution maximum authority (whose
  historical wire value is `PAPER`), and mutation-store authority. That de-risking path remains available after cutoff
  or approval expiry and while the kill is active.
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

## Runtime operations

`BAYN_OPERATION` has no default. When it is absent, Bayn selects the credential-free service or autonomous execution
service from the resolved broker and authority bindings. The deployed service remains read-only unless the exact
reviewed activation, durable grant, account, strategy, risk policy, source, and image bindings all validate. An
authorized `ExecutionMandate` may enter, hold, and close one bounded research or qualified grant; terminalization
restricts execution authority back to observe-only behavior.

`BAYN_OPERATION=EXECUTION_CANDIDATE_DISCOVERY` selects the bounded account-neutral `ExecutionCandidateDiscovery`
operation. It requires read-only broker access, no capital authority, a pinned terminal qualification, and a complete
GET-only Alpaca binding, then exits before the HTTP service or autonomous execution runtime is constructed.

Candidate discovery opens one PostgreSQL `REPEATABLE READ, READ ONLY` transaction through the shared client and uses
only `CycleObservability` and `CycleStore` domain reads. It does not run migrations, reconcile, re-run planning, or
compose execution mutation stores, `WriterFence`, intent/mutation stores, or broker mutation. The latest cycle must be `COMPLETED`
with zero unfinished cycles and a strict persisted shadow document bound to the same cycle, snapshot, account,
qualification, strategy, risk policy, and latest exact reconciliation. Durable maximum/effective authority must both
be `OBSERVE`, the durable generation must match configuration, and each delta may have only `AuthorityNotPaper`.

After the immutable read snapshot, discovery performs one account GET and one asset GET per ordered persisted target
delta with bounded concurrency, restores document order, and emits every candidate without selecting one. Historical
quantity, reference price, notional, and risk values remain non-authorizing observations. The ephemeral typed receipt
contains immutable binding, semantic candidate-facts, and complete observation hashes; it exposes no account number or
credentials and writes no dossier. Later PREPARE/SUBMIT/CANCEL/RECOVER work remains separately gated.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency, evidence, and accounting readiness.
- `GET /v1/status`: operational dependencies, data and evidence identity, terminal qualification, deterministic
  qualification diagnosis, economic verdict, accounting, current build provenance, qualification-execution
  provenance, and the configured authority ceiling. Diagnosis includes the selected benchmark, point Sharpe gap,
  bootstrap distribution and positive fraction, lower bounds, power, walk-forward stability, and transaction costs.
- `GET /v1/evaluations/:runId`: complete content-hashed evidence for one exact run ID. The service is ClusterIP-only
  and the Bayn network policy limits HTTP ingress to the namespace.

## Validation

`tsc` invokes the pinned Effect TSGo compiler directly, so TypeScript and configured Effect diagnostics run once and
share one failing exit boundary.

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn build
bun run --filter @proompteng/bayn lint:oxlint
```

Historical development candidates are terminal and are not executable repository inputs. Their compact immutable
status and receipt hashes are retained in [`docs/bayn/candidate-terminal-history.md`](../../docs/bayn/candidate-terminal-history.md).

The PostgreSQL integration suite requires an isolated local database whose name ends in `_test`:

```sh
BAYN_TEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:5432/bayn_test \
  bun test services/bayn/src/db/evidence-store.integration.test.ts
```

The current candidate reads `adjusted_daily_bars_v2`, `exchange_sessions_v1`, and `snapshot_manifests_v2` through the
official Effect ClickHouse client. Bayn's Signal identity is read-only and has no DDL, insert, or mutation authority.
