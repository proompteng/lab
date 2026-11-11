CREATE DATABASE IF NOT EXISTS signal;

CREATE TABLE IF NOT EXISTS signal.webull_market_events_v1
(
  provider LowCardinality(String),
  feed LowCardinality(String),
  capture_id UUID,
  channel LowCardinality(String),
  received_at DateTime64(9, 'UTC'),
  archived_at DateTime64(9, 'UTC') DEFAULT now64(9),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  payload_sha256 FixedString(64),
  symbols Array(String),
  source_times Array(String),
  validation_status LowCardinality(String),
  validation_error LowCardinality(String),
  capture String CODEC(ZSTD(3)),
  minute_bars Array(Tuple(symbol String, start_ms Int64, session String, open String, high String, low String, close String, volume String)),
  bar_requests Array(Tuple(symbol String, state String, observations UInt32, excluded UInt32))
)
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_webull_market_events_v1',
  '{replica}'
)
PARTITION BY toYYYYMM(received_at)
ORDER BY (source_topic, source_partition, source_offset)
TTL toDateTime(received_at) + INTERVAL 30 DAY DELETE;

ALTER TABLE signal.webull_market_events_v1
  ADD COLUMN IF NOT EXISTS minute_bars Array(Tuple(symbol String, start_ms Int64, session String, open String, high String, low String, close String, volume String)),
  ADD COLUMN IF NOT EXISTS bar_requests Array(Tuple(symbol String, state String, observations UInt32, excluded UInt32));

CREATE OR REPLACE VIEW signal.webull_research_events_v1
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT provider, feed, capture_id, channel, received_at, archived_at,
  source_topic, source_partition, source_offset, payload_sha256,
  validation_status, validation_error, minute_bars, bar_requests,
  if(channel = 'gap', JSONExtractString(base64Decode(JSONExtractString(capture, 'payloadBase64')), 'channel'), '') AS gap_channel,
  if(channel = 'gap', JSONExtractString(base64Decode(JSONExtractString(capture, 'payloadBase64')), 'reason'), '') AS gap_reason,
  if(channel = 'gap', JSONExtractString(base64Decode(JSONExtractString(capture, 'payloadBase64')), 'errorClass'), '') AS gap_error,
  if(channel = 'gap', JSONExtractString(base64Decode(JSONExtractString(capture, 'payloadBase64')), 'from'), '') AS gap_from,
  if(channel = 'gap', JSONExtractString(base64Decode(JSONExtractString(capture, 'payloadBase64')), 'to'), '') AS gap_to
FROM signal.webull_market_events_v1 FINAL;

CREATE TABLE IF NOT EXISTS signal.crypto_market_features_v1
(
  feature_id FixedString(64),
  location LowCardinality(String),
  symbol LowCardinality(String),
  window_start DateTime64(3, 'UTC'),
  window_end DateTime64(3, 'UTC'),
  computed_at DateTime64(3, 'UTC'),
  archived_at DateTime64(3, 'UTC'),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  payload String CODEC(ZSTD(3))
)
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_crypto_market_features_v1',
  '{replica}'
)
PARTITION BY toYYYYMM(window_end)
ORDER BY (location, symbol, window_end, feature_id, source_topic, source_partition, source_offset)
TTL toDateTime(window_end) + INTERVAL 30 DAY DELETE;

CREATE TABLE IF NOT EXISTS signal.crypto_market_events_v1
(
  provider LowCardinality(String),
  location LowCardinality(String),
  channel LowCardinality(String),
  symbol LowCardinality(String),
  event_ts DateTime64(9, 'UTC'),
  ingest_ts DateTime64(9, 'UTC'),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  sequence UInt64,
  payload String CODEC(ZSTD(3)),
  schema_version UInt16
)
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_crypto_market_events_v1',
  '{replica}'
)
PARTITION BY toYYYYMM(event_ts)
ORDER BY (location, symbol, event_ts, source_topic, source_partition, source_offset)
TTL toDateTime(event_ts) + INTERVAL 30 DAY DELETE;

