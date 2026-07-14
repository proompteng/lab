package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaConsumerSettings
import ai.proompteng.dorvud.platform.KafkaTls
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KafkaClickHouseParityVerifierTest {
  @Test
  fun `accepts only the two retention contracts supported by cutover`() {
    assertEquals(KafkaCleanupPolicy.DELETE_ONLY, parseKafkaCleanupPolicy(TOPIC, "delete"))
    assertEquals(KafkaCleanupPolicy.COMPACT_DELETE, parseKafkaCleanupPolicy(TOPIC, "delete,compact"))
    assertFailsWith<IllegalStateException> { parseKafkaCleanupPolicy(TOPIC, "compact") }
  }

  @Test
  fun `accepts a contiguous delete-only range exactly once`() {
    val snapshot = snapshot(KafkaCleanupPolicy.DELETE_ONLY, beginning = 10, high = 14)
    val source = FakeSource(snapshot)
    val store = FakeStore(stats = stats(rows = 4, distinct = 4, first = 10, last = 13))

    val manifest = verifier(source, store).verify()

    assertTrue(manifest.ok)
    val partition = manifest.partitions.single()
    assertEquals("contiguous-offset-range", partition.manifestKind)
    assertEquals(4, partition.sourceRetainedRecords)
    assertEquals(64, partition.sourceRecordSetSha256.length)
    assertEquals(0, source.retainedReads)
  }

  @Test
  fun `rejects gaps and duplicate rows for a delete-only topic`() {
    val snapshot = snapshot(KafkaCleanupPolicy.DELETE_ONLY, beginning = 10, high = 14)
    val store = FakeStore(stats = stats(rows = 4, distinct = 3, first = 10, last = 13))

    val manifest = verifier(FakeSource(snapshot), store).verify()

    assertFalse(manifest.ok)
    assertTrue(manifest.blockers.any { it.endsWith("clickhouse_offset_range_not_contiguous") })
    assertEquals(1, manifest.partitions.single().missingRetainedOffsetCount)
    assertEquals(1, manifest.partitions.single().duplicateRetainedOffsetCount)
  }

  @Test
  fun `accepts compacted offset holes when every retained record exists once`() {
    val snapshot = snapshot(KafkaCleanupPolicy.COMPACT_DELETE, beginning = 10, high = 20)
    val retained = KafkaRetainedRecordSet(offsets = listOf(10, 13, 19), sha256 = "a".repeat(64))
    val source = FakeSource(snapshot, retained)
    val store =
      FakeStore(
        stats = stats(rows = 5, distinct = 5, first = 10, last = 19),
        counts = mapOf(10L to 1L, 13L to 1L, 19L to 1L),
      )

    val manifest = verifier(source, store).verify()

    assertTrue(manifest.ok)
    val partition = manifest.partitions.single()
    assertEquals("retained-record-set", partition.manifestKind)
    assertEquals(3, partition.sourceRetainedRecords)
    assertEquals(5, partition.clickHouseDistinctOffsetsInRange)
    assertEquals(1, source.retainedReads)
  }

  @Test
  fun `reports samples for missing and duplicate compacted offsets`() {
    val snapshot = snapshot(KafkaCleanupPolicy.COMPACT_DELETE, beginning = 10, high = 20)
    val retained = KafkaRetainedRecordSet(offsets = listOf(10, 13, 19), sha256 = "b".repeat(64))
    val store =
      FakeStore(
        stats = stats(rows = 3, distinct = 2, first = 10, last = 19),
        counts = mapOf(10L to 2L, 19L to 1L),
      )

    val manifest = verifier(FakeSource(snapshot, retained), store).verify()

    assertFalse(manifest.ok)
    val partition = manifest.partitions.single()
    assertEquals(listOf(13L), partition.missingRetainedOffsetSamples)
    assertEquals(listOf(10L), partition.duplicateRetainedOffsetSamples)
    assertEquals(2, manifest.blockerCount)
  }

  private fun verifier(
    source: KafkaClickHouseParitySource,
    store: KafkaClickHouseParityStore,
  ): KafkaClickHouseParityVerifier =
    KafkaClickHouseParityVerifier(
      config = config(),
      source = source,
      store = store,
      now = { Instant.parse("2026-07-14T16:00:00Z") },
    )

  private fun config(): KafkaClickHouseParityConfig =
    KafkaClickHouseParityConfig(
      kafka =
        KafkaConsumerSettings(
          bootstrapServers = "kafka:9092",
          groupId = "parity",
          clientId = "parity",
          auth = KafkaAuth("writer", "secret"),
          tls = KafkaTls(),
        ),
      topicTables = mapOf(TOPIC to "hyperliquid_bbo"),
      destinationSuffix = "_kafka_staging",
      clickHouse = clickHouseConfig(),
      operationTimeoutMs = 10_000,
      pollTimeoutMs = 100,
      maxIdlePolls = 3,
      maxCompactedRecordsPerPartition = 100,
      offsetQueryBatchSize = 2,
      maxRuntimeMs = 60_000,
    )

  private fun clickHouseConfig(): ClickHouseConfig =
    ClickHouseConfig(
      enabled = true,
      requiredForReadiness = true,
      httpUrl = "http://clickhouse:8123",
      database = "torghut",
      username = "torghut",
      password = "secret",
      batchSize = 100,
      flushMs = 30_000,
      requestTimeoutMs = 10_000,
      readyMaxAgeMs = 360_000,
      failureHoldMs = 1_000,
      enabledTables = setOf("hyperliquid_bbo"),
    )

  private fun snapshot(
    policy: KafkaCleanupPolicy,
    beginning: Long,
    high: Long,
  ): KafkaPartitionSnapshot =
    KafkaPartitionSnapshot(
      topic = TOPIC,
      table = "hyperliquid_bbo_kafka_staging",
      partition = 2,
      cleanupPolicy = policy,
      beginningOffset = beginning,
      highWatermarkExclusive = high,
    )

  private fun stats(
    rows: Long,
    distinct: Long,
    first: Long?,
    last: Long?,
  ): KafkaClickHouseLineageRangeStats =
    KafkaClickHouseLineageRangeStats(
      rows = rows,
      distinctOffsets = distinct,
      firstOffset = first,
      lastOffset = last,
    )

  private class FakeSource(
    private val snapshot: KafkaPartitionSnapshot,
    private val retained: KafkaRetainedRecordSet = KafkaRetainedRecordSet(emptyList(), "0".repeat(64)),
  ) : KafkaClickHouseParitySource {
    var retainedReads = 0

    override fun capture(topicTables: Map<String, String>): List<KafkaPartitionSnapshot> {
      assertEquals(snapshot.table, topicTables.getValue(snapshot.topic))
      return listOf(snapshot)
    }

    override fun retainedRecordSet(snapshot: KafkaPartitionSnapshot): KafkaRetainedRecordSet {
      retainedReads += 1
      return retained
    }

    override fun close() = Unit
  }

  private class FakeStore(
    private val stats: KafkaClickHouseLineageRangeStats,
    private val counts: Map<Long, Long> = emptyMap(),
  ) : KafkaClickHouseParityStore {
    override fun rangeStats(snapshot: KafkaPartitionSnapshot): KafkaClickHouseLineageRangeStats = stats

    override fun offsetCounts(
      snapshot: KafkaPartitionSnapshot,
      offsets: List<Long>,
    ): Map<Long, Long> = counts.filterKeys { it in offsets }

    override fun close() = Unit
  }

  private companion object {
    const val TOPIC = "torghut.hyperliquid.bbo.v1"
  }
}
