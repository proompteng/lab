CREATE DATABASE IF NOT EXISTS signal;
CREATE TABLE IF NOT EXISTS signal.historical_market_records_v1
(
  dataset_id FixedString(64),
  record_id FixedString(64),
  row_ordinal UInt64,
  query_hash FixedString(64),
  provider LowCardinality(String),
  transport LowCardinality(String),
  feed LowCardinality(String),
  session_date Date,
  symbol LowCardinality(String),
  kind LowCardinality(String),
  event_at DateTime64(9, 'UTC'),
  retrieved_at DateTime64(3, 'UTC'),
  payload String,
  CONSTRAINT historical_provider CHECK provider = 'alpaca',
  CONSTRAINT historical_transport CHECK transport = 'historical-rest',
  CONSTRAINT historical_kind CHECK kind IN ('bars', 'quotes', 'trades')
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{cluster}/{shard}/signal_historical_market_records_v1', '{replica}')
PARTITION BY toYYYYMM(session_date)
ORDER BY (dataset_id, query_hash, row_ordinal);
CREATE TABLE IF NOT EXISTS signal.historical_dataset_chunks_v1
(
  dataset_id FixedString(64),
  query_hash FixedString(64),
  metadata String
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{cluster}/{shard}/signal_historical_dataset_chunks_v1', '{replica}')
ORDER BY (dataset_id, query_hash);
CREATE TABLE IF NOT EXISTS signal.historical_datasets_v1
(
  dataset_id FixedString(64),
  manifest String,
  coverage String,
  calendar String,
  archived_at DateTime64(3, 'UTC')
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{cluster}/{shard}/signal_historical_datasets_v1', '{replica}')
ORDER BY dataset_id;
