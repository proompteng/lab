package ai.proompteng.dorvud.hyperliquid

import org.apache.kafka.clients.admin.Admin
import org.apache.kafka.clients.consumer.CloseOptions
import org.apache.kafka.clients.consumer.Consumer
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.config.ConfigResource
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.time.Duration
import java.util.concurrent.TimeUnit

internal class LiveKafkaClickHouseParitySource(
  private val config: KafkaClickHouseParityConfig,
  private val consumer: Consumer<String, String>,
  private val admin: Admin,
  private val nowMs: () -> Long = System::currentTimeMillis,
) : KafkaClickHouseParitySource {
  private var deadlineMs: Long = Long.MAX_VALUE

  override fun capture(topicTables: Map<String, String>): List<KafkaPartitionSnapshot> {
    deadlineMs = nowMs() + config.maxRuntimeMs
    val topics = topicTables.keys.sorted()
    val resources = topics.associateWith { topic -> ConfigResource(ConfigResource.Type.TOPIC, topic) }
    val topicConfigs =
      admin
        .describeConfigs(resources.values)
        .all()
        .get(config.operationTimeoutMs, TimeUnit.MILLISECONDS)
    val policies =
      resources.mapValues { (topic, resource) ->
        val cleanupPolicy = topicConfigs.getValue(resource).get("cleanup.policy")?.value()
        parseKafkaCleanupPolicy(topic, cleanupPolicy)
      }
    val topicPartitions =
      topics.flatMap { topic ->
        val partitions = consumer.partitionsFor(topic, Duration.ofMillis(config.operationTimeoutMs))
        require(partitions.isNotEmpty()) { "Kafka topic $topic has no partitions" }
        partitions.map { info -> TopicPartition(topic, info.partition()) }
      }
    val beginningOffsets = consumer.beginningOffsets(topicPartitions, Duration.ofMillis(config.operationTimeoutMs))
    val highWatermarks = consumer.endOffsets(topicPartitions, Duration.ofMillis(config.operationTimeoutMs))
    return topicPartitions.map { topicPartition ->
      KafkaPartitionSnapshot(
        topic = topicPartition.topic(),
        table = topicTables.getValue(topicPartition.topic()),
        partition = topicPartition.partition(),
        cleanupPolicy = policies.getValue(topicPartition.topic()),
        beginningOffset = beginningOffsets.getValue(topicPartition),
        highWatermarkExclusive = highWatermarks.getValue(topicPartition),
      )
    }
  }

  override fun retainedRecordSet(snapshot: KafkaPartitionSnapshot): KafkaRetainedRecordSet {
    require(snapshot.cleanupPolicy == KafkaCleanupPolicy.COMPACT_DELETE) {
      "Retained record enumeration is only valid for compact,delete topics"
    }
    val topicPartition = TopicPartition(snapshot.topic, snapshot.partition)
    consumer.assign(listOf(topicPartition))
    consumer.seek(topicPartition, snapshot.beginningOffset)
    val offsets = ArrayList<Long>()
    val digest = MessageDigest.getInstance("SHA-256")
    updateDigest(digest, snapshot.topic)
    updateDigest(digest, snapshot.partition.toLong())
    updateDigest(digest, snapshot.beginningOffset)
    updateDigest(digest, snapshot.highWatermarkExclusive)
    var idlePolls = 0

    while (position(topicPartition) < snapshot.highWatermarkExclusive) {
      checkDeadline(snapshot)
      val polled = consumer.poll(Duration.ofMillis(config.pollTimeoutMs)).records(topicPartition)
      val retained = polled.filter { record -> record.offset() < snapshot.highWatermarkExclusive }
      if (retained.isEmpty()) {
        if (position(topicPartition) < snapshot.highWatermarkExclusive) {
          idlePolls += 1
          check(idlePolls <= config.maxIdlePolls) {
            "Kafka retained-set scan made no progress for ${snapshot.topic}-${snapshot.partition}"
          }
        }
        continue
      }

      idlePolls = 0
      retained.forEach { record ->
        check(record.offset() >= snapshot.beginningOffset) {
          "Kafka returned an offset below the captured beginning offset"
        }
        check(offsets.isEmpty() || record.offset() > offsets.last()) {
          "Kafka returned non-increasing retained offsets"
        }
        check(offsets.size < config.maxCompactedRecordsPerPartition) {
          "Kafka retained-set scan exceeded CLICKHOUSE_PARITY_MAX_COMPACTED_RECORDS_PER_PARTITION"
        }
        offsets += record.offset()
        updateDigest(digest, record.offset())
        updateDigest(digest, record.key())
        updateDigest(digest, record.value())
      }
    }

    return KafkaRetainedRecordSet(
      offsets = offsets,
      sha256 = digest.digest().joinToString("") { byte -> "%02x".format(byte) },
    )
  }

  override fun close() {
    runCatching { consumer.close(CloseOptions.timeout(Duration.ofMillis(config.operationTimeoutMs))) }
    runCatching { admin.close() }
  }

  private fun position(topicPartition: TopicPartition): Long =
    consumer.position(topicPartition, Duration.ofMillis(config.operationTimeoutMs))

  private fun checkDeadline(snapshot: KafkaPartitionSnapshot) {
    check(nowMs() <= deadlineMs) {
      "Kafka retained-set scan exceeded CLICKHOUSE_PARITY_MAX_RUNTIME_MS at ${snapshot.topic}-${snapshot.partition}"
    }
  }
}

internal fun parseKafkaCleanupPolicy(
  topic: String,
  value: String?,
): KafkaCleanupPolicy {
  val policies =
    value
      .orEmpty()
      .split(',')
      .map(String::trim)
      .filter(String::isNotEmpty)
      .toSet()
  return when (policies) {
    setOf("delete") -> KafkaCleanupPolicy.DELETE_ONLY
    setOf("compact", "delete") -> KafkaCleanupPolicy.COMPACT_DELETE
    else -> error("Kafka topic $topic has unsupported cleanup.policy=${value.orEmpty()}")
  }
}

private fun updateDigest(
  digest: MessageDigest,
  value: Long,
) {
  digest.update(ByteBuffer.allocate(Long.SIZE_BYTES).putLong(value).array())
}

private fun updateDigest(
  digest: MessageDigest,
  value: String?,
) {
  if (value == null) {
    digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(-1).array())
    return
  }
  val bytes = value.toByteArray(Charsets.UTF_8)
  digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(bytes.size).array())
  digest.update(bytes)
}
