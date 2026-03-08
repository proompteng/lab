# 33. Alpaca Options Market-Data and Technical Analysis Lane (2026-03-08)

## Status

- Date: `2026-03-08`
- Maturity: `implementation-ready design`
- Scope: `services/dorvud/websockets/**`, `services/dorvud/technical-analysis/**`,
  `argocd/applications/torghut/**`, `argocd/applications/kafka/**`, Torghut Postgres/ClickHouse/Kafka, and the live
  `torghut` / `kafka` clusters
- Primary objective: add a production options ingest and technical-analysis lane sourced from Alpaca without disturbing
  the live equity lane
- Non-goals: options order routing, assignment/exercise workflows, portfolio accounting changes, or a generalized
  multi-asset runtime refactor

## Executive Summary

Torghut can already run a healthy equity market-data and technical-analysis lane, but the current runtime, Kafka
contracts, and Jangar registry are all equity-shaped. The next options build slice therefore must not be "teach the
existing equity lane a few new symbols." It needs a separate options lane with its own websocket service, enrichment
service, Kafka user, Flink job, and derived analytics contracts.

The selected design is:

- phase 1 is ingest plus technical analysis only;
- options run as a separate lane, not as a shared multi-asset retrofit inside `torghut-ws` or `torghut-ta`;
- the lane targets the maximum Alpaca breadth that is operationally credible by combining full contract discovery with
  hot-set websocket subscription rotation;
- Alpaca websocket is only the hot path for trades and quotes, while REST remains mandatory for contracts, snapshots,
  and historical bars.

This keeps the current equity production path isolated, contains operational blast radius, and gives Torghut an
implementation-ready plan for options-native analytics instead of an equity clone with option tickers pasted on top.

## Context

Torghut's current market-data platform is valuable because it already proves the shape of the production system:
websocket ingress, Kafka buffering, Flink-based technical analysis, and ClickHouse-derived analytics. Adding options is
strategically attractive because it expands the opportunity set for the quant system, but options are not "more
symbols." They introduce contract lifecycle churn, Greeks and IV surfaces, much larger breadth, and strict feed limits.

Alpaca's current options interfaces make that boundary explicit:

- real-time options websocket uses `v1beta1/{feed}` and is MsgPack-only;
- the websocket supports trades and quotes, not option bars;
- quote wildcard subscription is forbidden, so full-chain streaming is not achievable by a single naive subscription
  pattern;
- contract discovery, snapshots, chains, and historical bars remain REST responsibilities.

That means the production design must optimize for two things at once:

1. keep a truthful hot path for the most relevant contracts, and
2. maintain a broader cold path so the system still understands the rest of the discoverable universe.

## Verified Current State

### Live cluster state on `2026-03-08`

The current production baseline is healthy but equity-only:

- `kubectl -n argocd get application torghut kafka torghut-forecast -o wide` shows `torghut`, `kafka`, and
  `torghut-forecast` all `Synced` and `Healthy`.
- `kubectl -n torghut get deploy torghut-ws torghut-ta -o wide` shows both live market-data deployments at `1/1`
  available.
- `kubectl -n torghut get flinkdeployment torghut-ta -o yaml` shows `status.lifecycleState=STABLE` and
  `jobStatus.state=RUNNING`.
- `kubectl logs -n torghut deploy/torghut-ta --tail=120` shows repeated completed checkpoints on `2026-03-08`, so the
  current TA lane is not stalled.
- `kubectl exec -n torghut chi-torghut-clickhouse-default-0-0-0 -- clickhouse-client ...` shows
  `torghut.ta_microbars` and `torghut.ta_signals` both last updated at `2026-03-06 21:59:08 UTC`, which on a Sunday is
  weekend/session lag rather than evidence that the live Flink job has failed.

### Current websocket runtime is hard-coded for equity and crypto only

[`services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderConfig.kt`](services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderConfig.kt)
defines `AlpacaMarketType` as only `EQUITY` or `CRYPTO`, and the allowed channel sets are equity/crypto-specific. The
same file defaults topics to `torghut.trades.v1`, `torghut.quotes.v1`, `torghut.bars.1m.v1`, and `torghut.status.v1`.
No options market type or options topic family exists in the current runtime config model.

