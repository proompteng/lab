CREATE DATABASE IF NOT EXISTS signal;
CREATE TABLE IF NOT EXISTS signal.intraday_features_v1
(
  feature_id FixedString(64),
  universe_id LowCardinality(String),
  universe_symbol_hash FixedString(64),
  feed LowCardinality(String),
  symbol LowCardinality(String),
  window_end DateTime64(3, 'UTC'),
  computed_at DateTime64(3, 'UTC'),
  archived_at DateTime64(3, 'UTC'),
  source_topic LowCardinality(String),
  source_partition UInt32,
  source_offset UInt64,
  payload String
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{cluster}/{shard}/signal_intraday_features_v1', '{replica}')
PARTITION BY toYYYYMMDD(window_end)
ORDER BY (universe_id, feed, symbol, window_end, source_topic, source_partition, source_offset)
TTL archived_at + INTERVAL 35 DAY DELETE;
