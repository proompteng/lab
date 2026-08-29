# Bayn architecture

## Boundary

Bayn is a single-writer intraday trading service. The execution path is account-neutral: sandbox and live accounts use
the same strategy, intent, risk, mutation, recovery, accounting, and reconciliation code. Broker environment and a
durable capital activation determine where an otherwise identical execution plan may run.

The active runtime contains one strategy, `intraday-momentum`, using
`bayn.intraday-momentum.protocol.v2`. Historical strategy and decision schemas remain readable only where persisted
records require them; they are not runtime fallbacks and cannot start new cycles.

## Ownership

- The account-keyed Restate `BaynExecutionController` exclusively owns scheduling, serialization, durable retries,
  delayed ticks, and worker-version routing.
- Pure TypeScript owns market-data verification, the strategy decision, target planning, risk decisions, and cycle
  transitions.
- Effect owns bounded external I/O, typed failures, resource acquisition, logging, and tracing for one execution pass.
- PostgreSQL is the authoritative ledger for activations, cycles, decisions, intents, mutations, reconciliation, and
  the compact controller status projection.
- TigerBeetle is the authoritative accounting ledger for cash, fees, cost basis, and realized P&L.
- ClickHouse is the read-only retained intraday archive populated from Alpaca WebSocket events through Kafka and
  Dorvud/Flink.
- The broker adapter performs account-environment-neutral reads and mutations through the restricted egress proxy.
- The public Bayn deployment serves read-only liveness, readiness, status, metrics, and traces. It does not schedule
  execution or own broker mutation authority.

## Intraday flow

1. Restate invokes one bounded `advanceExecutionOnce` pass for the canonical account-binding hash.
2. The pass reconciles persisted intents and broker state before considering new exposure. Any unknown mutation,
   discrepancy, stale observation, or identity drift blocks new orders.
3. During an eligible regular-market window, Bayn reads a finalized rolling intraday snapshot from ClickHouse. The
   snapshot binds exact archive rows, Kafka topic watermarks, calendar, universe, feed, delay class, observation time,
   and content hashes.
4. The pure strategy returns a target portfolio or a typed no-trade result. Missing or late data is a lifecycle
   blocker, not `NO_TRADE`.
5. The target planner derives whole-share deltas from the reconciled account and verified execution prices. The
   strategy decision, exact decision rows, planner input, target plan, risk decisions, and deterministic intent IDs are
   committed before broker I/O.
6. The mutation interpreter submits only committed, unexpired intents. Ambiguous outcomes remain unresolved until
   deterministic client-order-ID lookup and reconciliation recover them.
7. The controller schedules exactly one successor tick. Restate delivery does not replace database idempotency or the
   persisted broker-mutation state machine.
8. Before the close, the same cycle enters close-only operation. Completion requires a flat account, no open orders or
   unresolved mutations, exact PostgreSQL/TigerBeetle reconciliation, and a persisted net-of-cost performance receipt.

## Active strategy

After a 60-minute warmup and until 60 minutes before the regular-session close, Bayn evaluates the latest fully
elapsed 30-minute IEX window. It compares AAPL, AMZN, IWM, NVDA, QQQ, and SMH with SPY and requires positive candidate
momentum, non-negative benchmark momentum, at least 10 basis points of excess momentum, top-quartile range location,
a spread no wider than 5 basis points, displayed liquidity, and complete fresh bars, quotes, and trades.

The strategy selects at most one long position and caps it at 10% of mandate allocation. Entry uses whole-share IOC
limit orders at the verified adverse quote boundary. Bayn begins flattening 30 minutes before the close and must be
flat 15 minutes before the close. The protocol, universe, thresholds, feed contract, and execution model are
source-controlled and included in the image's verified behavior, parameter, and protocol hashes.

## Mutation and risk boundary

Mutation is capability-gated, not account-type-gated:

1. Static broker-access and capital-authority configuration set the maximum possible capability.
2. A current durable activation bound to source revision, image digest, strategy hashes, account reference, and risk
   policy must be realized before the runtime composes mutation capability.
3. PostgreSQL records `SUBMIT_STARTED`, the canonical request hash, deterministic client-order ID, and recovery delay
   before the first broker POST.
