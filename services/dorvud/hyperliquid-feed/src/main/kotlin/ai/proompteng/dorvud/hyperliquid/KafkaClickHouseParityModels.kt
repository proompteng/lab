package ai.proompteng.dorvud.hyperliquid

import kotlinx.serialization.Serializable

internal enum class KafkaCleanupPolicy(
  val manifestValue: String,
) {
  DELETE_ONLY("delete"),
  COMPACT_DELETE("compact,delete"),
}

internal data class KafkaPartitionSnapshot(
  val topic: String,
  val table: String,
  val partition: Int,
  val cleanupPolicy: KafkaCleanupPolicy,
  val beginningOffset: Long,
  val highWatermarkExclusive: Long,
)

internal data class KafkaRetainedRecordSet(
  val offsets: List<Long>,
  val sha256: String,
)

internal data class KafkaClickHouseLineageRangeStats(
  val rows: Long,
  val distinctOffsets: Long,
  val firstOffset: Long?,
  val lastOffset: Long?,
)

@Serializable
internal data class KafkaClickHouseParityManifest(
  val schemaVersion: String = "torghut.kafka-clickhouse-parity.v1",
  val ok: Boolean,
  val capturedAt: String,
  val database: String,
  val destinationSuffix: String,
  val topicCount: Int,
  val partitionCount: Int,
  val blockerCount: Int,
  val blockers: List<String>,
  val partitions: List<KafkaClickHousePartitionParity>,
)

@Serializable
internal data class KafkaClickHousePartitionParity(
  val ok: Boolean,
  val topic: String,
  val table: String,
  val partition: Int,
  val cleanupPolicy: String,
  val manifestKind: String,
  val beginningOffset: Long,
  val highWatermarkExclusive: Long,
  val sourceRetainedRecords: Long,
  val sourceFirstOffset: Long?,
  val sourceLastOffset: Long?,
  val sourceRecordSetSha256: String,
  val clickHouseRowsInRange: Long,
  val clickHouseDistinctOffsetsInRange: Long,
  val clickHouseFirstOffset: Long?,
  val clickHouseLastOffset: Long?,
  val missingRetainedOffsetCount: Long,
  val duplicateRetainedOffsetCount: Long,
  val missingRetainedOffsetSamples: List<Long>,
  val duplicateRetainedOffsetSamples: List<Long>,
  val blockers: List<String>,
)
