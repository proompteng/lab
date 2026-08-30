# Bayn

Bayn is a single-writer intraday execution service. Restate schedules one account-keyed controller, pure TypeScript
decides what should happen, Effect interprets one bounded pass, PostgreSQL stores trading truth, TigerBeetle stores
accounting truth, and the broker adapter performs account-environment-neutral execution.

There is one active strategy: `intraday-momentum` using `bayn.intraday-momentum.protocol.v2`. Historical strategy
rows remain decodable for audit and reconciliation, but they are not runtime fallbacks and cannot create new cycles.

## Active strategy

Each regular session, after a 60-minute warmup and until 60 minutes before the close, Bayn evaluates the latest fully
elapsed 30-minute IEX window. It compares AAPL, AMZN, IWM, NVDA, QQQ, and SMH against SPY and requires:

- positive candidate momentum and non-negative SPY momentum;
- at least 10 basis points of excess momentum;
- a top-quartile location in the rolling range;
- a spread no wider than 5 basis points; and
- complete bars plus fresh executable quotes and trades.

The strategy selects at most one long position and caps it at 10% of the mandate allocation. A valid `NO_TRADE` is a
normal decision; absent or late market data is a lifecycle blocker, not a strategy result. New entries use whole-share
IOC limit orders at an adverse verified quote boundary. Bayn starts flattening 30 minutes before the close and must be
flat 15 minutes before the close.

The protocol, universe, thresholds, feed contract, and execution model are source-controlled TypeScript. The image
embeds and verifies the source revision and the behavior, parameter, protocol, and risk-policy hashes.

## Execution contract

- `BAYN_BROKER_ACCESS` and `BAYN_CAPITAL_AUTHORITY` are static capability ceilings. Effective execution additionally
  requires an exact durable grant bound to the source, image, strategy, account, and risk policy.
- Sandbox and live accounts use the same decisions, intents, risk checks, reconciliation, recovery, and mutation code.
  Only broker configuration and the durable grant differ.
- Every intent, client-order ID, risk decision, and mutation transition is committed before broker I/O. Unknown broker
  outcomes block new exposure until deterministic lookup and reconciliation resolve them.
- Execution is long-only. Sells cannot exceed reconciled inventory. Entry, gross exposure, turnover, loss, drawdown,
  cutoff, and stale-data limits fail closed.
- PostgreSQL and TigerBeetle must reconcile exactly. Any identity drift, unresolved mutation, stale data, duplicate
  controller, or accounting discrepancy blocks new orders.

## Runtime architecture

- `BaynExecutionController` is the only scheduler. Restate serializes handlers by canonical account-binding hash,
  persists timers and retries, and resumes after worker replacement.
- The execution worker runs one bounded `advanceExecutionOnce` pass per tick. Restate is not treated as broker
  exactly-once delivery; durable intents and deterministic IDs remain the external-side-effect boundary.
- PostgreSQL is the authoritative cycle, grant, intent, mutation, reconciliation, and controller-status ledger.
- TigerBeetle is the authoritative fee, cost-basis, cash, and realized-P&L ledger.
- The public Bayn deployment serves read-only status and health. It does not schedule execution or hold mutation
  authority.
- Broker egress is restricted to the configured Alpaca endpoint through the dedicated CONNECT proxy. Credentials and
  plaintext account identity must never appear in logs, metrics, traces, or status responses.

## Market data

Alpaca WebSocket events flow through Kafka and the Dorvud/Flink archive into ClickHouse. Bayn reads the retained
`intraday_bars_1m_v2`, `intraday_quotes_v1`, and `intraday_trades_v1` tables with a read-only identity. Each decision
binds exact topic watermarks, content hashes, session calendar, universe, feed, observation window, and freshness
limits. Bayn owns no ClickHouse DDL or backfill path.

## Operations

Normal delivery is immutable and automatic:

1. merge reviewed source to `main`;
2. build and publish the exact multi-architecture image;
3. advance the generated `codex/bayn-deploy` pins when activation identity is valid; and
4. let Argo reconcile the status service, execution worker, and source-versioned activation hook.

Do not deploy directly or submit a broker order manually. A strategy-identity change requires a new reviewed durable
activation; an ordinary code-only release preserves the existing exact grant lineage.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency and execution-readiness projection.
- `GET /v1/status`: bounded controller, strategy, authority, cycle, reconciliation, accounting, build, and blocker
  state.

## Validation

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn test:postgres
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn lint:oxlint
bun run --filter @proompteng/bayn build
```

PostgreSQL tests require an isolated database whose name ends in `_test`; never point them at a live Bayn database.
Historical development candidates are terminal, non-executable records summarized in
[`docs/bayn/candidate-terminal-history.md`](../../docs/bayn/candidate-terminal-history.md).