CREATE TABLE IF NOT EXISTS signal.intraday_bars_1m_v1
(
  provider LowCardinality(String),
  universe_id LowCardinality(String),
  universe_symbol_hash FixedString(64),
  feed LowCardinality(String),
  channel LowCardinality(String),
  market_session LowCardinality(String),
  delay_class LowCardinality(String),
  symbol LowCardinality(String),
  event_ts DateTime64(3, 'UTC'),
  ingest_ts DateTime64(3, 'UTC'),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  is_final UInt8,
  open Float64,
  high Float64,
  low Float64,
  close Float64,
  volume Float64,
  vwap Nullable(Float64),
  trade_count Nullable(UInt64),
  schema_version UInt32
)
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_intraday_bars_1m_v1',
  '{replica}',
  source_offset
)
PARTITION BY toYYYYMM(event_ts)
ORDER BY (universe_id, feed, symbol, event_ts)
TTL toDateTime(event_ts) + INTERVAL 400 DAY DELETE;

CREATE TABLE IF NOT EXISTS signal.intraday_bars_1m_v2
(
  provider LowCardinality(String),
  universe_id LowCardinality(String),
  universe_symbol_hash FixedString(64),
  feed LowCardinality(String),
  channel LowCardinality(String),
  market_session LowCardinality(String),
  delay_class LowCardinality(String),
  symbol LowCardinality(String),
  event_ts DateTime64(3, 'UTC'),
  ingest_ts DateTime64(3, 'UTC'),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  is_final UInt8,
  open Float64,
  high Float64,
  low Float64,
  close Float64,
  volume Float64,
  vwap Nullable(Float64),
  trade_count Nullable(UInt64),
  schema_version UInt32,
  event_ts_exact Nullable(DateTime64(9, 'UTC')),
  ingest_ts_exact Nullable(DateTime64(9, 'UTC'))
)
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_intraday_bars_1m_v2',
  '{replica}',
  source_offset
)
PARTITION BY toYYYYMM(event_ts)
ORDER BY (
  universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset
)
TTL toDateTime(event_ts) + INTERVAL 400 DAY DELETE
SETTINGS ratio_of_defaults_for_sparse_serialization = 1;

ALTER TABLE signal.intraday_bars_1m_v2
  ADD COLUMN IF NOT EXISTS event_ts_exact Nullable(DateTime64(9, 'UTC')),
  ADD COLUMN IF NOT EXISTS ingest_ts_exact Nullable(DateTime64(9, 'UTC'));

ALTER TABLE signal.intraday_bars_1m_v2
  MODIFY SETTING ratio_of_defaults_for_sparse_serialization = 1;

CREATE TABLE IF NOT EXISTS signal.intraday_quotes_v1
(
  provider LowCardinality(String),
  universe_id LowCardinality(String),
  universe_symbol_hash FixedString(64),
  feed LowCardinality(String),
  market_session LowCardinality(String),
  delay_class LowCardinality(String),
  symbol LowCardinality(String),
  event_ts DateTime64(9, 'UTC'),
  ingest_ts DateTime64(9, 'UTC'),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  bid_price Float64,
  bid_size Float64,
  ask_price Float64,
  ask_size Float64,
  schema_version UInt32
)
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_intraday_quotes_v1',
  '{replica}',
  source_offset
)
PARTITION BY toYYYYMM(event_ts)
ORDER BY (
  universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset
)
TTL toDateTime(event_ts) + INTERVAL 120 DAY DELETE;

CREATE TABLE IF NOT EXISTS signal.intraday_trades_v1
(
  provider LowCardinality(String),
  universe_id LowCardinality(String),
  universe_symbol_hash FixedString(64),
  feed LowCardinality(String),
  market_session LowCardinality(String),
  delay_class LowCardinality(String),
  symbol LowCardinality(String),
  event_ts DateTime64(9, 'UTC'),
  ingest_ts DateTime64(9, 'UTC'),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  price Float64,
  size Float64,
  schema_version UInt32
)
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_intraday_trades_v1',
  '{replica}',
  source_offset
)
PARTITION BY toYYYYMM(event_ts)
ORDER BY (
  universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset
)
TTL toDateTime(event_ts) + INTERVAL 120 DAY DELETE;
