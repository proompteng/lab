package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaConsumerSettings
import ai.proompteng.dorvud.platform.toProperties
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.ByteArrayDeserializer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.sql.DriverManager
import java.time.Duration
import java.util.Properties

internal data class QuoteArchiveRecoveryRange(
  val topic: String,
  val partition: Int,
  val firstOffset: Long,
  val endOffsetExclusive: Long,
) {
  init {
    require(topic.isNotBlank() && partition >= 0 && firstOffset >= 0) { "invalid quote recovery source" }
    require(endOffsetExclusive > firstOffset && endOffsetExclusive - firstOffset <= 10_000) {
      "quote recovery must contain 1 to 10000 source offsets"
    }
  }
}

@Serializable
internal data class QuoteArchiveRecoveryRecord(
  val offset: Long,
  val rawValueSha256: String,
)

@Serializable
internal data class QuoteArchiveRecoveryManifest(
  val schemaVersion: String = "dorvud.quote-archive-recovery.v1",
  val topic: String,
  val partition: Int,
  val firstOffset: Long,
  val endOffsetExclusive: Long,
  val feed: String,
  val universeId: String,
  val universeSymbolHash: String,
  val records: List<QuoteArchiveRecoveryRecord>,
)

private val recoveryJson = Json { encodeDefaults = true }

private fun recoverySha256(value: String): String =
  MessageDigest
    .getInstance("SHA-256")
    .digest(value.toByteArray(StandardCharsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 0xff) }

internal fun quoteArchiveRecoveryPlan(
  range: QuoteArchiveRecoveryRange,
  routes: Map<String, ArchiveRoute>,
  records: List<ArchiveKafkaRecord>,
): Pair<QuoteArchiveRecoveryManifest, List<IntradayQuoteRecord>> {
  val route = requireNotNull(routes[range.topic]) { "recovery topic is outside the existing archive routes" }
  require(route.kind == ArchiveRecordKind.Quote) { "recovery requires a configured quote topic" }
  require(records.size.toLong() == range.endOffsetExclusive - range.firstOffset) { "incomplete quote recovery range" }
  val quotes =
    records.mapIndexed { index, record ->
      require(record.topic == range.topic && record.partition == range.partition && record.offset == range.firstOffset + index) {
        "quote recovery source is not the exact ordered contiguous range"
      }
      decodeArchiveQuote(record, routes)
    }
  return QuoteArchiveRecoveryManifest(
    topic = range.topic,
    partition = range.partition,
    firstOffset = range.firstOffset,
    endOffsetExclusive = range.endOffsetExclusive,
    feed = route.feed,
    universeId = route.universe.id,
    universeSymbolHash = route.universe.symbolHash,
    records = records.map { QuoteArchiveRecoveryRecord(it.offset, recoverySha256(it.value)) },
  ) to quotes
}

internal fun quoteArchiveRecoveryHash(manifest: QuoteArchiveRecoveryManifest): String =
  recoverySha256(recoveryJson.encodeToString(manifest))

fun main(args: Array<String>) {
  require(args.size in 4..5) { "usage: QuoteArchiveRecoveryKt TOPIC PARTITION FIRST_OFFSET END_OFFSET_EXCLUSIVE [APPLY_MANIFEST_SHA256]" }
  val range = QuoteArchiveRecoveryRange(args[0], args[1].toInt(), args[2].toLong(), args[3].toLong())
  val expectedHash = args.getOrNull(4)
  require(expectedHash == null || expectedHash.matches(Regex("[a-f0-9]{64}"))) { "invalid recovery manifest hash" }
  val config = MarketDataArchiveConfig.fromEnv()
  require(config.routes[range.topic]?.kind == ArchiveRecordKind.Quote) { "recovery requires an existing quote route" }
  val properties =
    KafkaConsumerSettings(
      bootstrapServers = config.bootstrapServers,
      groupId = "${config.groupId}-quote-recovery",
      clientId = "${config.clientId}-quote-recovery",
      autoOffsetReset = "none",
      securityProtocol = config.securityProtocol,
      auth = KafkaAuth(config.saslUsername, config.saslPassword.orEmpty(), config.saslMechanism),
    ).toProperties().apply {
      putAll(archiveKafkaSecurityProperties(config))
      put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, ByteArrayDeserializer::class.java)
      put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed")
      put(ConsumerConfig.REQUEST_TIMEOUT_MS_CONFIG, 10_000)
      put(ConsumerConfig.DEFAULT_API_TIMEOUT_MS_CONFIG, 10_000)
    }
  val records =
    KafkaConsumer<String, ByteArray>(properties).use { consumer ->
      val partition = TopicPartition(range.topic, range.partition)
      consumer.assign(listOf(partition))
      require(
        consumer.beginningOffsets(listOf(partition)).getValue(partition) <= range.firstOffset,
      ) { "original recovery records have expired" }
      require(
        consumer.endOffsets(listOf(partition)).getValue(partition) >= range.endOffsetExclusive,
      ) { "recovery range exceeds the source head" }
      consumer.seek(partition, range.firstOffset)
      val retained = mutableListOf<ArchiveKafkaRecord>()
      val deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos()
      while (retained.size.toLong() < range.endOffsetExclusive - range.firstOffset) {
        check(System.nanoTime() < deadline) { "quote recovery read exceeded its deadline" }
        val batch = consumer.poll(Duration.ofMillis(500))
        for (record in batch.records(partition)) {
          require(record.offset() == range.firstOffset + retained.size) { "quote recovery source has missing offsets" }
          retained.add(
            ArchiveKafkaRecord(
              record.topic(),
              record.partition(),
              record.offset(),
              requireNotNull(record.value()).decodeToString(throwOnInvalidSequence = true),
            ),
          )
          if (record.offset() + 1 == range.endOffsetExclusive) break
        }
      }
      retained
    }
  val (manifest, quotes) = quoteArchiveRecoveryPlan(range, config.routes, records)
  val hash = quoteArchiveRecoveryHash(manifest)
  println(recoveryJson.encodeToString(manifest))
  println("manifestSha256=$hash")
  if (expectedHash == null) return
  require(hash == expectedHash) { "quote recovery source or route differs from the reviewed manifest" }
  val credentials =
    Properties().apply {
      setProperty("user", config.clickhouseUsername)
      config.clickhousePassword?.let { setProperty("password", it) }
    }
  DriverManager.getConnection(config.clickhouseUrl, credentials).use { connection ->
    connection.prepareStatement(archiveQuoteInsertSql).use { statement ->
      quotes.forEach { quote ->
        bindArchiveQuote(statement, quote)
        statement.addBatch()
      }
      statement.executeBatch()
    }
  }
  println("acknowledgedRows=${quotes.size}")
}
