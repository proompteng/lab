SELECT throwIf(
  count() != 1
    OR countIf(engine = 'ReplicatedReplacingMergeTree') != 1
    OR countIf(sorting_key = 'universe_id, feed, symbol, event_ts') != 1
    OR countIf(partition_key = 'toYYYYMM(event_ts)') != 1
    OR countIf(position(engine_full, 'source_offset') > 0) != 1
    OR countIf(
      position(create_table_query, 'TTL toDateTime(event_ts) + toIntervalDay(400)') > 0
    ) != 1,
  'Signal intraday-bars table engine, keys, version, or TTL are incorrect'
)
FROM system.tables
WHERE database = 'signal' AND name = 'intraday_bars_1m_v1';

SELECT throwIf(
  count() != 1
    OR countIf(engine = 'ReplicatedReplacingMergeTree') != 1
    OR countIf(
      sorting_key =
        'universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset'
    ) != 1
    OR countIf(partition_key = 'toYYYYMM(event_ts)') != 1
    OR countIf(position(engine_full, 'source_offset') > 0) != 1
    OR countIf(
      position(create_table_query, 'TTL toDateTime(event_ts) + toIntervalDay(400)') > 0
    ) != 1,
  'Signal immutable intraday-bars table engine, key, version, or TTL is incorrect'
)
FROM system.tables
WHERE database = 'signal' AND name = 'intraday_bars_1m_v2';

SELECT throwIf(
  count() != 1
    OR countIf(toFloat64OrZero(extract(
      create_table_query,
      'ratio_of_defaults_for_sparse_serialization = ([0-9.eE+-]+)'
    )) = 1) != 1,
  'Signal immutable intraday-bars must preserve signed-zero identity with full serialization'
)
FROM system.tables
WHERE database = 'signal' AND name = 'intraday_bars_1m_v2';

SELECT throwIf(
  count() != 44
    OR arraySort(groupUniqArray(concat(name, ':', type))) != arraySort([
      'provider:LowCardinality(String)',
      'universe_id:LowCardinality(String)',
      'universe_symbol_hash:FixedString(64)',
      'feed:LowCardinality(String)',
      'channel:LowCardinality(String)',
      'market_session:LowCardinality(String)',
      'delay_class:LowCardinality(String)',
      'symbol:LowCardinality(String)',
      'event_ts:DateTime64(3, \'UTC\')',
      'ingest_ts:DateTime64(3, \'UTC\')',
      'source_topic:LowCardinality(String)',
      'source_partition:UInt32',
      'source_offset:UInt64',
      'is_final:UInt8',
      'open:Float64',
      'high:Float64',
      'low:Float64',
      'close:Float64',
      'volume:Float64',
      'vwap:Nullable(Float64)',
      'trade_count:Nullable(UInt64)',
      'schema_version:UInt32'
    ]),
  'Signal intraday-bars columns do not match the archive contract'
)
FROM system.columns
WHERE database = 'signal' AND table IN ('intraday_bars_1m_v1', 'intraday_bars_1m_v2')
  AND name NOT IN ('event_ts_exact', 'ingest_ts_exact');

SELECT throwIf(
  count() != 2
    OR countIf(type = 'Nullable(DateTime64(9, \'UTC\'))') != 2,
  'Signal immutable intraday-bars exact timestamps do not match the archive contract'
)
FROM system.columns
WHERE database = 'signal' AND table = 'intraday_bars_1m_v2'
  AND name IN ('event_ts_exact', 'ingest_ts_exact');

SELECT throwIf(
  count() != 2
    OR countIf(engine = 'ReplicatedReplacingMergeTree') != 2
    OR countIf(
      sorting_key =
        'universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset'
    ) != 2
    OR countIf(partition_key = 'toYYYYMM(event_ts)') != 2
    OR countIf(position(engine_full, 'source_offset') > 0) != 2
    OR countIf(
      position(create_table_query, 'TTL toDateTime(event_ts) + toIntervalDay(120)') > 0
    ) != 2,
  'Signal intraday quote/trade table engine, keys, version, or TTL are incorrect'
)
FROM system.tables
WHERE database = 'signal' AND name IN ('intraday_quotes_v1', 'intraday_trades_v1');

