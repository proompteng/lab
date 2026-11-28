SELECT throwIf(
  count() != 1 OR countIf(engine = 'ReplicatedMergeTree') != 1,
  'Feature archive must retain every semantic revision'
) FROM system.tables WHERE database = 'signal' AND name = 'intraday_features_v1';
SELECT throwIf(
  arraySort(groupArray((name, type))) != arraySort([
    ('feature_id', 'FixedString(64)'),
    ('universe_id', 'LowCardinality(String)'),
    ('universe_symbol_hash', 'FixedString(64)'),
    ('feed', 'LowCardinality(String)'),
    ('symbol', 'LowCardinality(String)'),
    ('window_end', 'DateTime64(3, \'UTC\')'),
    ('computed_at', 'DateTime64(3, \'UTC\')'),
    ('archived_at', 'DateTime64(3, \'UTC\')'),
    ('source_topic', 'LowCardinality(String)'),
    ('source_partition', 'UInt32'),
    ('source_offset', 'UInt64'),
    ('payload', 'String')
  ]),
  'Feature archive does not match the expected columns'
) FROM system.columns WHERE database = 'signal' AND table = 'intraday_features_v1';
