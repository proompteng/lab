CREATE DATABASE IF NOT EXISTS torghut ON CLUSTER default;

CREATE TABLE IF NOT EXISTS torghut.ta_microbars ON CLUSTER default
(
  symbol LowCardinality(String),
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
  o Float64,
  h Float64,
  l Float64,
  c Float64,
  v Float64,
  vwap Nullable(Float64),
  count UInt64
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/ta_microbars', '{replica}', ingest_ts)
PARTITION BY toDate(event_ts)
ORDER BY (symbol, event_ts, seq)
TTL toDateTime(event_ts) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS torghut.ta_signals ON CLUSTER default
(
  symbol LowCardinality(String),
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
  macd Nullable(Float64),
  macd_signal Nullable(Float64),
  macd_hist Nullable(Float64),
  ema12 Nullable(Float64),
  ema26 Nullable(Float64),
  rsi14 Nullable(Float64),
  boll_mid Nullable(Float64),
  boll_upper Nullable(Float64),
  boll_lower Nullable(Float64),
  vwap_session Nullable(Float64),
  vwap_w5m Nullable(Float64),
  imbalance_spread Nullable(Float64),
  imbalance_bid_px Nullable(Float64),
  imbalance_ask_px Nullable(Float64),
  imbalance_bid_sz Nullable(UInt64),
  imbalance_ask_sz Nullable(UInt64),
  vol_realized_w60s Nullable(Float64),
  microstructure_signal_v1 Nullable(String)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/ta_signals', '{replica}', ingest_ts)
PARTITION BY toDate(event_ts)
ORDER BY (symbol, event_ts, seq)
TTL toDateTime(event_ts) + INTERVAL 14 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE torghut.ta_signals ON CLUSTER default
  ADD COLUMN IF NOT EXISTS microstructure_signal_v1 Nullable(String);

CREATE TABLE IF NOT EXISTS torghut.options_contract_bars_1s ON CLUSTER default
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
TTL toDateTime(event_ts) + INTERVAL 14 DAY
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS torghut.options_contract_features ON CLUSTER default
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
TTL toDateTime(event_ts) + INTERVAL 14 DAY
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS torghut.options_surface_features ON CLUSTER default
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
TTL toDateTime(event_ts) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