SELECT throwIf(
  count() != 17
    OR arraySort(groupUniqArray(concat(name, ':', type))) != arraySort([
      'provider:LowCardinality(String)',
      'universe_id:LowCardinality(String)',
      'universe_symbol_hash:FixedString(64)',
      'feed:LowCardinality(String)',
      'market_session:LowCardinality(String)',
      'delay_class:LowCardinality(String)',
      'symbol:LowCardinality(String)',
      'event_ts:DateTime64(9, \'UTC\')',
      'ingest_ts:DateTime64(9, \'UTC\')',
      'source_topic:LowCardinality(String)',
      'source_partition:UInt32',
      'source_offset:UInt64',
      'bid_price:Float64',
      'bid_size:Float64',
      'ask_price:Float64',
      'ask_size:Float64',
      'schema_version:UInt32'
    ]),
  'Signal intraday-quotes columns do not match the archive contract'
)
FROM system.columns
WHERE database = 'signal' AND table = 'intraday_quotes_v1';

SELECT throwIf(
  count() != 15
    OR arraySort(groupUniqArray(concat(name, ':', type))) != arraySort([
      'provider:LowCardinality(String)',
      'universe_id:LowCardinality(String)',
      'universe_symbol_hash:FixedString(64)',
      'feed:LowCardinality(String)',
      'market_session:LowCardinality(String)',
      'delay_class:LowCardinality(String)',
      'symbol:LowCardinality(String)',
      'event_ts:DateTime64(9, \'UTC\')',
      'ingest_ts:DateTime64(9, \'UTC\')',
      'source_topic:LowCardinality(String)',
      'source_partition:UInt32',
      'source_offset:UInt64',
      'price:Float64',
      'size:Float64',
      'schema_version:UInt32'
    ]),
  'Signal intraday-trades columns do not match the archive contract'
)
FROM system.columns
WHERE database = 'signal' AND table = 'intraday_trades_v1';

