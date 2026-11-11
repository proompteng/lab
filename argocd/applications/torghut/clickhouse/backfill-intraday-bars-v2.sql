INSERT INTO signal.intraday_bars_1m_v2 (
  provider, universe_id, universe_symbol_hash, feed, channel, market_session, delay_class,
  symbol, event_ts, ingest_ts, source_topic, source_partition, source_offset, is_final,
  open, high, low, close, volume, vwap, trade_count, schema_version
)
SELECT src.*
FROM signal.intraday_bars_1m_v1 AS src FINAL
LEFT ANTI JOIN signal.intraday_bars_1m_v2 AS dst
  ON src.universe_id = dst.universe_id
  AND src.feed = dst.feed
  AND src.symbol = dst.symbol
  AND src.event_ts = dst.event_ts
  AND src.source_topic = dst.source_topic
  AND src.source_partition = dst.source_partition
  AND src.source_offset = dst.source_offset;

SELECT throwIf(
  count() != 0,
  'Signal immutable intraday-bars backfill is incomplete'
)
FROM signal.intraday_bars_1m_v1 AS src FINAL
LEFT ANTI JOIN signal.intraday_bars_1m_v2 AS dst
  ON src.universe_id = dst.universe_id
  AND src.feed = dst.feed
  AND src.symbol = dst.symbol
  AND src.event_ts = dst.event_ts
  AND src.source_topic = dst.source_topic
  AND src.source_partition = dst.source_partition
  AND src.source_offset = dst.source_offset;
