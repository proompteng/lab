CREATE DATABASE IF NOT EXISTS signal;

CREATE TABLE IF NOT EXISTS signal.adjusted_daily_bars_v2
(
  snapshot_id String,
  symbol LowCardinality(String),
  session_date Date,
  adjusted_open Decimal64(8),
  adjusted_high Decimal64(8),
  adjusted_low Decimal64(8),
  adjusted_close Decimal64(8),
  adjusted_volume Decimal64(8),
  trade_count UInt64,
  vwap Nullable(Decimal64(8)),
  provider LowCardinality(String),
  source_feed LowCardinality(String),
  adjustment LowCardinality(String),
  publication_asof Date
)
ENGINE = ReplicatedMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_adjusted_daily_bars_v2',
  '{replica}'
)
PARTITION BY toYear(session_date)
ORDER BY (snapshot_id, symbol, session_date);

CREATE TABLE IF NOT EXISTS signal.exchange_sessions_v1
(
  snapshot_id String,
  calendar_version LowCardinality(String),
  session_date Date,
  open_time FixedString(5),
  close_time FixedString(5),
  timezone LowCardinality(String),
  provider LowCardinality(String)
)
ENGINE = ReplicatedMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_exchange_sessions_v1',
  '{replica}'
)
PARTITION BY toYear(session_date)
ORDER BY (snapshot_id, session_date);

CREATE TABLE IF NOT EXISTS signal.snapshot_manifests_v1
(
  snapshot_id String,
  schema_version LowCardinality(String),
  publisher_source_revision FixedString(40),
  publisher_image_repository String,
  publisher_image_digest FixedString(71),
  provider LowCardinality(String),
  source_feed LowCardinality(String),
  adjustment LowCardinality(String),
  calendar_version LowCardinality(String),
  requested_start Date,
  publication_asof Date,
  first_session Date,
  last_session Date,
  symbol_count UInt32,
  session_count UInt32,
  bar_count UInt64,
  bars_content_hash FixedString(64),
  sessions_content_hash FixedString(64),
  manifest_content_hash FixedString(64),
  finalized_at DateTime64(3, 'UTC')
)
ENGINE = ReplicatedMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_snapshot_manifests_v1',
  '{replica}'
)
ORDER BY snapshot_id;

CREATE TABLE IF NOT EXISTS signal.snapshot_manifests_v2
(
  snapshot_id String,
  schema_version LowCardinality(String),
  publisher_source_revision FixedString(40),
  publisher_image_repository String,
  publisher_image_digest FixedString(71),
  universe_id LowCardinality(String),
  universe_symbol_hash FixedString(64),
  provider LowCardinality(String),
  source_feed LowCardinality(String),
  adjustment LowCardinality(String),
  calendar_version LowCardinality(String),
  requested_start Date,
  publication_asof Date,
  first_session Date,
  last_session Date,
  symbol_count UInt32,
  session_count UInt32,
  bar_count UInt64,
  bars_content_hash FixedString(64),
  sessions_content_hash FixedString(64),
  manifest_content_hash FixedString(64),
  finalized_at DateTime64(3, 'UTC')
)
ENGINE = ReplicatedMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/signal_snapshot_manifests_v2',
  '{replica}'
)
ORDER BY snapshot_id;
