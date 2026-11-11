SELECT throwIf(count() != 3 OR countIf(engine = 'ReplicatedMergeTree') != 3 OR countIf(position(create_table_query, 'TTL ') > 0) != 0, 'Historical datasets require all three immutable replicated tables without TTL') FROM system.tables WHERE database = 'signal' AND name IN ('historical_market_records_v1', 'historical_dataset_chunks_v1', 'historical_datasets_v1');
SELECT throwIf(
  engine != 'ReplicatedMergeTree' OR position(create_table_query, 'TTL ') > 0,
  'Historical datasets must retain immutable versions without the live archive TTL'
) FROM system.tables WHERE database = 'signal' AND name IN ('historical_market_records_v1', 'historical_dataset_chunks_v1', 'historical_datasets_v1');

SELECT throwIf(
  arraySort(groupArray(concat(table, '.', name, ':', type))) != arraySort([
    'historical_market_records_v1.dataset_id:FixedString(64)',
    'historical_market_records_v1.record_id:FixedString(64)',
    'historical_market_records_v1.row_ordinal:UInt64',
    'historical_market_records_v1.query_hash:FixedString(64)',
    'historical_market_records_v1.provider:LowCardinality(String)',
    'historical_market_records_v1.transport:LowCardinality(String)',
    'historical_market_records_v1.feed:LowCardinality(String)',
    'historical_market_records_v1.session_date:Date',
    'historical_market_records_v1.symbol:LowCardinality(String)',
    'historical_market_records_v1.kind:LowCardinality(String)',
    'historical_market_records_v1.event_at:DateTime64(9, \'UTC\')',
    'historical_market_records_v1.retrieved_at:DateTime64(3, \'UTC\')',
    'historical_market_records_v1.payload:String',
    'historical_dataset_chunks_v1.dataset_id:FixedString(64)',
    'historical_dataset_chunks_v1.query_hash:FixedString(64)',
    'historical_dataset_chunks_v1.metadata:String',
    'historical_datasets_v1.dataset_id:FixedString(64)',
    'historical_datasets_v1.manifest:String',
    'historical_datasets_v1.coverage:String',
    'historical_datasets_v1.calendar:String',
    'historical_datasets_v1.archived_at:DateTime64(3, \'UTC\')'
  ]),
  'historical-datasets columns differ from the archive contract'
) FROM system.columns WHERE database = 'signal' AND table IN ('historical_market_records_v1', 'historical_dataset_chunks_v1', 'historical_datasets_v1');
