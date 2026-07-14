package ai.proompteng.dorvud.hyperliquid

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import org.apache.kafka.clients.consumer.CloseOptions
import org.apache.kafka.clients.consumer.Consumer
import org.apache.kafka.clients.consumer.ConsumerRebalanceListener
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.consumer.OffsetAndMetadata
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.errors.WakeupException
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.random.Random

private val writerLogger = KotlinLogging.logger {}
private const val CONSUMER_ERROR_SCOPE = "kafka-consumer"

private data class PartitionBuffer(
  val records: ArrayDeque<ConsumerRecord<String, String>> = ArrayDeque(),
  var firstBufferedAtMs: Long = 0,
  var retryAtMs: Long = 0,
  var failureCount: Int = 0,
  var requiresReconciliation: Boolean = true,
)

class KafkaClickHouseWriter(
  private val config: KafkaClickHouseWriterConfig,
  private val consumer: Consumer<String, String>,
  private val store: KafkaClickHouseStore,
  private val state: KafkaClickHouseWriterState,
  private val metrics: KafkaClickHouseWriterMetrics,
  private val json: Json,
  private val nowMs: () -> Long = System::currentTimeMillis,
  private val retryJitter: (Long) -> Long = { base -> Random.nextLong((base / 5).coerceAtLeast(1) + 1) },
) {
  private val running = AtomicBoolean(true)
  private val buffers = mutableMapOf<TopicPartition, PartitionBuffer>()
  private var lastLagRefreshMs = 0L

  fun run() {
    consumer.subscribe(config.topicTables.keys, rebalanceListener())
    try {
      while (running.get()) {
        pollOnce()
      }
    } catch (wakeup: WakeupException) {
      if (running.get()) throw wakeup
    } finally {
      shutdown()
    }
  }

  fun stop() {
    if (running.compareAndSet(true, false)) consumer.wakeup()
  }

  internal fun pollOnce() {
    try {
      val records = consumer.poll(Duration.ofMillis(config.pollMs))
      state.markPoll()
      records.partitions().forEach { topicPartition ->
        records.records(topicPartition).forEach { record -> addRecord(topicPartition, record) }
      }
      flushDue(force = false)
      updateConsumerLag()
      state.clearError(CONSUMER_ERROR_SCOPE)
      updateOperationalState()
    } catch (error: KafkaException) {
      state.markError(CONSUMER_ERROR_SCOPE, "kafka_poll_failed", error.message.orEmpty())
      updateOperationalState()
      Thread.sleep(config.retryInitialMs)
    }
  }

  private fun addRecord(
    topicPartition: TopicPartition,
    record: ConsumerRecord<String, String>,
  ) {
    val buffer = buffers.getOrPut(topicPartition) { PartitionBuffer() }
    val previousOffset = buffer.records.lastOrNull()?.offset()
    require(previousOffset == null || record.offset() > previousOffset) {
      "Kafka offsets must increase within ${topicPartition.topic()}-${topicPartition.partition()}"
    }
    if (buffer.records.isEmpty()) buffer.firstBufferedAtMs = nowMs()
    buffer.records.addLast(record)
    val pauseThreshold = (config.maxBufferedRecordsPerPartition - config.kafka.maxPollRecords).coerceAtLeast(1)
    if (buffer.records.size >= pauseThreshold) consumer.pause(setOf(topicPartition))
    check(buffer.records.size <= config.maxBufferedRecordsPerPartition) {
      "Kafka partition buffer exceeded ${config.maxBufferedRecordsPerPartition} records"
    }
  }

  private fun flushDue(
    force: Boolean,
    maxFlushes: Int = config.maxFlushesPerPoll,
  ) {
    var flushes = 0
    for (topicPartition in buffers.keys.toList()) {
      if (flushes >= maxFlushes) return
      val buffer = buffers[topicPartition] ?: continue
      if (buffer.records.isEmpty()) continue
      val sourceTable = checkNotNull(config.topicTables[topicPartition.topic()])
      val policy = config.batchPolicy(sourceTable)
      val observedAt = nowMs()
      val reason =
        when {
          force -> "rebalance"
          buffer.records.size >= policy.batchSize -> "size"
          observedAt - buffer.firstBufferedAtMs >= policy.maxAgeMs -> "age"
          else -> continue
        }
      if (!force && observedAt < buffer.retryAtMs) continue
      if (!flushOne(topicPartition, buffer, sourceTable, policy.batchSize, reason)) return
      flushes += 1
    }
  }

  private fun flushOne(
    topicPartition: TopicPartition,
    buffer: PartitionBuffer,
    sourceTable: String,
    batchSize: Int,
    reason: String,
  ): Boolean {
    val consumerRecords = buffer.records.take(batchSize)
    if (consumerRecords.isEmpty()) return true
    val destinationTable = config.destinationTable(sourceTable)
    val batch =
      try {
        consumerRecords.map { record ->
          KafkaClickHouseRecord(
            topic = record.topic(),
            partition = record.partition(),
            offset = record.offset(),
            key = record.key().orEmpty(),
            envelope = json.decodeFromString<HyperliquidEnvelope>(record.value()),
          )
        }
      } catch (error: SerializationException) {
        recordFailure(topicPartition, buffer, destinationTable, "invalid_envelope", error)
        return false
      }

    val startedAt = System.nanoTime()
    try {
      val persistedOffsets =
        if (buffer.requiresReconciliation) {
          store.persistedOffsets(
            table = destinationTable,
            topic = topicPartition.topic(),
            partition = topicPartition.partition(),
            firstOffset = batch.first().offset,
            lastOffset = batch.last().offset,
          )
        } else {
          emptySet()
        }
      val expectedOffsets = batch.mapTo(mutableSetOf()) { it.offset }
      val reconciledOffsets = persistedOffsets intersect expectedOffsets
      metrics.recordReconciledOffsets(destinationTable, reconciledOffsets.size)
      val missing = batch.filterNot { it.offset in reconciledOffsets }
      val insertResult =
        if (missing.isEmpty()) {
          KafkaClickHouseInsertResult(rows = 0, bytes = 0)
        } else {
          store.insert(
            table = destinationTable,
            records = missing,
            deduplicationToken = kafkaBatchDeduplicationToken(missing),
          )
        }
      consumer.commitSync(
        mapOf(topicPartition to OffsetAndMetadata(batch.last().offset + 1)),
        Duration.ofMillis(config.kafkaOperationTimeoutMs),
      )
      repeat(consumerRecords.size) { buffer.records.removeFirst() }
      buffer.failureCount = 0
      buffer.retryAtMs = 0
      buffer.requiresReconciliation = false
      if (buffer.records.isEmpty()) buffer.firstBufferedAtMs = 0
      state.markCommit(partitionScope(topicPartition))
      metrics.recordFlush(
        table = destinationTable,
        reason = reason,
        rows = insertResult.rows,
        bytes = insertResult.bytes,
        durationNanos = System.nanoTime() - startedAt,
      )
      maybeResume(topicPartition, buffer)
      return true
    } catch (error: KafkaClickHouseStoreException) {
      recordFailure(topicPartition, buffer, destinationTable, "clickhouse_failed", error)
    } catch (error: KafkaException) {
      recordFailure(topicPartition, buffer, destinationTable, "kafka_commit_failed", error)
    } catch (error: IllegalArgumentException) {
      recordFailure(topicPartition, buffer, destinationTable, "lineage_validation_failed", error)
    }
    return false
  }

  private fun recordFailure(
    topicPartition: TopicPartition,
    buffer: PartitionBuffer,
    table: String,
    code: String,
    error: Exception,
  ) {
    buffer.failureCount += 1
    buffer.requiresReconciliation = true
    val exponent = (buffer.failureCount - 1).coerceIn(0, 10)
    val baseDelay = min(config.retryMaxMs, config.retryInitialMs * (1L shl exponent))
    buffer.retryAtMs = nowMs() + min(config.retryMaxMs, baseDelay + retryJitter(baseDelay))
    state.markError(partitionScope(topicPartition), code, error.message.orEmpty())
    metrics.recordFailure(table, code)
    writerLogger.warn(error) {
      "Kafka ClickHouse flush failed table=$table code=$code retry_ms=${buffer.retryAtMs - nowMs()}"
    }
  }

  private fun maybeResume(
    topicPartition: TopicPartition,
    buffer: PartitionBuffer,
  ) {
    val resumeThreshold = (config.maxBufferedRecordsPerPartition - config.kafka.maxPollRecords).coerceAtLeast(1)
    if (buffer.records.size < resumeThreshold && topicPartition in consumer.paused()) {
      consumer.resume(setOf(topicPartition))
    }
  }

  private fun updateConsumerLag() {
    val observedAt = nowMs()
    if (lastLagRefreshMs > 0 && observedAt - lastLagRefreshMs < config.lagRefreshMs) return
    val assignment = consumer.assignment()
    if (assignment.isEmpty()) {
      state.markConsumerLag(total = 0, maximum = 0)
      lastLagRefreshMs = observedAt
      return
    }
    val endOffsets = consumer.endOffsets(assignment, Duration.ofMillis(config.kafkaOperationTimeoutMs))
    val committedOffsets = consumer.committed(assignment, Duration.ofMillis(config.kafkaOperationTimeoutMs))
    val missingCommitted = assignment.filter { committedOffsets[it] == null }
    val beginningOffsets =
      if (missingCommitted.isEmpty()) {
        emptyMap()
      } else {
        consumer.beginningOffsets(missingCommitted, Duration.ofMillis(config.kafkaOperationTimeoutMs))
      }
    val partitionLags =
      assignment.map { topicPartition ->
        val durableOffset = committedOffsets[topicPartition]?.offset() ?: beginningOffsets.getValue(topicPartition)
        (endOffsets.getValue(topicPartition) - durableOffset).coerceAtLeast(0)
      }
    state.markConsumerLag(total = partitionLags.sum(), maximum = partitionLags.maxOrNull() ?: 0)
    lastLagRefreshMs = observedAt
  }

  private fun updateOperationalState() {
    state.markRunning(consumer.assignment().size)
    state.markPending(buffers.values.sumOf { it.records.size })
    metrics.update(state.snapshot())
  }

  private fun rebalanceListener(): ConsumerRebalanceListener =
    object : ConsumerRebalanceListener {
      override fun onPartitionsRevoked(partitions: Collection<TopicPartition>) {
        var remainingFlushes = config.maxFlushesPerPoll
        partitions.forEach { topicPartition ->
          val buffer = buffers[topicPartition] ?: return@forEach
          while (buffer.records.isNotEmpty() && remainingFlushes > 0) {
            val sourceTable = checkNotNull(config.topicTables[topicPartition.topic()])
            val policy = config.batchPolicy(sourceTable)
            if (!flushOne(topicPartition, buffer, sourceTable, policy.batchSize, "rebalance")) break
            remainingFlushes -= 1
          }
          buffers.remove(topicPartition)
        }
        updateOperationalState()
      }

      override fun onPartitionsAssigned(partitions: Collection<TopicPartition>) {
        partitions.forEach { topicPartition ->
          buffers.getOrPut(topicPartition) { PartitionBuffer() }.requiresReconciliation = true
        }
        updateOperationalState()
      }
    }

  private fun shutdown() {
    running.set(false)
    val deadline = System.nanoTime() + Duration.ofMillis(config.shutdownFlushTimeoutMs).toNanos()
    val worstCaseFlushNanos =
      Duration.ofMillis((config.clickHouse.requestTimeoutMs * 2) + config.kafkaOperationTimeoutMs).toNanos()
    runCatching {
      while (
        buffers.values.any { it.records.isNotEmpty() } &&
        System.nanoTime() + worstCaseFlushNanos <= deadline
      ) {
        val pendingBefore = buffers.values.sumOf { it.records.size }
        flushDue(force = true, maxFlushes = 1)
        val pendingAfter = buffers.values.sumOf { it.records.size }
        if (pendingAfter >= pendingBefore) break
      }
    }
    runCatching { consumer.close(CloseOptions.timeout(Duration.ofMillis(config.consumerCloseTimeoutMs))) }
    runCatching { store.close() }
    state.markStopped()
    metrics.update(state.snapshot())
  }

  private fun partitionScope(topicPartition: TopicPartition): String = "partition:${topicPartition.topic()}:${topicPartition.partition()}"
}
