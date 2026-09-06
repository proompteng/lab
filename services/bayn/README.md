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

Quotes, trades, and finalized bars ingested beyond their declared delay limits remain invalid. Entry and flattening
wait for a subsequently captured, fully verified snapshot within their existing deadlines. An invalid historical bar
remains invalid while it is in the rolling window; waiting only helps once a compliant window is available. Premature
feed evidence, non-final bars, and unclassified freshness violations remain errors. Historical replay uses the same
retry classification and retains every rejected observation.

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

The read-only forward-performance command can isolate one durable mandate. Take the exact
`capitalActivation.generationHash` from `/v1/status` when `capitalActivation._tag` is `Realized`, and run it in the
configured runtime:

```sh
node dist/forward-performance-command.js --authority-generation <generation-hash>
```

Without that option, the command evaluates account history, which may span retired strategies and mandates.
Malformed or ambiguous arguments fail before configuration or evidence reads. A generation-scoped receipt still
requires completed executions and exact accounting; operational readiness and an active research mandate do not
establish profitability.

A standing mandate's next scheduled cycle does not make the reconciled performance window incomplete while its
submission window is still in the future and it has no durable decision or intent. Blocked cycles, started cycles,
and any future cycle with durable execution work still prevent a sufficient receipt.

## Historical intraday replay

`bayn-intraday-replay --input <path>` evaluates finalized sessions from an exported Alpaca calendar against the retained
intraday archive. It reads only ClickHouse using `BAYN_CLICKHOUSE_URL`, `BAYN_CLICKHOUSE_USERNAME`, and
`BAYN_CLICKHOUSE_PASSWORD`. The command has no broker mutation, PostgreSQL, TigerBeetle, or capital-grant capability.
Run `bun run --filter @proompteng/bayn build` for the local equivalent:

```sh
node services/bayn/dist/intraday-replay-command.js --input replay-input.json > replay-report.json
```

The input declares the calendar range, capital, and execution assumptions before the run. For example, after exporting
the exact calendar response for this date range:

```json
{
  "schemaVersion": "bayn.intraday-replay-input.v1",
  "range": { "start": "2026-09-04", "end": "2026-09-04" },
  "calendar": [{ "date": "2026-09-04", "open": "09:30", "close": "16:00" }],
  "initialCapitalMicros": "100000000000",
  "allocationCapitalMicros": "100000000000",
  "assumptions": {
    "pollIntervalMs": 30000,
    "firstPollDelayMs": 2000,
    "orderLatencyMs": 100,
    "availableLiquidityPpm": 1000000,
    "slippageBps": 0,
    "feeMultiplierPpm": 1000000
  }
}
```

The range is bounded to 31 calendar days. Preserve the complete calendar response; archive date presence cannot
establish that a session was open or that its data is complete. Each scheduled observation captures its own archive
watermarks with event and ingestion times bounded by that observation. The report retains the manifests for decision,
planning, and arrival quotes, as well as data failures, canceled IOC quantities, fees, cash, and unclosed positions.

The fill model uses whole shares, the opposite arrival quote, a declared share of displayed liquidity, and adverse
slippage. A modeled price beyond the submitted limit cancels the order. Zero added slippage still includes crossing
the quoted spread and the protocol's fees. `feeMultiplierPpm` scales the fees before their normal rounding. Execution
assumptions describe a counterfactual; they do not measure queue position or actual broker fills.

Every report is `COUNTERFACTUAL_RESEARCH` and `NOT_QUALIFIED`, including a positive result. A report does not create a
qualification, change a strategy, activate capital, or replace the forward-performance receipt. Use a declared
chronological holdout and sufficient independent sessions before drawing a profitability conclusion; inspect the
report's limitations and incomplete sessions rather than selecting only favorable dates or assumptions.

## Vendor historical research

`bayn-vendor-intraday-replay --input <path> --cache <directory>` evaluates a frozen historical experiment using Alpaca
IEX history. It shares the active strategy's decision, sizing, IOC, and fee arithmetic. It reads market data and writes
the explicitly named local cache; it has no broker mutation or capital-grant capability.

```sh
node services/bayn/dist/vendor-intraday-replay-command.js \
  --input vendor-input.json --cache ./vendor-cache > vendor-report.json
```

The input uses `bayn.vendor-intraday-replay-input.v1`. Supply the calendar, range, initial capital, and allocation
capital as above, with a range of at most 120 calendar days. Export the complete official calendar in requests of at
most 31 days before combining it. Additional required fields are:

- `experimentPlanHash`: the hash of the experiment plan frozen before inspecting evaluation prices or returns;
- `strategyProtocolHash`, `behaviorHash`, `parameterHash`, and `riskPolicyHash`: the frozen active identities, checked
  against the implementation before data reads; and
- `scenarios`: uniquely named `{ "name": "baseline", "assumptions": { ... } }` entries using the same explicit
  execution assumptions as archive replay. Preserve every declared scenario in the analysis.

The command uses `BAYN_ALPACA_KEY_ID`, `BAYN_ALPACA_SECRET_KEY`, and `BAYN_ALPACA_PROXY_URL` (default
`http://bayn-egress-proxy:3128`). Historical reads target only `data.alpaca.markets`, with IEX, session-date symbol
mapping, and raw one-minute bars. The client consumes every page, limits requests to 180 per minute, and verifies
cached query, raw-page, normalized-content, and pagination hashes before reuse. Quote and trade requests cover only
the protocol's freshness window at each observation; bars cover the bounded session decision range. Preserve the cache with the report
to retain its source evidence. Progress and failures go to stderr; stdout contains the final canonical JSON report.
Use one writer per cache directory. A checksum mismatch stops the run; preserve that cache for diagnosis and use a
new directory for a fresh capture. Do not overwrite corrupt evidence and present it as the original capture.

Vendor history proves event-time observations and completed provider queries. It cannot prove when a production
consumer received a record, whether a historical bar was later revised, or which immutable archive version existed
at a simulated decision. Vendor evidence therefore has its own provenance hash and never receives archive snapshot,
ingestion-time, or Kafka identities.

`quoteSizePolicy: native-unit-share-cap.v1` preserves the active strategy's capacity arithmetic: one modeled share
per provider-native quote-size unit, before the scenario's liquidity reduction. This is a conservative capacity
assumption, not a verified round-lot conversion. Preserve raw sizes and resolve the feed's unit contract before
using results as execution-readiness evidence. IEX quotes describe one exchange; they do not prove consolidated
liquidity or broker fills. Trade confirmation uses raw historical trades, not the latest-trades endpoint's
bar-forming condition filter.

Each scenario carries cash and positions chronologically. Planning and arrival prices are separate observations;
unfilled IOC orders stay canceled and incomplete flattening retains the residual position. Long inventory is valued
at verified adverse bids on the declared 30-second schedule. Reports retain observed equity, loss, peak, and drawdown,
including excursions followed by recovery. Missing mark evidence makes the economic path incomplete. Observed
drawdown can miss excursions between samples and cannot establish continuous live risk compliance.

These reports remain `COUNTERFACTUAL_RESEARCH` / `NOT_QUALIFIED`. Keep retrospective development exposure, all tested
alternatives, costs, canceled orders, and incomplete sessions visible. Positive historical returns do not replace
independent prospective execution evidence or grant trading authority.

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
