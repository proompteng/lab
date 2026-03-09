# 34. Alpaca Options Lane Implementation Contract Set (2026-03-08)

## Status

- Date: `2026-03-08`
- Maturity: `implementation contract`
- Scope: `services/dorvud/websockets/**`, `services/dorvud/technical-analysis/**`, `argocd/applications/kafka/**`,
  `argocd/applications/torghut/**`, Torghut Postgres, Torghut ClickHouse, Karapace, and live Kafka credentials
- Depends on: `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
- Primary objective: turn the selected options-lane architecture into concrete event, storage, config, and operating
  contracts that engineers can implement without re-opening first-order design questions

## Context

Document 33 selects the production architecture: a separate options lane with catalog discovery, websocket ingest, REST
enrichment, and a dedicated Flink technical-analysis path. That is the correct architectural boundary, but it is not
yet an implementation contract.

Without a follow-on contract set, engineers would still have to improvise:

- which topic family uses Torghut's existing `Envelope<T>` convention and which does not;
- which fields are required in raw and derived options payloads;
- which Postgres tables own the options control plane;
- which ClickHouse table shapes preserve the current replicated TA pattern;
- how subscription ranking, REST budgets, and session-aware SLOs are computed;
- which secrets and service identities are allowed to be shared and which must be isolated.

This document closes that gap.

## Decision

The implementation contract is:

1. raw options topics use Torghut's existing `Envelope<T>` transport convention and JSON serialization;
2. derived options TA topics use the same flattened Avro-plus-schema-registry pattern as the current equity TA lane;
3. Postgres, not Jangar, owns the options catalog, subscription state, and REST watermarks;
4. ClickHouse uses replicated replacing-merge-tree tables with the same partitioning and ordering style as
   `ta_microbars` and `ta_signals`;
5. subscription breadth is controlled by a deterministic ranking contract and a provider-cap measurement loop, not by
   hard-coded symbol lists;
6. every component gets a lane-specific identity and secret surface, except for explicitly shared infrastructure
   credentials such as the checkpoint object-store secret.

## Contract Set

### 1. Transport standard

All raw options topics use the existing Torghut envelope defined in
[`services/dorvud/platform/src/main/kotlin/ai/proompteng/dorvud/platform/Envelope.kt`](services/dorvud/platform/src/main/kotlin/ai/proompteng/dorvud/platform/Envelope.kt).

Required envelope fields:

| Field | Type | Rule |
| --- | --- | --- |
| `ingestTs` | ISO-8601 instant | time the producer accepted the event |
| `eventTs` | ISO-8601 instant | provider event time or normalized source event time |
| `feed` | string | `opra` or `indicative` |
| `channel` | string | topic-specific logical channel such as `trade`, `quote`, `contract`, `snapshot`, `status` |
| `symbol` | string | contract symbol for contract-level topics, underlying symbol for surface topics, component name for status topics |
| `seq` | long | producer-local monotonic sequence scoped to producer instance |
| `payload` | object | topic payload contract from this document |
| `accountLabel` | nullable string | copied only when the source truly has account scope; absent for public market data |
| `isFinal` | boolean | `true` for immutable raw events, `false` only for interim status or partial windows |
| `source` | string | `ws`, `rest`, `catalog`, or `flink` |
| `window` | nullable object | required only for derived windowed outputs |
| `version` | int | schema version, starts at `1` |

Contract rule:

- raw topics are JSON-serialized envelopes;
- derived TA topics register flattened Avro schemas in Karapace and may optionally emit JSON only in local debug mode;
- no raw topic in the options lane is allowed to bypass the envelope on the wire;
- every derived topic must preserve envelope semantics by carrying the envelope fields explicitly in flattened form.

### 2. Raw Kafka payload contracts

#### `torghut.options.contracts.v1`

Key: `contract_symbol`

Payload record: `options_contract_v1`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `contract_id` | string | yes | Alpaca contract `id` |
| `contract_symbol` | string | yes | Alpaca contract `symbol`; must equal envelope `symbol` |
| `name` | string | no | provider display name |
| `status` | string | yes | `active`, `inactive`, `expired`, `unknown` |
| `tradable` | boolean | yes | copied from provider when available |
| `expiration_date` | date | yes | UTC date |
| `root_symbol` | string | yes | contract root |
| `underlying_symbol` | string | yes | underlying equity symbol |
| `underlying_asset_id` | nullable string | no | provider asset id |
| `option_type` | string | yes | `call` or `put` |
| `style` | string | yes | `american`, `european`, or `unknown` |
| `strike_price` | decimal(18,6) | yes | canonical strike |
| `contract_size` | int | yes | parsed from provider `size`, defaults to `100` if absent |
| `open_interest` | nullable bigint | no | most recent provider value |
| `open_interest_date` | nullable date | no | date aligned with `open_interest` |
| `close_price` | nullable decimal(18,6) | no | latest provider close |
| `close_price_date` | nullable date | no | date aligned with `close_price` |
| `first_seen_ts` | timestamptz | yes | first discovery timestamp |
| `last_seen_ts` | timestamptz | yes | latest discovery timestamp |
| `provider_updated_ts` | nullable timestamptz | no | when the source API indicates a last update |
| `catalog_status_reason` | nullable string | no | inactive/expired rationale for operators |
| `schema_version` | int | yes | fixed at `1` |

Semantics:

- every active contract discovered by the catalog must appear here;
- inactive and expired transitions must also emit here so downstream stores can tombstone state truthfully;
- no service may infer the catalog from trades alone.

#### `torghut.options.trades.v1`

Key: `contract_symbol`

Payload record: `options_trade_v1`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `contract_symbol` | string | yes | must equal envelope `symbol` |
| `underlying_symbol` | string | yes | denormalized for consumer convenience |
| `price` | double | yes | trade price |
| `size` | double | yes | contracts traded |
| `exchange` | nullable string | no | venue/exchange code when present |
| `trade_id` | nullable string | no | provider trade identifier if present |
| `conditions` | nullable array<string> | no | provider conditions codes |
| `tape` | nullable string | no | provider tape when present |
| `participant_ts` | timestamptz | yes | trade timestamp from provider |
| `receipt_ts` | timestamptz | yes | normalized producer receipt timestamp |
| `schema_version` | int | yes | fixed at `1` |

Semantics:

- `eventTs` must equal `participant_ts`;
- `receipt_ts` may differ from `ingestTs` only if the producer records an explicit provider receipt timestamp;
- the producer must not synthesize trades from snapshots or bars.

#### `torghut.options.quotes.v1`

Key: `contract_symbol`

Payload record: `options_quote_v1`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `contract_symbol` | string | yes | must equal envelope `symbol` |
| `underlying_symbol` | string | yes | denormalized for consumer convenience |
| `bid_price` | double | yes | current bid |
| `bid_size` | double | yes | current bid size |
| `ask_price` | double | yes | current ask |
| `ask_size` | double | yes | current ask size |
| `bid_exchange` | nullable string | no | venue code when present |
| `ask_exchange` | nullable string | no | venue code when present |
| `quote_condition` | nullable string | no | provider quote condition if present |
| `participant_ts` | timestamptz | yes | quote timestamp from provider |
| `receipt_ts` | timestamptz | yes | normalized producer receipt timestamp |
| `schema_version` | int | yes | fixed at `1` |

Semantics:

- `eventTs` must equal `participant_ts`;
- quote payloads are immutable snapshots of provider quote events, not a mutable current-state document.

#### `torghut.options.snapshots.v1`

Key: `contract_symbol`

Payload record: `options_snapshot_v1`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `contract_symbol` | string | yes | must equal envelope `symbol` |
| `underlying_symbol` | string | yes | underlying equity symbol |
| `latest_trade_price` | nullable double | no | copied from latest trade |
| `latest_trade_size` | nullable double | no | copied from latest trade |
| `latest_trade_ts` | nullable timestamptz | no | copied from latest trade |
| `latest_bid_price` | nullable double | no | copied from latest quote |
| `latest_bid_size` | nullable double | no | copied from latest quote |
| `latest_ask_price` | nullable double | no | copied from latest quote |
| `latest_ask_size` | nullable double | no | copied from latest quote |
| `latest_quote_ts` | nullable timestamptz | no | copied from latest quote |
| `implied_volatility` | nullable double | no | provider IV |
| `delta` | nullable double | no | provider Greek |
| `gamma` | nullable double | no | provider Greek |
| `theta` | nullable double | no | provider Greek |
| `vega` | nullable double | no | provider Greek |
| `rho` | nullable double | no | provider Greek when available |
| `open_interest` | nullable bigint | no | provider open interest |
| `open_interest_date` | nullable date | no | date aligned with open interest |
| `mark_price` | nullable double | no | if provider returns a mark; otherwise null |
| `mid_price` | nullable double | no | computed as `(bid+ask)/2` when both sides are positive |
| `snapshot_class` | string | yes | `hot`, `warm`, `cold`, or `backfill` |
| `source_window_start_ts` | nullable timestamptz | no | backfill window start when applicable |
| `source_window_end_ts` | nullable timestamptz | no | backfill window end when applicable |
| `schema_version` | int | yes | fixed at `1` |

Semantics:

- this topic is the authoritative enrichment stream for IV, Greeks, and cold-path state;
- `mid_price` is computed by Torghut and must be null when bid or ask is absent/non-positive;
- `mark_price` must not be backfilled from `mid_price` unless clearly tagged in a future schema version.

#### `torghut.options.status.v1`

Key: `component`

Payload record: `options_status_v1`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `component` | string | yes | one of `catalog`, `ws`, `enricher` |
| `status` | string | yes | `ok`, `degraded`, `blocked`, `replaying` |
| `session_state` | string | yes | `pre`, `regular`, `post`, `closed`, `holiday`, `weekend` |
| `watermark_lag_ms` | nullable bigint | no | end-to-end lag for the component |
| `active_contracts` | nullable int | no | catalog count or current subscribed set size |
| `hot_contracts` | nullable int | no | current hot set size |
| `rest_backlog` | nullable int | no | pending REST work items |
| `error_code` | nullable string | no | Alpaca or internal code |
| `error_detail` | nullable string | no | operator-readable summary |
| `last_success_ts` | nullable timestamptz | no | last successful provider or sink interaction |
| `heartbeat` | boolean | yes | `true` for heartbeat/status frames |
| `schema_version` | int | yes | fixed at `1` |

Semantics:

- provider errors `405`, `406`, `410`, `412`, and `413` must surface here without normalization loss;
- `weekend` and `holiday` freshness degradation must use `status=ok` or `degraded` with truthful `session_state`, not
  `blocked`.

### 3. Derived TA topic contracts

Derived topics use flattened Avro schemas registered in Karapace, following the same pattern as
[`ta-bars-1s.avsc`](services/dorvud/technical-analysis/src/main/resources/schemas/ta-bars-1s.avsc) and
[`ta-signals.avsc`](services/dorvud/technical-analysis/src/main/resources/schemas/ta-signals.avsc).

#### `torghut.options.ta.contract-bars.1s.v1`

Record name: `OptionsContractBar1s`

Required flattened fields:

- envelope fields: `ingest_ts`, `event_ts`, `symbol`, `seq`, `is_final`, `source`, `window`, `version`
- price fields: `o`, `h`, `l`, `c`
- volume/count fields: `v`, `count`
- quote-derived fields: `bid_close`, `ask_close`, `mid_close`, `mark_close`
- microstructure fields: `spread_abs`, `spread_bps`, `bid_size_close`, `ask_size_close`
- contract identity fields: `underlying_symbol`, `expiration_date`, `strike_price`, `option_type`, `dte`

Contract rule:

- `symbol` is always the contract symbol;
- bar windows are `1s / 1s`;
- zero-trade windows may still emit if quotes are present and a `mid_close` or `mark_close` can be formed.

#### `torghut.options.ta.contract-features.v1`

Record name: `OptionsContractFeature`

Required flattened fields:

- envelope/window fields from the standard TA pattern
- identity fields: `underlying_symbol`, `expiration_date`, `strike_price`, `option_type`, `dte`, `moneyness`
- liquidity fields: `spread_abs`, `spread_bps`, `bid_size`, `ask_size`, `quote_imbalance`
- activity fields: `trade_count_w60s`, `notional_w60s`, `quote_updates_w60s`
- volatility fields: `realized_vol_w60s`, `implied_volatility`, `iv_change_w60s`
- Greek delta fields: `delta`, `delta_change_w60s`, `gamma`, `theta`, `vega`, `rho`
- mark/mid fields: `mid_price`, `mark_price`, `mid_change_w60s`, `mark_change_w60s`
- quality fields: `feature_quality_status`, `stale_quote`, `stale_snapshot`

Contract rule:

- this topic is the options analogue of `torghut.ta.signals.v1`, but it is explicitly options-native rather than a
  copy of equity momentum indicators;
- nullable feature fields are allowed only when the source data required to compute them is absent or stale.

#### `torghut.options.ta.surface-features.v1`

Record name: `OptionsSurfaceFeature`

Key: `underlying_symbol`

Required fields:

- envelope/window fields from the standard TA pattern, with `symbol` equal to the underlying symbol
- `underlying_symbol`
- `asof_contract_count`
- `atm_iv`
- `atm_call_iv`
- `atm_put_iv`
- `call_put_skew_25d`
- `call_put_skew_10d`
- `term_slope_front_back`
- `term_slope_front_mid`
- `surface_breadth`
- `hot_contract_coverage_ratio`
- `snapshot_coverage_ratio`
- `feature_quality_status`

Contract rule:

- this topic is emitted only when there is enough contract coverage to compute a meaningful surface;
- if coverage is insufficient, a status event must explain the degraded condition rather than emitting fabricated values.

#### `torghut.options.ta.status.v1`

Record name: `OptionsTaStatus`

Required fields:

- `component`
- `status`
- `watermark_lag_ms`
- `last_event_ts`
- `checkpoint_age_ms`
- `input_backlog`
- `schema_version`

Contract rule:

- this topic mirrors the intent of the current TA status topic and is the primary contract for alerting on Flink lag.

### 4. Schema evolution rules

The options lane may evolve, but only under these rules:

1. new fields must be additive and nullable or have a default;
2. field meaning may not be reused under the same name;
3. removing a field requires a topic version bump;
4. changing the key contract requires a topic version bump;
5. ClickHouse alias columns may be added for compatibility, but raw stored columns may not silently change type;
6. any schema-version increment must document producer, consumer, and replay compatibility explicitly.

## Storage Contracts

### 1. Postgres control-plane schema

The options lane introduces four Torghut-owned tables.

#### `torghut_options_contract_catalog`

```sql
CREATE TABLE torghut_options_contract_catalog (
  contract_symbol TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL UNIQUE,
  root_symbol TEXT NOT NULL,
  underlying_symbol TEXT NOT NULL,
  expiration_date DATE NOT NULL,
  strike_price NUMERIC(18, 6) NOT NULL,
  option_type TEXT NOT NULL CHECK (option_type IN ('call', 'put')),
  style TEXT NOT NULL CHECK (style IN ('american', 'european', 'unknown')),
  contract_size INT NOT NULL DEFAULT 100 CHECK (contract_size > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'expired', 'unknown')),
  tradable BOOLEAN NOT NULL DEFAULT true,
  open_interest BIGINT,
  open_interest_date DATE,
  close_price NUMERIC(18, 6),
  close_price_date DATE,
  provider_updated_ts TIMESTAMPTZ,
  first_seen_ts TIMESTAMPTZ NOT NULL,
  last_seen_ts TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX torghut_options_contract_catalog_underlying_idx
  ON torghut_options_contract_catalog (underlying_symbol, expiration_date, strike_price);