4. The coordinator rechecks authority, kill state, reconciliation, freshness, limits, and the half-open submission
   interval immediately before broker I/O.
5. Decoded broker rejections are terminal. Timeouts, malformed responses, server errors, interruption, or a post-send
   crash remain unknown and block new exposure.
6. Recovery performs deterministic read-by-client-order-ID. Broker POST and DELETE operations are never wrapped in a
   generic retry.

Execution is long-only. Sells cannot exceed reconciled inventory. Symbol exposure, gross and net exposure, turnover,
loss, drawdown, open-order count, slippage, staleness, and cutoff limits fail closed.

## Effect composition

Effect is used at capability and failure boundaries, not as a wrapper around pure calculations:

- strategy calculations, hashing, market-data validation, target planning, risk rules, and state transitions are pure
  immutable functions;
- database, ClickHouse, TigerBeetle, broker, telemetry, and HTTP resources are scoped Effect services;
- the execution worker owns one process-scoped `ManagedRuntime`, while each Restate handler runs one bounded pass;
- typed domain blockers return durable outcomes and continue the reconciliation cadence; transient infrastructure
  failures use bounded Restate retries; and
- credentials, plaintext account identity, raw broker payloads, and strategy data never enter logs, metrics, traces, or
  public status.

Do not introduce repositories, registries, plugins, events, or dependency-injection wrappers for pure values. Add a
service only for a real acquired capability, external I/O boundary, or typed lifecycle.

## Runtime state and HTTP

Internal operational states are `STARTING`, `READY`, `DEGRADED`, and `FAILED`. The health projection independently
tracks PostgreSQL, Signal/ClickHouse, TigerBeetle, cycle state, and the cycle runner as `UNKNOWN`, `AVAILABLE`, or
`UNAVAILABLE`.

`GET /readyz` is ready only when all of the following are true:

- operational status is `READY` and the health observation is within its freshness lease;
- no capital activation is pending;
- the cycle condition is neither `UNKNOWN`, `STALLED`, nor `FAILED`;
- the most recent controller pass is not a failure;
- every required dependency is `AVAILABLE`; and
- when a broker is configured, its account binding and read capability are both verified.

`GET /v1/status` reports operational health, dependencies, data state, accounting and economics, the current or latest
cycle, controller loop and durable Restate projection, capital activation, redacted broker state, effective authority,
verified build identity, and the current blocker. It does not expose the removed evaluation or qualification
projections. `authority.brokerOrders` and `authority.capitalPromotion` become true only after the exact durable capital
activation is realized; configuration alone is not authority.

`GET /livez` proves only that the HTTP process is alive. A ready status pod, a healthy Restate deployment, or an Argo
`Synced/Healthy` result alone does not prove that a trading decision, broker order, fill, or profit occurred.

## Delivery and recovery

Normal delivery is immutable and GitOps-only:

1. merge reviewed source to `main`;
2. build and publish the exact multi-architecture image;
3. advance the generated Bayn deployment pins only when source, image, strategy, activation, and risk identities agree;
4. let Argo reconcile the public status service, execution worker, and source-versioned activation hook; and
5. verify the exact source and image live before accepting controller or broker evidence.

The public status Deployment may surge because it has no execution authority. Multiple execution-worker replicas are
safe because Restate serializes the account-keyed virtual object and PostgreSQL enforces the writer fence for every
trading-state transaction. Intents and deterministic client-order IDs remain the protection across retries, worker
replacement, and ambiguous broker responses.

Rollback must deactivate the current controller epoch and prove the writer fence clear before activating another
source/image identity. Direct deployment and manual broker orders are not valid rollout or trading proof.

## Completion evidence

Operational rollout requires the exact reviewed source/image live, fresh controller ticks after worker replacement,
fresh status projections, exact reconciliation, and zero unresolved mutations. Autonomous trading requires additional
natural-session evidence: a verified decision, deterministic broker intents, broker-confirmed fills when the strategy
trades, close/flat completion, exact accounting, all costs, and realized return. A valid `NO_TRADE` is reported as such;
profit is never inferred from infrastructure health.