[`argocd/applications/torghut/ws/configmap.yaml`](argocd/applications/torghut/ws/configmap.yaml) confirms the live
deployment is explicitly equity-scoped:

- `ALPACA_MARKET_TYPE=equity`
- `ALPACA_MARKET_DATA_CHANNELS=trades,quotes,bars,updatedBars`
- `JANGAR_SYMBOLS_URL=...assetClass=equity...`

That means the currently deployed websocket runtime cannot be extended to options by configuration only.

### Current Kafka and TA contracts have no options lane

[`argocd/applications/kafka/torghut-topics.yaml`](argocd/applications/kafka/torghut-topics.yaml) defines only the
existing equity and Lean topics:

- `torghut.trades.v1`
- `torghut.quotes.v1`
- `torghut.bars.1m.v1`
- `torghut.status.v1`
- `torghut.trade-updates.v1`
- `torghut.ta.bars.1s.v1`
- `torghut.ta.signals.v1`
- `torghut.ta.status.v1`
- `torghut.lean.shadow.v1`
- `torghut.lean.backtests.v1`

Live Kafka state matches the manifests: `kubectl -n kafka get kafkatopic,kafkauser` shows no options topics and only
`KafkaUser/torghut-ws` for the Torghut market-data path.

[`argocd/applications/torghut/ta/configmap.yaml`](argocd/applications/torghut/ta/configmap.yaml) wires the live Flink
job to the equity topics only:

- `TA_TRADES_TOPIC=torghut.trades.v1`
- `TA_QUOTES_TOPIC=torghut.quotes.v1`
- `TA_BARS1M_TOPIC=torghut.bars.1m.v1`
- `TA_MICROBARS_TOPIC=torghut.ta.bars.1s.v1`
- `TA_SIGNALS_TOPIC=torghut.ta.signals.v1`

There is no current options-specific data contract to preserve or extend.

### Current Jangar symbol registry is not a safe contract catalog

[`services/jangar/src/server/migrations/20251228_init.ts`](services/jangar/src/server/migrations/20251228_init.ts)
creates `torghut_symbols` with `symbol TEXT PRIMARY KEY` and `asset_class TEXT NOT NULL DEFAULT 'equity'`. That schema
is adequate for the current equity universe feed, but it is not a safe authority for contract-level options catalog
state. Phase 1 must therefore use a separate options catalog in Torghut-owned state, not an overloaded reuse of the
existing Jangar symbol table.

## Design Decision

The design is intentionally conservative at the control-plane boundary and aggressive at the analytics boundary.

### Decision 1: phase 1 scope is ingest plus technical analysis only

Phase 1 ends at durable raw options data plus derived options analytics. It does not include:

- order execution for options;
- assignment/exercise handling;
- option-aware capital allocation or risk engine changes;
- a user-facing strategy or portfolio surface.

This keeps the first implementation wave narrow enough to harden data truth before introducing financial behavior.

### Decision 2: options are a separate lane, not a multi-asset retrofit

The options path will be deployed as a new GitOps application, tentatively `argocd/applications/torghut-options`,
within the existing `torghut` namespace. Keeping the namespace the same preserves access to Kafka, Postgres,
ClickHouse, and shared observability surfaces without introducing new cross-namespace secret plumbing, while still
isolating the options lane behind separate workloads, Kafka topics, and credentials.

The equity workloads `torghut-ws` and `torghut-ta` are not modified in phase 1.

### Decision 3: target maximum Alpaca breadth with full discovery plus hot-set rotation

The universe target is "max credible Alpaca breadth," not "subscribe to everything live." Full contract discovery is
handled by REST pagination over the active catalog. Streaming focus is then determined by a ranked hot set that rotates
subscriptions based on liquidity, recency, spread quality, DTE, moneyness, and underlying activity. Contracts outside
the hot set remain visible through snapshot and bar enrichment rather than being silently dropped from the system.

### Decision 4: default production feed is `opra`