CREATE INDEX torghut_options_contract_catalog_status_idx
  ON torghut_options_contract_catalog (status, expiration_date);
```

#### `torghut_options_subscription_state`

```sql
CREATE TABLE torghut_options_subscription_state (
  contract_symbol TEXT PRIMARY KEY REFERENCES torghut_options_contract_catalog(contract_symbol) ON DELETE CASCADE,
  ranking_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  ranking_inputs JSONB NOT NULL DEFAULT '{}'::JSONB,
  tier TEXT NOT NULL CHECK (tier IN ('hot', 'warm', 'cold', 'off')),
  desired_channels TEXT[] NOT NULL DEFAULT ARRAY['trades', 'quotes']::TEXT[],
  subscribed_channels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  provider_cap_generation BIGINT NOT NULL DEFAULT 0,
  last_ranked_ts TIMESTAMPTZ NOT NULL,
  last_subscribe_attempt_ts TIMESTAMPTZ,
  last_subscribe_success_ts TIMESTAMPTZ,
  suppress_until_ts TIMESTAMPTZ,
  suppress_reason TEXT
);

CREATE INDEX torghut_options_subscription_state_tier_idx
  ON torghut_options_subscription_state (tier, ranking_score DESC);
```

#### `torghut_options_watermarks`

```sql
CREATE TABLE torghut_options_watermarks (
  component TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  cursor TEXT,
  last_event_ts TIMESTAMPTZ,
  last_success_ts TIMESTAMPTZ,
  next_eligible_ts TIMESTAMPTZ,
  retry_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY (component, scope_type, scope_key)
);
```

#### `torghut_options_rate_limit_state`

```sql
CREATE TABLE torghut_options_rate_limit_state (
  bucket_name TEXT PRIMARY KEY,
  observed_limit_per_minute INT,
  refill_per_second DOUBLE PRECISION NOT NULL,
  burst_capacity INT NOT NULL,
  tokens_available DOUBLE PRECISION NOT NULL,
  last_refill_ts TIMESTAMPTZ NOT NULL,
  last_429_ts TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);