SELECT throwIf(
  arraySort(groupArray(concat(table, '.', name, ':', type))) != arraySort([
    'webull_market_events_v1.provider:LowCardinality(String)',
    'webull_market_events_v1.feed:LowCardinality(String)',
    'webull_market_events_v1.capture_id:UUID',
    'webull_market_events_v1.channel:LowCardinality(String)',
    'webull_market_events_v1.received_at:DateTime64(9, \'UTC\')',
    'webull_market_events_v1.archived_at:DateTime64(9, \'UTC\')',
    'webull_market_events_v1.source_topic:LowCardinality(String)',
    'webull_market_events_v1.source_partition:UInt32',
    'webull_market_events_v1.source_offset:UInt64',
    'webull_market_events_v1.payload_sha256:FixedString(64)',
    'webull_market_events_v1.symbols:Array(String)',
    'webull_market_events_v1.source_times:Array(String)',
    'webull_market_events_v1.validation_status:LowCardinality(String)',
    'webull_market_events_v1.validation_error:LowCardinality(String)',
    'webull_market_events_v1.capture:String',
    'webull_market_events_v1.minute_bars:Array(Tuple(symbol String, start_ms Int64, session String, open String, high String, low String, close String, volume String))',
    'webull_market_events_v1.bar_requests:Array(Tuple(symbol String, state String, observations UInt32, excluded UInt32))',
    'crypto_market_features_v1.feature_id:FixedString(64)',
    'crypto_market_features_v1.location:LowCardinality(String)',
    'crypto_market_features_v1.symbol:LowCardinality(String)',
    'crypto_market_features_v1.window_start:DateTime64(3, \'UTC\')',
    'crypto_market_features_v1.window_end:DateTime64(3, \'UTC\')',
    'crypto_market_features_v1.computed_at:DateTime64(3, \'UTC\')',
    'crypto_market_features_v1.archived_at:DateTime64(3, \'UTC\')',
    'crypto_market_features_v1.source_topic:LowCardinality(String)',
    'crypto_market_features_v1.source_partition:UInt32',
    'crypto_market_features_v1.source_offset:UInt64',
    'crypto_market_features_v1.payload:String',
    'crypto_market_events_v1.provider:LowCardinality(String)',
    'crypto_market_events_v1.location:LowCardinality(String)',
    'crypto_market_events_v1.channel:LowCardinality(String)',
    'crypto_market_events_v1.symbol:LowCardinality(String)',
    'crypto_market_events_v1.event_ts:DateTime64(9, \'UTC\')',
    'crypto_market_events_v1.ingest_ts:DateTime64(9, \'UTC\')',
    'crypto_market_events_v1.source_topic:LowCardinality(String)',
    'crypto_market_events_v1.source_partition:UInt32',
    'crypto_market_events_v1.source_offset:UInt64',
    'crypto_market_events_v1.sequence:UInt64',
    'crypto_market_events_v1.payload:String',
    'crypto_market_events_v1.schema_version:UInt16',
    'intraday_bars_1m_v1.provider:LowCardinality(String)',
    'intraday_bars_1m_v1.universe_id:LowCardinality(String)',
    'intraday_bars_1m_v1.universe_symbol_hash:FixedString(64)',
    'intraday_bars_1m_v1.feed:LowCardinality(String)',
    'intraday_bars_1m_v1.channel:LowCardinality(String)',
    'intraday_bars_1m_v1.market_session:LowCardinality(String)',
    'intraday_bars_1m_v1.delay_class:LowCardinality(String)',
    'intraday_bars_1m_v1.symbol:LowCardinality(String)',
    'intraday_bars_1m_v1.event_ts:DateTime64(3, \'UTC\')',
    'intraday_bars_1m_v1.ingest_ts:DateTime64(3, \'UTC\')',
    'intraday_bars_1m_v1.source_topic:LowCardinality(String)',
    'intraday_bars_1m_v1.source_partition:UInt32',
    'intraday_bars_1m_v1.source_offset:UInt64',
    'intraday_bars_1m_v1.is_final:UInt8',
    'intraday_bars_1m_v1.open:Float64',
    'intraday_bars_1m_v1.high:Float64',
    'intraday_bars_1m_v1.low:Float64',
    'intraday_bars_1m_v1.close:Float64',
    'intraday_bars_1m_v1.volume:Float64',
    'intraday_bars_1m_v1.vwap:Nullable(Float64)',
    'intraday_bars_1m_v1.trade_count:Nullable(UInt64)',
    'intraday_bars_1m_v1.schema_version:UInt32',
    'intraday_bars_1m_v2.provider:LowCardinality(String)',
    'intraday_bars_1m_v2.universe_id:LowCardinality(String)',
    'intraday_bars_1m_v2.universe_symbol_hash:FixedString(64)',
    'intraday_bars_1m_v2.feed:LowCardinality(String)',
    'intraday_bars_1m_v2.channel:LowCardinality(String)',
    'intraday_bars_1m_v2.market_session:LowCardinality(String)',
    'intraday_bars_1m_v2.delay_class:LowCardinality(String)',
    'intraday_bars_1m_v2.symbol:LowCardinality(String)',
    'intraday_bars_1m_v2.event_ts:DateTime64(3, \'UTC\')',
    'intraday_bars_1m_v2.ingest_ts:DateTime64(3, \'UTC\')',
    'intraday_bars_1m_v2.source_topic:LowCardinality(String)',
    'intraday_bars_1m_v2.source_partition:UInt32',
    'intraday_bars_1m_v2.source_offset:UInt64',
    'intraday_bars_1m_v2.is_final:UInt8',
    'intraday_bars_1m_v2.open:Float64',
    'intraday_bars_1m_v2.high:Float64',
    'intraday_bars_1m_v2.low:Float64',
    'intraday_bars_1m_v2.close:Float64',
    'intraday_bars_1m_v2.volume:Float64',
    'intraday_bars_1m_v2.vwap:Nullable(Float64)',
    'intraday_bars_1m_v2.trade_count:Nullable(UInt64)',
    'intraday_bars_1m_v2.schema_version:UInt32',
    'intraday_quotes_v1.provider:LowCardinality(String)',
    'intraday_quotes_v1.universe_id:LowCardinality(String)',
    'intraday_quotes_v1.universe_symbol_hash:FixedString(64)',
    'intraday_quotes_v1.feed:LowCardinality(String)',
    'intraday_quotes_v1.market_session:LowCardinality(String)',
    'intraday_quotes_v1.delay_class:LowCardinality(String)',
    'intraday_quotes_v1.symbol:LowCardinality(String)',
    'intraday_quotes_v1.event_ts:DateTime64(9, \'UTC\')',
    'intraday_quotes_v1.ingest_ts:DateTime64(9, \'UTC\')',
    'intraday_quotes_v1.source_topic:LowCardinality(String)',
    'intraday_quotes_v1.source_partition:UInt32',
    'intraday_quotes_v1.source_offset:UInt64',
    'intraday_quotes_v1.bid_price:Float64',
    'intraday_quotes_v1.bid_size:Float64',
    'intraday_quotes_v1.ask_price:Float64',
    'intraday_quotes_v1.ask_size:Float64',
    'intraday_quotes_v1.schema_version:UInt32',
    'intraday_trades_v1.provider:LowCardinality(String)',
    'intraday_trades_v1.universe_id:LowCardinality(String)',
    'intraday_trades_v1.universe_symbol_hash:FixedString(64)',
    'intraday_trades_v1.feed:LowCardinality(String)',
    'intraday_trades_v1.market_session:LowCardinality(String)',
    'intraday_trades_v1.delay_class:LowCardinality(String)',
    'intraday_trades_v1.symbol:LowCardinality(String)',
    'intraday_trades_v1.event_ts:DateTime64(9, \'UTC\')',
    'intraday_trades_v1.ingest_ts:DateTime64(9, \'UTC\')',
    'intraday_trades_v1.source_topic:LowCardinality(String)',
    'intraday_trades_v1.source_partition:UInt32',
    'intraday_trades_v1.source_offset:UInt64',
    'intraday_trades_v1.price:Float64',
    'intraday_trades_v1.size:Float64',
    'intraday_trades_v1.schema_version:UInt32',
    'intraday_bars_1m_v2.event_ts_exact:Nullable(DateTime64(9, \'UTC\'))',
    'intraday_bars_1m_v2.ingest_ts_exact:Nullable(DateTime64(9, \'UTC\'))'
  ]),
  'intraday-bars columns differ from the archive contract'
) FROM system.columns WHERE database = 'signal' AND table IN ('webull_market_events_v1', 'crypto_market_features_v1', 'crypto_market_events_v1', 'intraday_bars_1m_v1', 'intraday_bars_1m_v2', 'intraday_quotes_v1', 'intraday_trades_v1');

