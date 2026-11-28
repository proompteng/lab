SELECT throwIf(
  count() != 4
    OR countIf(engine = 'ReplicatedMergeTree') != 4
    OR countIf(
      name = 'adjusted_daily_bars_v2'
      AND sorting_key = 'snapshot_id, symbol, session_date'
      AND partition_key = 'toYear(session_date)'
    ) != 1
    OR countIf(
      name = 'exchange_sessions_v1'
      AND sorting_key = 'snapshot_id, session_date'
      AND partition_key = 'toYear(session_date)'
    ) != 1
    OR countIf(
      name = 'snapshot_manifests_v1'
      AND sorting_key = 'snapshot_id'
      AND partition_key = ''
    ) != 1
    OR countIf(
      name = 'snapshot_manifests_v2'
      AND sorting_key = 'snapshot_id'
      AND partition_key = ''
    ) != 1,
  'Signal snapshot schema is incomplete or has the wrong engine'
)
FROM system.tables
WHERE database = 'signal'
  AND name IN (
    'adjusted_daily_bars_v2',
    'exchange_sessions_v1',
    'snapshot_manifests_v1',
    'snapshot_manifests_v2'
  );

SELECT throwIf(
  arraySort(groupArray(signature)) != arraySort([
    'adjusted_daily_bars_v2.snapshot_id:String',
    'adjusted_daily_bars_v2.symbol:LowCardinality(String)',
    'adjusted_daily_bars_v2.session_date:Date',
    'adjusted_daily_bars_v2.adjusted_open:Decimal(18, 8)',
    'adjusted_daily_bars_v2.adjusted_high:Decimal(18, 8)',
    'adjusted_daily_bars_v2.adjusted_low:Decimal(18, 8)',
    'adjusted_daily_bars_v2.adjusted_close:Decimal(18, 8)',
    'adjusted_daily_bars_v2.adjusted_volume:Decimal(18, 8)',
    'adjusted_daily_bars_v2.trade_count:UInt64',
    'adjusted_daily_bars_v2.vwap:Nullable(Decimal(18, 8))',
    'adjusted_daily_bars_v2.provider:LowCardinality(String)',
    'adjusted_daily_bars_v2.source_feed:LowCardinality(String)',
    'adjusted_daily_bars_v2.adjustment:LowCardinality(String)',
    'adjusted_daily_bars_v2.publication_asof:Date',
    'exchange_sessions_v1.snapshot_id:String',
    'exchange_sessions_v1.calendar_version:LowCardinality(String)',
    'exchange_sessions_v1.session_date:Date',
    'exchange_sessions_v1.open_time:FixedString(5)',
    'exchange_sessions_v1.close_time:FixedString(5)',
    'exchange_sessions_v1.timezone:LowCardinality(String)',
    'exchange_sessions_v1.provider:LowCardinality(String)',
    'snapshot_manifests_v1.snapshot_id:String',
    'snapshot_manifests_v1.schema_version:LowCardinality(String)',
    'snapshot_manifests_v1.publisher_source_revision:FixedString(40)',
    'snapshot_manifests_v1.publisher_image_repository:String',
    'snapshot_manifests_v1.publisher_image_digest:FixedString(71)',
    'snapshot_manifests_v1.provider:LowCardinality(String)',
    'snapshot_manifests_v1.source_feed:LowCardinality(String)',
    'snapshot_manifests_v1.adjustment:LowCardinality(String)',
    'snapshot_manifests_v1.calendar_version:LowCardinality(String)',
    'snapshot_manifests_v1.requested_start:Date',
    'snapshot_manifests_v1.publication_asof:Date',
    'snapshot_manifests_v1.first_session:Date',
    'snapshot_manifests_v1.last_session:Date',
    'snapshot_manifests_v1.symbol_count:UInt32',
    'snapshot_manifests_v1.session_count:UInt32',
    'snapshot_manifests_v1.bar_count:UInt64',
    'snapshot_manifests_v1.bars_content_hash:FixedString(64)',
    'snapshot_manifests_v1.sessions_content_hash:FixedString(64)',
    'snapshot_manifests_v1.manifest_content_hash:FixedString(64)',
    'snapshot_manifests_v1.finalized_at:DateTime64(3, \'UTC\')',
    'snapshot_manifests_v2.snapshot_id:String',
    'snapshot_manifests_v2.schema_version:LowCardinality(String)',
    'snapshot_manifests_v2.publisher_source_revision:FixedString(40)',
    'snapshot_manifests_v2.publisher_image_repository:String',
    'snapshot_manifests_v2.publisher_image_digest:FixedString(71)',
    'snapshot_manifests_v2.universe_id:LowCardinality(String)',
    'snapshot_manifests_v2.universe_symbol_hash:FixedString(64)',
    'snapshot_manifests_v2.provider:LowCardinality(String)',
    'snapshot_manifests_v2.source_feed:LowCardinality(String)',
    'snapshot_manifests_v2.adjustment:LowCardinality(String)',
    'snapshot_manifests_v2.calendar_version:LowCardinality(String)',
    'snapshot_manifests_v2.requested_start:Date',
    'snapshot_manifests_v2.publication_asof:Date',
    'snapshot_manifests_v2.first_session:Date',
    'snapshot_manifests_v2.last_session:Date',
    'snapshot_manifests_v2.symbol_count:UInt32',
    'snapshot_manifests_v2.session_count:UInt32',
    'snapshot_manifests_v2.bar_count:UInt64',
    'snapshot_manifests_v2.bars_content_hash:FixedString(64)',
    'snapshot_manifests_v2.sessions_content_hash:FixedString(64)',
    'snapshot_manifests_v2.manifest_content_hash:FixedString(64)',
    'snapshot_manifests_v2.finalized_at:DateTime64(3, \'UTC\')'
  ]),
  'Signal snapshot columns do not match the publication contracts'
)
FROM (
  SELECT concat(table, '.', name, ':', type) AS signature
  FROM system.columns
  WHERE database = 'signal'
    AND table IN (
      'adjusted_daily_bars_v2',
      'exchange_sessions_v1',
      'snapshot_manifests_v1',
      'snapshot_manifests_v2'
    )
);
