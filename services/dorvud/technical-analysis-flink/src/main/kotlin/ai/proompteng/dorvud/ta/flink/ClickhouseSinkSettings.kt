package ai.proompteng.dorvud.ta.flink

internal const val DEFAULT_CLICKHOUSE_INSERT_BATCH_SIZE: Int = 100
internal const val MAX_SAFE_CLICKHOUSE_INSERT_BATCH_SIZE: Int = 100
internal const val DEFAULT_CLICKHOUSE_INSERT_FLUSH_MS: Long = 250
internal const val MIN_CLICKHOUSE_INSERT_FLUSH_MS: Long = 100

internal fun normalizeClickhouseInsertBatchSize(requested: Int): Int =
  requested.coerceIn(1, MAX_SAFE_CLICKHOUSE_INSERT_BATCH_SIZE)

internal fun normalizeClickhouseInsertFlushMs(requested: Long): Long =
  if (requested <= 0) {
    DEFAULT_CLICKHOUSE_INSERT_FLUSH_MS
  } else {
    requested.coerceAtLeast(MIN_CLICKHOUSE_INSERT_FLUSH_MS)
  }