```

Contract rule:

- Jangar's `torghut_symbols` table is out of scope for contract-level options state;
- only `torghut-options-catalog` and `torghut-options-enricher` may write these tables directly;
- `torghut-ws-options` reads subscription state but does not mutate the catalog.

### 2. ClickHouse analytics schema

The options ClickHouse tables follow the live replicated TA pattern shown by `ta_microbars` and `ta_signals`.

#### `options_contract_bars_1s`

```sql
CREATE TABLE torghut.options_contract_bars_1s
(
  contract_symbol LowCardinality(String),
  underlying_symbol LowCardinality(String),
  event_ts DateTime64(3, 'UTC'),
  seq UInt64,
  ingest_ts DateTime64(3, 'UTC'),
  is_final UInt8,
  source LowCardinality(String),
  window_size LowCardinality(String),
  window_step Nullable(String),
  window_start Nullable(DateTime64(3, 'UTC')),
  window_end Nullable(DateTime64(3, 'UTC')),
  version UInt32,
  expiration_date Date,
  strike_price Float64,
  option_type LowCardinality(String),
  dte Int32,
  o Float64,
  h Float64,
  l Float64,
  c Float64,
  v Float64,
  count UInt64,
  bid_close Nullable(Float64),
  ask_close Nullable(Float64),
  mid_close Nullable(Float64),
  mark_close Nullable(Float64),
  spread_abs Nullable(Float64),
  spread_bps Nullable(Float64),
  bid_size_close Nullable(Float64),
  ask_size_close Nullable(Float64)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/options_contract_bars_1s', '{replica}', ingest_ts)
PARTITION BY toDate(event_ts)
ORDER BY (contract_symbol, event_ts, seq)
TTL toDateTime(event_ts) + toIntervalDay(14)
SETTINGS index_granularity = 8192;
```

#### `options_contract_features`

```sql
CREATE TABLE torghut.options_contract_features
(
  contract_symbol LowCardinality(String),
  underlying_symbol LowCardinality(String),
  event_ts DateTime64(3, 'UTC'),
  seq UInt64,
  ingest_ts DateTime64(3, 'UTC'),
  is_final UInt8,
  source LowCardinality(String),
  window_size LowCardinality(String),
  window_step Nullable(String),
  window_start Nullable(DateTime64(3, 'UTC')),
  window_end Nullable(DateTime64(3, 'UTC')),
  version UInt32,
  expiration_date Date,
  strike_price Float64,
  option_type LowCardinality(String),
  dte Int32,
  moneyness Nullable(Float64),
  spread_abs Nullable(Float64),
  spread_bps Nullable(Float64),
  bid_size Nullable(Float64),
  ask_size Nullable(Float64),
  quote_imbalance Nullable(Float64),
  trade_count_w60s Nullable(UInt64),
  notional_w60s Nullable(Float64),
  quote_updates_w60s Nullable(UInt64),
  realized_vol_w60s Nullable(Float64),
  implied_volatility Nullable(Float64),
  iv_change_w60s Nullable(Float64),
  delta Nullable(Float64),
  delta_change_w60s Nullable(Float64),
  gamma Nullable(Float64),
  theta Nullable(Float64),
  vega Nullable(Float64),
  rho Nullable(Float64),
  mid_price Nullable(Float64),
  mark_price Nullable(Float64),
  mid_change_w60s Nullable(Float64),
  mark_change_w60s Nullable(Float64),
  stale_quote UInt8,
  stale_snapshot UInt8,
  feature_quality_status LowCardinality(String)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/options_contract_features', '{replica}', ingest_ts)
PARTITION BY toDate(event_ts)
ORDER BY (contract_symbol, event_ts, seq)
TTL toDateTime(event_ts) + toIntervalDay(14)
SETTINGS index_granularity = 8192;
```

#### `options_surface_features`

```sql
CREATE TABLE torghut.options_surface_features
(
  underlying_symbol LowCardinality(String),
  event_ts DateTime64(3, 'UTC'),
  seq UInt64,
  ingest_ts DateTime64(3, 'UTC'),
  is_final UInt8,
  source LowCardinality(String),
  window_size LowCardinality(String),
  window_step Nullable(String),
  window_start Nullable(DateTime64(3, 'UTC')),
  window_end Nullable(DateTime64(3, 'UTC')),
  version UInt32,
  asof_contract_count UInt32,
  atm_iv Nullable(Float64),
  atm_call_iv Nullable(Float64),
  atm_put_iv Nullable(Float64),
  call_put_skew_25d Nullable(Float64),
  call_put_skew_10d Nullable(Float64),
  term_slope_front_back Nullable(Float64),
  term_slope_front_mid Nullable(Float64),
  surface_breadth Nullable(Float64),
  hot_contract_coverage_ratio Nullable(Float64),
  snapshot_coverage_ratio Nullable(Float64),
  feature_quality_status LowCardinality(String)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/options_surface_features', '{replica}', ingest_ts)
PARTITION BY toDate(event_ts)
ORDER BY (underlying_symbol, event_ts, seq)
TTL toDateTime(event_ts) + toIntervalDay(30)
SETTINGS index_granularity = 8192;
```

Contract rule:

- no raw options trades or quotes are written to ClickHouse in phase 1;
- derived analytics only;
- replication, partitioning, and TTL strategy must remain aligned with the current Torghut ClickHouse operating model.

## Control-Plane Contracts

### 1. Hot-set ranking contract

Every active contract receives a deterministic ranking score in `[0,1]`:

```text
score =
  0.30 * liquidity_score +
  0.20 * quote_recency_score +
  0.15 * trade_recency_score +
  0.15 * underlying_activity_score +
  0.10 * dte_score +
  0.10 * moneyness_score
```

Component definitions:

- `liquidity_score`: normalized from recent spread quality, quote size, and open interest
- `quote_recency_score`: recency of the last quote update
- `trade_recency_score`: recency of the last trade update
- `underlying_activity_score`: underlying equity activity proxy from the current Torghut lane
- `dte_score`: peak near the configured target DTE band, tapering outside it
- `moneyness_score`: peak near ATM, tapering for deep ITM/OTM contracts

Tier assignment:

- `hot`: top `min(configured_hot_cap, measured_provider_cap * 0.8)`
- `warm`: next `min(configured_warm_cap, hot_count * 5)`
- `cold`: all remaining active contracts
- `off`: inactive, expired, suppressed, or operator-excluded contracts

Contract rule:

- the measured provider cap is updated only after successful subscribe cycles;
- a `405` event reduces the measured provider cap by at least `10%` for the next generation;
- the ranking inputs JSON stored in Postgres must be sufficient to reproduce the tiering decision offline.

### 2. Subscription rotation contract

Phase 1 rotation defaults:

- single websocket session
- maximum `250` contract changes per rotation batch
- minimum `30s` between rotation batches
- no contract may churn in and out of the hot set more than once per `5m` unless explicitly overridden by an operator

Contract rule:

- rotation decisions are computed in the catalog service and consumed by the websocket service;
- websocket service is not allowed to self-select symbols.

### 3. REST budgeting contract

The system uses four token buckets persisted in `torghut_options_rate_limit_state`:

| Bucket | Initial refill | Initial burst | Use |
| --- | --- | --- | --- |
| `contracts` | `0.25 req/s` | `2` | paginated catalog discovery |
| `snapshots_hot` | `1.0 req/s` | `10` | hot-set snapshot refresh |
| `snapshots_cold` | `0.25 req/s` | `5` | warm/cold sweep refresh |
| `bars_backfill` | `0.25 req/s` | `2` | historical bar gap repair |

Contract rule:

- these are conservative bootstrap defaults, not provider truth;
- any HTTP `429` or equivalent provider throttle signal cuts the refill rate for that bucket by `50%` until one full
  quiet interval passes without another throttle event;
- operator overrides must be explicit config, not code changes.

## Config, Identity, and Secret Contracts

### 1. Kubernetes resource names

The options lane must use the following names:

- `ConfigMap/torghut-options-catalog-config`
- `ConfigMap/torghut-ws-options-config`
- `ConfigMap/torghut-options-enricher-config`
- `ConfigMap/torghut-options-ta-config`
- `Secret/torghut-options-alpaca`
- `Secret/torghut-options-db-app`
- `Secret/torghut-options-clickhouse-auth`
- `KafkaUser/torghut-options`
- reflected Kafka secret in namespace `torghut`: `Secret/torghut-options`
- `Deployment/torghut-options-catalog`
- `Deployment/torghut-ws-options`
- `Deployment/torghut-options-enricher`
- `FlinkDeployment/torghut-options-ta`

Contract rule:

- the options lane must not consume `ConfigMap/torghut-ws-config`;
- the options lane must not consume `Secret/torghut-ws` for Kafka auth;
- reusing the same underlying Alpaca account is allowed, but the mounted secret must still be
  `Secret/torghut-options-alpaca` so the lane has its own secret reference and rotation boundary.

### 2. Required env var families

Required config families:

- Alpaca:
  - `ALPACA_OPTIONS_KEY_ID`
  - `ALPACA_OPTIONS_SECRET_KEY`
  - `ALPACA_OPTIONS_FEED`
  - `ALPACA_OPTIONS_STREAM_URL`
  - `ALPACA_OPTIONS_BASE_URL`
- discovery:
  - `OPTIONS_CONTRACT_DISCOVERY_INTERVAL_SEC`
  - `OPTIONS_CONTRACT_DISCOVERY_OFFSESSION_INTERVAL_SEC`
  - `OPTIONS_CONTRACT_DISCOVERY_PAGE_LIMIT`
- websocket:
  - `OPTIONS_SUBSCRIPTION_HOT_CAP`
  - `OPTIONS_SUBSCRIPTION_WARM_CAP`
  - `OPTIONS_SUBSCRIPTION_ROTATION_BATCH_SIZE`
  - `OPTIONS_SUBSCRIPTION_ROTATION_MIN_INTERVAL_SEC`
  - `OPTIONS_PROVIDER_CAP_BOOTSTRAP`
- enrichment:
  - `OPTIONS_SNAPSHOT_HOT_INTERVAL_SEC`
  - `OPTIONS_SNAPSHOT_WARM_INTERVAL_SEC`
  - `OPTIONS_SNAPSHOT_COLD_INTERVAL_SEC`
  - `OPTIONS_BACKFILL_MAX_DAYS`
- TA:
  - `OPTIONS_TA_PARALLELISM`
  - `OPTIONS_TA_CHECKPOINT_INTERVAL_MS`
  - `OPTIONS_TA_MAX_OUT_OF_ORDER_MS`
  - `OPTIONS_TA_CLICKHOUSE_BATCH_SIZE`
- SLOs:
  - `OPTIONS_SLO_DISCOVERY_FRESHNESS_SEC`
  - `OPTIONS_SLO_HOT_SNAPSHOT_FRESHNESS_SEC`
  - `OPTIONS_SLO_TA_WATERMARK_LAG_SEC`
  - `OPTIONS_SLO_CLICKHOUSE_FRESHNESS_SEC`

Contract rule:

- environment variables are authoritative operator inputs;
- code defaults may exist for local development only;
- production manifests must set every required variable explicitly.

## SLO and Alert Contracts

### 1. Session-aware SLOs

Regular-session targets:

| Signal | Target | Page threshold | Ticket threshold |
| --- | --- | --- | --- |
| catalog freshness | `<= 300s` | `> 900s for 15m` | `> 300s for 5m` |
| hot snapshot freshness | `<= 30s` | `> 120s for 10m` | `> 30s for 5m` |
| warm snapshot freshness | `<= 300s` | `> 900s for 15m` | `> 300s for 10m` |
| TA watermark lag | `<= 30s` | `> 180s for 10m` | `> 60s for 10m` |
| ClickHouse derived freshness | `<= 120s` | `> 600s for 10m` | `> 120s for 10m` |

Off-session targets:

- catalog freshness: `<= 3600s`
- warm/cold snapshot freshness: `<= 21600s`
- TA and ClickHouse freshness alerts suppressed unless a replay or backfill is actively expected

Contract rule:

- alert logic must branch on `session_state`;
- weekend/holiday lag is not a paging incident by itself.

### 2. Mandatory metrics

Each component must emit:

- `torghut_options_component_status`
- `torghut_options_provider_error_total{code=...}`
- `torghut_options_hot_contracts`
- `torghut_options_provider_cap`
- `torghut_options_rest_backlog`
- `torghut_options_snapshot_freshness_seconds{tier=...}`
- `torghut_options_ta_watermark_lag_seconds`
- `torghut_options_clickhouse_freshness_seconds{table=...}`

## Validation and Rollout Gates

The implementation is not ready for live promotion until all of the following are true:

1. schema-registry subjects exist for the three derived TA topics and match the documented field sets;
2. Postgres tables exist exactly as documented or with a documented additive superset;
3. ClickHouse tables exist with replicated replacing-merge-tree engines and the documented TTL/order-by contracts;
4. at least five regular sessions complete without unhandled `405`, `406`, `410`, `412`, or `413` conditions;
5. measured provider cap and hot-set ranking decisions can be replayed from stored Postgres state;
6. weekend/holiday sessions remain quiet in paging while preserving truthful degraded status records;
7. no change regresses the existing equity lane topics, Kafka auth, or Flink job.

## Acceptance Criteria

- engineers can implement the options lane without inventing new topic names, key shapes, storage tables, or secret
  names;
- every Kafka topic in document 33 now has an explicit payload contract;
- Postgres ownership of catalog, subscription state, watermarks, and rate limits is explicit;
- ClickHouse table DDL is concrete and aligned with the live Torghut replicated TA pattern;
- subscription ranking, provider-cap learning, and REST token buckets are deterministic and operator-configurable;
- SLOs and alerts are numeric, session-aware, and non-noisy on weekends and holidays;
- the contract set preserves strict isolation from the current equity lane while staying inside Torghut's existing
  envelope and schema-registry conventions.
