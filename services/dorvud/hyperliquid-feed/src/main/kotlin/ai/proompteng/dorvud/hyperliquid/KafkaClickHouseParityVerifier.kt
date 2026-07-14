package ai.proompteng.dorvud.hyperliquid

import java.security.MessageDigest
import java.time.Instant

internal interface KafkaClickHouseParitySource : AutoCloseable {
  fun capture(topicTables: Map<String, String>): List<KafkaPartitionSnapshot>

  fun retainedRecordSet(snapshot: KafkaPartitionSnapshot): KafkaRetainedRecordSet

  override fun close()
}

internal interface KafkaClickHouseParityStore : AutoCloseable {
  fun rangeStats(snapshot: KafkaPartitionSnapshot): KafkaClickHouseLineageRangeStats

  fun offsetCounts(
    snapshot: KafkaPartitionSnapshot,
    offsets: List<Long>,
  ): Map<Long, Long>

  override fun close()
}

internal class KafkaClickHouseParityVerifier(
  private val config: KafkaClickHouseParityConfig,
  private val source: KafkaClickHouseParitySource,
  private val store: KafkaClickHouseParityStore,
  private val now: () -> Instant = Instant::now,
) {
  fun verify(): KafkaClickHouseParityManifest {
    val destinationTables = config.topicTables.mapValues { (_, table) -> config.destinationTable(table) }
    val snapshots =
      source
        .capture(destinationTables)
        .sortedWith(compareBy(KafkaPartitionSnapshot::topic, KafkaPartitionSnapshot::partition))
    val expectedTopics = config.topicTables.keys
    val capturedTopics = snapshots.mapTo(mutableSetOf()) { it.topic }
    val missingTopics = expectedTopics - capturedTopics
    require(missingTopics.isEmpty()) { "Kafka metadata returned no partitions for: ${missingTopics.sorted().joinToString(",")}" }

    val partitionResults = snapshots.map(::verifyPartition)
    val blockers = partitionResults.flatMap { result -> result.blockers.map { blocker -> "${result.topic}:${result.partition}:$blocker" } }
    return KafkaClickHouseParityManifest(
      ok = blockers.isEmpty(),
      capturedAt = now().toString(),
      database = config.clickHouse.database,
      destinationSuffix = config.destinationSuffix,
      topicCount = capturedTopics.size,
      partitionCount = partitionResults.size,
      blockerCount = blockers.size,
      blockers = blockers,
      partitions = partitionResults,
    )
  }

  private fun verifyPartition(snapshot: KafkaPartitionSnapshot): KafkaClickHousePartitionParity {
    require(snapshot.beginningOffset <= snapshot.highWatermarkExclusive) {
      "Kafka offset range is reversed for ${snapshot.topic}-${snapshot.partition}"
    }
    val rangeStats = store.rangeStats(snapshot)
    return when (snapshot.cleanupPolicy) {
      KafkaCleanupPolicy.DELETE_ONLY -> verifyDeleteOnly(snapshot, rangeStats)
      KafkaCleanupPolicy.COMPACT_DELETE -> verifyCompacted(snapshot, rangeStats)
    }
  }

  private fun verifyDeleteOnly(
    snapshot: KafkaPartitionSnapshot,
    rangeStats: KafkaClickHouseLineageRangeStats,
  ): KafkaClickHousePartitionParity {
    val expected = snapshot.highWatermarkExclusive - snapshot.beginningOffset
    val first = snapshot.beginningOffset.takeIf { expected > 0 }
    val last = (snapshot.highWatermarkExclusive - 1).takeIf { expected > 0 }
    val blockers =
      buildList {
        if (rangeStats.rows != expected) add("clickhouse_row_count_mismatch")
        if (rangeStats.distinctOffsets != expected) add("clickhouse_offset_range_not_contiguous")
        if (rangeStats.firstOffset != first) add("clickhouse_first_offset_mismatch")
        if (rangeStats.lastOffset != last) add("clickhouse_last_offset_mismatch")
      }
    val missingCount = (expected - rangeStats.distinctOffsets).coerceAtLeast(0)
    val duplicateCount = (rangeStats.rows - rangeStats.distinctOffsets).coerceAtLeast(0)
    return partitionResult(
      snapshot = snapshot,
      rangeStats = rangeStats,
      manifestKind = "contiguous-offset-range",
      sourceCount = expected,
      sourceFirst = first,
      sourceLast = last,
      sourceSha256 = contiguousRangeFingerprint(snapshot),
      missingCount = missingCount,
      duplicateCount = duplicateCount,
      blockers = blockers,
    )
  }

  private fun verifyCompacted(
    snapshot: KafkaPartitionSnapshot,
    rangeStats: KafkaClickHouseLineageRangeStats,
  ): KafkaClickHousePartitionParity {
    val retained = source.retainedRecordSet(snapshot)
    val offsets = retained.offsets
    val invalidOffsets = offsets.filter { it < snapshot.beginningOffset || it >= snapshot.highWatermarkExclusive }
    val orderingInvalid = offsets.zipWithNext().any { (first, second) -> second <= first }
    require(invalidOffsets.isEmpty() && !orderingInvalid) {
      "Kafka retained record set is invalid for ${snapshot.topic}-${snapshot.partition}"
    }

    val counts =
      offsets
        .chunked(config.offsetQueryBatchSize)
        .flatMap { chunk -> store.offsetCounts(snapshot, chunk).entries }
        .associate { it.key to it.value }
    val missing = offsets.filter { counts[it] == null }
    val duplicates = offsets.filter { (counts[it] ?: 0) > 1 }
    val blockers =
      buildList {
        if (missing.isNotEmpty()) add("retained_offsets_missing_from_clickhouse")
        if (duplicates.isNotEmpty()) add("retained_offsets_duplicated_in_clickhouse")
      }
    return partitionResult(
      snapshot = snapshot,
      rangeStats = rangeStats,
      manifestKind = "retained-record-set",
      sourceCount = offsets.size.toLong(),
      sourceFirst = offsets.firstOrNull(),
      sourceLast = offsets.lastOrNull(),
      sourceSha256 = retained.sha256,
      missingCount = missing.size.toLong(),
      duplicateCount = duplicates.size.toLong(),
      missingSamples = missing.take(20),
      duplicateSamples = duplicates.take(20),
      blockers = blockers,
    )
  }

  private fun partitionResult(
    snapshot: KafkaPartitionSnapshot,
    rangeStats: KafkaClickHouseLineageRangeStats,
    manifestKind: String,
    sourceCount: Long,
    sourceFirst: Long?,
    sourceLast: Long?,
    sourceSha256: String,
    missingCount: Long,
    duplicateCount: Long,
    missingSamples: List<Long> = emptyList(),
    duplicateSamples: List<Long> = emptyList(),
    blockers: List<String>,
  ): KafkaClickHousePartitionParity =
    KafkaClickHousePartitionParity(
      ok = blockers.isEmpty(),
      topic = snapshot.topic,
      table = snapshot.table,
      partition = snapshot.partition,
      cleanupPolicy = snapshot.cleanupPolicy.manifestValue,
      manifestKind = manifestKind,
      beginningOffset = snapshot.beginningOffset,
      highWatermarkExclusive = snapshot.highWatermarkExclusive,
      sourceRetainedRecords = sourceCount,
      sourceFirstOffset = sourceFirst,
      sourceLastOffset = sourceLast,
      sourceRecordSetSha256 = sourceSha256,
      clickHouseRowsInRange = rangeStats.rows,
      clickHouseDistinctOffsetsInRange = rangeStats.distinctOffsets,
      clickHouseFirstOffset = rangeStats.firstOffset,
      clickHouseLastOffset = rangeStats.lastOffset,
      missingRetainedOffsetCount = missingCount,
      duplicateRetainedOffsetCount = duplicateCount,
      missingRetainedOffsetSamples = missingSamples,
      duplicateRetainedOffsetSamples = duplicateSamples,
      blockers = blockers,
    )
}

internal fun contiguousRangeFingerprint(snapshot: KafkaPartitionSnapshot): String =
  sha256(
    listOf(
      "delete",
      snapshot.topic,
      snapshot.partition.toString(),
      snapshot.beginningOffset.toString(),
      snapshot.highWatermarkExclusive.toString(),
    ).joinToString("\u0000").toByteArray(Charsets.UTF_8),
  )

internal fun sha256(bytes: ByteArray): String =
  MessageDigest
    .getInstance("SHA-256")
    .digest(bytes)
    .joinToString("") { byte -> "%02x".format(byte) }
