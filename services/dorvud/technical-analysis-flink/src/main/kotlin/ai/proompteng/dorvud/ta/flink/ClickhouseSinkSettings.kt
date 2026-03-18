package ai.proompteng.dorvud.ta.flink

internal const val DEFAULT_CLICKHOUSE_INSERT_BATCH_SIZE: Int = 25
internal const val MAX_SAFE_CLICKHOUSE_INSERT_BATCH_SIZE: Int = 100
internal const val DEFAULT_CLICKHOUSE_INSERT_FLUSH_MS: Long = 500
internal const val MIN_CLICKHOUSE_INSERT_FLUSH_MS: Long = 250
internal const val DEFAULT_CLICKHOUSE_SINK_PARALLELISM: Int = 2

internal fun normalizeClickhouseInsertBatchSize(requested: Int): Int {
  val boundedBatchSize = requested.coerceIn(1, MAX_SAFE_CLICKHOUSE_INSERT_BATCH_SIZE)
  return boundedBatchSize
}

internal fun normalizeClickhouseInsertFlushMs(requested: Long): Long =
  if (requested <= 0) {
    DEFAULT_CLICKHOUSE_INSERT_FLUSH_MS
  } else {
    requested.coerceAtLeast(MIN_CLICKHOUSE_INSERT_FLUSH_MS)
  }

internal fun normalizeClickhouseSinkParallelism(
  requested: Int,
  streamParallelism: Int,
): Int = requested.coerceIn(1, streamParallelism.coerceAtLeast(1))