`opra` is the default production feed. `indicative` can exist as a degraded or non-production fallback, but the
production design is optimized for real OPRA options market data rather than for a permanently reduced feed.

## Selected Architecture

### Control-plane and data-plane layout

The selected runtime introduces four new components and one new Kafka principal:

| Component | Type | Responsibility | Failure containment |
| --- | --- | --- | --- |
| `torghut-options-catalog` | `Deployment` | Poll Alpaca contract catalog, page the active universe, persist catalog/subscription state in Postgres, emit contract records | Contract discovery can lag without interrupting live equity trading |
| `torghut-ws-options` | `Deployment` | Maintain the active Alpaca options websocket session, decode MsgPack payloads, publish trades/quotes/status | Websocket faults are isolated from equity `torghut-ws` |
| `torghut-options-enricher` | `Deployment` | Poll REST snapshots, chain snapshots, latest quotes, and historical bars for cold-path coverage and backfill | REST throttling does not take down raw websocket ingest |
| `torghut-options-ta` | `FlinkDeployment` | Consume raw options topics, build contract bars/features and surface features, publish derived topics, write ClickHouse | Options TA failure does not block equity TA |
| `torghut-options` | `KafkaUser` | Dedicated principal for options produce/consume flows | Credentials are not shared with the equity lane |

### End-to-end flow

1. `torghut-options-catalog` paginates Alpaca `GET /v2/options/contracts`, normalizes active contracts, and stores the
   authoritative options catalog in Postgres.
2. The catalog service emits `torghut.options.contracts.v1` and continuously recomputes the websocket hot set.
3. `torghut-ws-options` authenticates to Alpaca's options websocket, subscribes to trades and quotes for the hot set,
   and publishes raw events plus status telemetry.
4. `torghut-options-enricher` fills the gaps that websocket cannot cover by polling snapshots, chain snapshots, latest
   quotes, and historical bars.
5. `torghut-options-ta` joins the raw streams into options-native analytics and writes both Kafka outputs and
   ClickHouse tables.

### Component behavior details

#### `torghut-options-catalog`

- Poll interval is session-aware: fast during market hours, slower overnight/weekends, and faster near expiry rolls.
- Stores contract identity, underlying symbol, expiry, strike, right, multiplier, status, and last-seen timestamps.
- Owns subscription ranking state and backoff/rate-limit watermarks.
- Emits status snapshots when discovery completeness or freshness falls below SLO.

#### `torghut-ws-options`

- Uses Alpaca `v1beta1/{feed}` websocket with MsgPack decoding.
- Subscribes only to trades and quotes because options bars are not available on the websocket feed.
- Defaults to one active session in phase 1 to stay compatible with conservative account connection assumptions.
- Accepts rotating subscription plans from the catalog service rather than discovering symbols locally.
- Emits explicit status records for auth failures, symbol-limit pressure, reconnect loops, and subscription churn.

#### `torghut-options-enricher`

- Owns all REST-only responsibilities so websocket code stays latency-focused.
- Polls snapshots for hot and warm contracts, plus lower-frequency sweeps for the broader catalog.
- Retrieves historical option bars when Kafka retention is insufficient for replay or gap repair.
- Writes enrichment watermarks into Postgres so backfills and restarts are resumable and rate-limit aware.

#### `torghut-options-ta`

- Consumes raw contracts, trades, quotes, snapshots, and status topics.
- Builds 1-second contract bars from trade/quote state, including mark and mid-derived values even when no trade prints
  occur in a window.
- Produces contract-level features such as spread basis points, quote imbalance, trade intensity, realized volatility,
  IV/Greek deltas, DTE, and moneyness.
- Produces underlying-level surface features such as ATM IV, skew, and term-structure slope.
- Preserves exactly-once semantics and externalized checkpoints, matching the operational model of the current equity TA
  lane.

## Interfaces and Data Contracts

### External Alpaca interfaces

The implementation relies on the current official Alpaca options interfaces:

- websocket: [Real-time Option Data](https://docs.alpaca.markets/docs/real-time-option-data)
- stream protocol: [WebSocket Stream](https://docs.alpaca.markets/docs/streaming-market-data)
- contracts: [Get Option Contracts](https://docs.alpaca.markets/reference/get-options-contracts)
- option chain: [Option Chain](https://docs.alpaca.markets/reference/optionchain)
- snapshots: [Option Snapshots](https://docs.alpaca.markets/reference/optionsnapshots)
- historical bars: [Option Bars](https://docs.alpaca.markets/v1.3/reference/optionbars)

### Kafka topics

The options lane introduces the following public Kafka contracts:

| Topic | Producer | Key | Purpose |
| --- | --- | --- | --- |
| `torghut.options.contracts.v1` | `torghut-options-catalog` | `contract_symbol` | Contract catalog events and status transitions |
| `torghut.options.trades.v1` | `torghut-ws-options` | `contract_symbol` | Raw option trades from websocket |
| `torghut.options.quotes.v1` | `torghut-ws-options` | `contract_symbol` | Raw option quotes from websocket |
| `torghut.options.snapshots.v1` | `torghut-options-enricher` | `contract_symbol` | REST snapshot and enrichment state |
| `torghut.options.status.v1` | catalog, websocket, enricher | `component` | Component health, rate-limit, freshness, and degraded-mode signals |
| `torghut.options.ta.contract-bars.1s.v1` | `torghut-options-ta` | `contract_symbol` | Contract-level 1-second bars with mark/mid context |
| `torghut.options.ta.contract-features.v1` | `torghut-options-ta` | `contract_symbol` | Derived contract-level technical and microstructure features |
| `torghut.options.ta.surface-features.v1` | `torghut-options-ta` | `underlying_symbol` | Derived underlying-level surface metrics |
| `torghut.options.ta.status.v1` | `torghut-options-ta` | `component` | Flink job status, watermark lag, and output health |

### ClickHouse tables

ClickHouse stores derived analytics only. The planned tables are:

| Table | Grain | Notes |
| --- | --- | --- |
| `options_contract_bars_1s` | one row per contract per second | Stores microbars, mark, mid, count, size, and derived liquidity context |
| `options_contract_features` | one row per contract per feature window | Stores realized vol, spread, imbalance, IV/Greek deltas, DTE, moneyness, and related derived features |
| `options_surface_features` | one row per underlying per timestamp/window | Stores ATM IV, skew, term slope, breadth, and cross-contract surface summaries |

### Postgres-owned state

Postgres is the control-plane source of truth for:

- the discovered contract catalog;
- subscription ranking and hot-set membership;
- REST pagination cursors and backfill watermarks;
- rate-limit and freshness state for operational decisions.

This state is separate from Jangar's current `torghut_symbols` table.

## Storage and Retention

### Kafka sizing

The current Kafka cluster is a three-broker Strimzi deployment with three `30Gi` PVCs. The initial options sizing
therefore assumes the existing cluster footprint rather than a future expansion.

Recommended topic defaults:

- `torghut.options.trades.v1` and `torghut.options.quotes.v1`: `12` partitions, replication factor `3`,
  `compression.type=lz4`, `retention.ms=172800000` (`48h`)
- `torghut.options.contracts.v1`: `6` partitions, replication factor `3`, `cleanup.policy=compact,delete`,
  `retention.ms=2592000000` (`30d`)
- `torghut.options.snapshots.v1`: `6` partitions, replication factor `3`, `cleanup.policy=compact,delete`,
  `retention.ms=604800000` (`7d`)
- `torghut.options.status.v1`: `6` partitions, replication factor `3`, `cleanup.policy=compact,delete`,
  `retention.ms=604800000` (`7d`)
- derived TA topics: `6` partitions, replication factor `3`, `compression.type=lz4`, `retention.ms=604800000` (`7d`)

Historical replay older than Kafka retention is satisfied by Alpaca REST bars plus the persisted Postgres catalog and
watermarks, not by trying to stretch Kafka into a long-term archive.

### ClickHouse retention

Recommended initial TTLs:

- `options_contract_bars_1s`: `14d`
- `options_contract_features`: `14d`
- `options_surface_features`: `30d`

These TTLs are intentionally shorter than raw research storage ambitions. Phase 1 is about operational alpha features,
not permanent tick warehousing.

## Failure Modes and Ops

### Operational constraints

The design treats the following as hard constraints, not implementation suggestions:

- Alpaca options websocket is not the entire solution; REST contracts, snapshots, and historical bars remain required.
- Weekend and holiday freshness must be session-aware, because a Sunday lag from Friday close is expected behavior.
- Jangar's current symbol table cannot be used as the contract registry.
- Equity production services, topics, and credentials must remain isolated from the options lane.

### Primary failure modes

#### Alpaca feed and protocol failures

- auth failure
- feed unavailable or degraded
- MsgPack decode failure
- unsupported subscription request
- contract no longer active

The runtime must surface Alpaca `405`, `406`, `410`, `412`, and `413` conditions explicitly in
`torghut.options.status.v1` and in service metrics instead of collapsing them into generic reconnect noise.

#### Subscription saturation and churn

Because quote wildcard subscription is forbidden, the hot set will sometimes exceed what the current account/feed can
stream comfortably. The system therefore needs:

- a deterministic ranking function;
- bounded rotation cadence;
- backpressure metrics for dropped or deferred contracts;
- a degraded mode that preserves truthful status rather than pretending full coverage.

#### REST throttling and backfill lag

REST enrichment can fall behind independently of websocket health. The design keeps enrichment in its own deployment so
throttling, pagination, or snapshot drift cannot directly destabilize the websocket hot path.

#### Expiry and catalog churn

Options contracts disappear, roll, and become stale faster than equities. The catalog service must mark contracts as
inactive explicitly and preserve enough history to support TA joins and replay across expiries without dangling foreign
keys or silent data reuse.

## Rollout Phases

### Phase 0: contracts and manifests

- define protobuf/JSON contracts for the new Kafka topics;
- add the new Strimzi topics and `KafkaUser/torghut-options`;
- add the new Argo CD application scaffolding for `torghut-options`;
- add Postgres schema objects for options catalog and watermark state.

### Phase 1: raw ingest

- implement `torghut-options-catalog`;
- implement `torghut-ws-options`;
- prove websocket auth, MsgPack decode, hot-set rotation, and status emission;
- keep equity workloads untouched.

### Phase 2: enrichment

- implement `torghut-options-enricher`;
- add snapshot, chain, and historical-bar backfill logic;
- prove restart-resumable watermarks and rate-limit handling.

### Phase 3: technical analysis

- implement `torghut-options-ta`;
- write the three ClickHouse tables and derived Kafka topics;
- prove exactly-once recovery and contract/surface feature correctness on real replay windows.

### Phase 4: hardening and admission

- define freshness SLOs by session state;
- add alerts and dashboards for catalog lag, subscription saturation, REST backlog, and Flink watermark drift;
- require repeated healthy sessions before any later strategy or execution work is approved.

## Acceptance Criteria

This design is complete only when the implementation plan can satisfy all of the following:

1. Torghut has a separate options lane with the four named components:
   `torghut-options-catalog`, `torghut-ws-options`, `torghut-options-enricher`, and `torghut-options-ta`.
2. The live equity lane remains operationally isolated: no shared options credentials, no mutation of existing equity
   topics, and no regression in `torghut-ws` or `torghut-ta`.
3. Full contract discovery works against Alpaca's active options catalog, while websocket coverage is determined by a
   deterministic hot-set rotation policy rather than by silent truncation.
4. The raw Kafka contracts exist exactly as defined in this document, and the derived TA contracts exist exactly as
   defined in this document.
5. ClickHouse stores `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` with
   session-aware freshness expectations.
6. The system handles Alpaca `405`, `406`, `410`, `412`, and `413` conditions explicitly and observably.
7. Replay older than Kafka retention is possible through Alpaca REST plus persisted Postgres watermarks.
8. Weekend and holiday sessions report truthful degraded freshness instead of false incident noise.
9. No implementation artifact claims that the current Torghut source tree already supports options, because it does not.
