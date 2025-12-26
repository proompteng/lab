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
TTL event_ts + INTERVAL 30 DAY
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
  vol_realized_w60s Nullable(Float64)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{cluster}/{shard}/ta_signals', '{replica}', ingest_ts)
PARTITION BY toDate(event_ts)
ORDER BY (symbol, event_ts, seq)
TTL event_ts + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