SELECT throwIf(count() != 1 OR countIf(engine = 'View' AND formatQuerySingleLine(as_select) = formatQuerySingleLine('SELECT provider, feed, capture_id, channel, received_at, archived_at,
  source_topic, source_partition, source_offset, payload_sha256,
  validation_status, validation_error, minute_bars, bar_requests,
  if(channel = \'gap\', JSONExtractString(base64Decode(JSONExtractString(capture, \'payloadBase64\')), \'channel\'), \'\') AS gap_channel,
  if(channel = \'gap\', JSONExtractString(base64Decode(JSONExtractString(capture, \'payloadBase64\')), \'reason\'), \'\') AS gap_reason,
  if(channel = \'gap\', JSONExtractString(base64Decode(JSONExtractString(capture, \'payloadBase64\')), \'errorClass\'), \'\') AS gap_error,
  if(channel = \'gap\', JSONExtractString(base64Decode(JSONExtractString(capture, \'payloadBase64\')), \'from\'), \'\') AS gap_from,
  if(channel = \'gap\', JSONExtractString(base64Decode(JSONExtractString(capture, \'payloadBase64\')), \'to\'), \'\') AS gap_to
FROM signal.webull_market_events_v1 FINAL')) != 1, 'Webull research view differs from its source contract') FROM system.tables WHERE database='signal' AND name='webull_research_events_v1';

SELECT throwIf(count() != 3 OR countIf(engine = 'ReplicatedReplacingMergeTree') != 3 OR countIf(position(create_table_query, 'toIntervalDay(30)') > 0) != 3, 'Webull and crypto archive tables must retain replicated engines and 30-day retention') FROM system.tables WHERE database='signal' AND name IN ('webull_market_events_v1','crypto_market_features_v1','crypto_market_events_v1');
