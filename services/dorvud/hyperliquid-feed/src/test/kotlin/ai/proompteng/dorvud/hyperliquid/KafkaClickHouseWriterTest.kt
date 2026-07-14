package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaConsumerSettings
import ai.proompteng.dorvud.platform.KafkaTls
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.consumer.MockConsumer
import org.apache.kafka.common.TopicPartition
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class KafkaClickHouseWriterTest {
  private val json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
      explicitNulls = false
    }

  @Test
  fun `inserts one partition batch before committing its next offset`() {
    val topicPartition = TopicPartition(TOPIC, 0)
    val consumer = mockConsumer(topicPartition, endOffset = 2)
    consumer.addRecord(record(offset = 0))
    consumer.addRecord(record(offset = 1))
    val store = RecordingStore()
    val writer = writer(consumer = consumer, store = store, batchSize = 2)

    writer.pollOnce()

    assertEquals(listOf(0L, 1L), store.inserted.single().map { it.offset })
    assertEquals(2L, consumer.committed(setOf(topicPartition))[topicPartition]?.offset())
    assertEquals(1, store.persistedCalls)
    assertEquals(64, store.tokens.single().length)
  }

  @Test
  fun `reconciles an acknowledged insert after a commit-path failure`() {
    val topicPartition = TopicPartition(TOPIC, 0)
    val consumer = mockConsumer(topicPartition, endOffset = 1)
    consumer.addRecord(record(offset = 0))
    var nowMs = 1_000L
    val store =
      RecordingStore(
        insertFailure =
          KafkaClickHouseStoreException(
            "ambiguous insert response",
            IllegalStateException("connection closed"),
          ),
      )
    val state = KafkaClickHouseWriterState(readinessMaxAgeMs = 360_000, nowMs = { nowMs })
    val writer =
      writer(
        consumer = consumer,
        store = store,
        batchSize = 1,
        state = state,
        nowMs = { nowMs },
      )

    writer.pollOnce()
    assertEquals("clickhouse_failed", state.snapshot().lastErrorCode)
    assertEquals(null, consumer.committed(setOf(topicPartition))[topicPartition])

    store.insertFailure = null
    store.persisted = setOf(0)
    nowMs += 2_000
    writer.pollOnce()

    assertEquals(0, store.inserted.size)
    assertEquals(2, store.persistedCalls)
    assertEquals(1L, consumer.committed(setOf(topicPartition))[topicPartition]?.offset())
    assertTrue(state.snapshot().ready)
  }

  @Test
  fun `inserts only offsets missing from the lineage table`() {
    val topicPartition = TopicPartition(TOPIC, 0)
    val consumer = mockConsumer(topicPartition, endOffset = 2)
    consumer.addRecord(record(offset = 0))
    consumer.addRecord(record(offset = 1))
    val store = RecordingStore(persisted = setOf(0))
    val writer = writer(consumer = consumer, store = store, batchSize = 2)

    writer.pollOnce()

    assertEquals(listOf(1L), store.inserted.single().map { it.offset })
    assertEquals(2L, consumer.committed(setOf(topicPartition))[topicPartition]?.offset())
  }

  @Test
  fun `retains an invalid envelope without advancing the consumer group`() {
    val topicPartition = TopicPartition(TOPIC, 0)
    val consumer = mockConsumer(topicPartition, endOffset = 1)
    consumer.addRecord(ConsumerRecord(TOPIC, 0, 0, "key", "not-json"))
    val store = RecordingStore()
    val state = KafkaClickHouseWriterState(readinessMaxAgeMs = 360_000)
    val writer = writer(consumer = consumer, store = store, batchSize = 1, state = state)

    writer.pollOnce()

    assertEquals(null, consumer.committed(setOf(topicPartition))[topicPartition])
    assertEquals(0, store.inserted.size)
    assertEquals("invalid_envelope", state.snapshot().lastErrorCode)
    assertEquals(1, state.snapshot().pendingRecords)
  }

  @Test
  fun `allows compacted offset gaps while preserving the exact token material`() {
    val first = kafkaRecord(offset = 10)
    val second = kafkaRecord(offset = 13)

    val token = kafkaBatchDeduplicationToken(listOf(first, second))

    assertEquals(token, kafkaBatchDeduplicationToken(listOf(first, second)))
    assertNotEquals(token, kafkaBatchDeduplicationToken(listOf(first, kafkaRecord(offset = 12))))
  }

  @Test
  fun `writer state requires assignment polling and a successful commit`() {
    var nowMs = 10_000L
    val state = KafkaClickHouseWriterState(readinessMaxAgeMs = 1_000, nowMs = { nowMs })
    state.markRunning(1)
    state.markPoll()

    assertFalse(state.snapshot().ready)

    state.markCommit("partition:a:0")
    assertTrue(state.snapshot().ready)

    state.markConsumerLag(total = 48_000, maximum = 1_000)
    assertTrue(state.snapshot().ready)
    state.markConsumerLag(total = 1_001, maximum = 1_001)
    assertFalse(state.snapshot().ready)
    state.markConsumerLag(total = 0, maximum = 0)

    nowMs += 1_001
    assertFalse(state.snapshot().ready)
  }

  @Test
  fun `successful commit clears only its own partition failure`() {
    val state = KafkaClickHouseWriterState(readinessMaxAgeMs = 360_000)
    state.markRunning(2)
    state.markPoll()
    state.markError("partition:a:0", "clickhouse_failed", "a failed")
    state.markError("partition:a:1", "invalid_envelope", "b failed")

    state.markCommit("partition:a:0")

    assertFalse(state.snapshot().ready)
    assertEquals(1, state.snapshot().unresolvedErrors)
    assertEquals("invalid_envelope", state.snapshot().lastErrorCode)

    state.markCommit("partition:a:1")
    assertTrue(state.snapshot().ready)
  }

  private fun writer(
    consumer: MockConsumer<String, String>,
    store: RecordingStore,
    batchSize: Int,
    state: KafkaClickHouseWriterState = KafkaClickHouseWriterState(360_000),
    nowMs: () -> Long = System::currentTimeMillis,
  ): KafkaClickHouseWriter =
    KafkaClickHouseWriter(
      config = config(batchSize),
      consumer = consumer,
      store = store,
      state = state,
      metrics = KafkaClickHouseWriterMetrics(SimpleMeterRegistry()),
      json = json,
      nowMs = nowMs,
      retryJitter = { 0 },
    )

  private fun config(batchSize: Int): KafkaClickHouseWriterConfig =
    KafkaClickHouseWriterConfig(
      kafka =
        KafkaConsumerSettings(
          bootstrapServers = "kafka:9092",
          groupId = "writer-test",
          clientId = "writer-test",
          maxPollRecords = 10,
          auth = KafkaAuth("writer", "secret"),
          tls = KafkaTls(),
        ),
      topicTables = mapOf(TOPIC to TABLE),
      destinationSuffix = "_kafka_staging",
      clickHouse =
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
          enabledTables = setOf(TABLE),
        ),
      pollMs = 10,
      retryInitialMs = 1_000,
      retryMaxMs = 30_000,
      lagRefreshMs = 30_000,
      kafkaOperationTimeoutMs = 10_000,
      maxFlushesPerPoll = 4,
      shutdownFlushTimeoutMs = 45_000,
      consumerCloseTimeoutMs = 10_000,
      maxBufferedRecordsPerPartition = 100,
      readinessMaxAgeMs = 360_000,
      readinessMaxPartitionLagRecords = 1_000,
      healthPort = 8080,
      metricsPort = 9090,
      batchPolicies = mapOf(TABLE to KafkaWriterBatchPolicy(batchSize = batchSize, maxAgeMs = 300_000)),
    )

  private fun mockConsumer(
    topicPartition: TopicPartition,
    endOffset: Long,
  ): MockConsumer<String, String> =
    MockConsumer<String, String>("earliest").also { consumer ->
      consumer.assign(listOf(topicPartition))
      consumer.updateBeginningOffsets(mapOf(topicPartition to 0L))
      consumer.updateEndOffsets(mapOf(topicPartition to endOffset))
    }

  private fun record(offset: Long): ConsumerRecord<String, String> =
    ConsumerRecord(TOPIC, 0, offset, "key-$offset", json.encodeToString(envelope(offset)))

  private fun kafkaRecord(offset: Long): KafkaClickHouseRecord =
    KafkaClickHouseRecord(
      topic = TOPIC,
      partition = 0,
      offset = offset,
      key = "key-$offset",
      envelope = envelope(offset),
    )

  private fun envelope(offset: Long): HyperliquidEnvelope =
    HyperliquidEnvelope(
      ingestTs = "2026-07-14T12:00:00Z",
      eventTs = "2026-07-14T12:00:00Z",
      network = "mainnet",
      feed = "websocket",
      channel = "bbo",
      symbol = "BTC",
      marketType = "perp",
      marketId = "hl:perp:default:BTC",
      dex = null,
      coin = "BTC",
      spotIndex = null,
      seq = offset,
      source = "ws",
      payload = buildJsonObject { put("px", "100000") },
    )

  private class RecordingStore(
    var persisted: Set<Long> = emptySet(),
    var insertFailure: KafkaClickHouseStoreException? = null,
  ) : KafkaClickHouseStore {
    val inserted = mutableListOf<List<KafkaClickHouseRecord>>()
    val tokens = mutableListOf<String>()
    var persistedCalls = 0

    override fun persistedOffsets(
      table: String,
      topic: String,
      partition: Int,
      firstOffset: Long,
      lastOffset: Long,
    ): Set<Long> {
      persistedCalls += 1
      return persisted
    }

    override fun insert(
      table: String,
      records: List<KafkaClickHouseRecord>,
      deduplicationToken: String,
    ): KafkaClickHouseInsertResult {
      insertFailure?.let { throw it }
      inserted += records
      tokens += deduplicationToken
      return KafkaClickHouseInsertResult(records.size, records.size * 100)
    }

    override fun close() = Unit
  }

  private companion object {
    const val TOPIC = "torghut.hyperliquid.bbo.v1"
    const val TABLE = "hyperliquid_bbo"
  }
}
