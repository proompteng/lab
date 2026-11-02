package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.KafkaConsumerSettings
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.decodeWebullCapture
import ai.proompteng.dorvud.platform.inspectWebullCapture
import ai.proompteng.dorvud.platform.toProperties
import ai.proompteng.dorvud.platform.webullProviderInstant
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.TopicPartition
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.UUID

// Diagnostic credentials arrive on stdin, never arguments, logs, pod configuration, or disk.
internal suspend fun verifyWebullArchive(
  kafka: KafkaProducerSettings,
  topic: String,
) {
  require(topic.matches(Regex("[a-zA-Z0-9._-]{1,249}"))) { "invalid verification topic" }
  val credentials =
    runCatching { Json.parseToJsonElement(readln()).jsonObject }.getOrNull() ?: error("invalid verification credential input")
  val user = credentials.requiredText("username")
  val password = credentials.requiredText("password")
  require(listOf(user, password).all { value -> value.all { it.code in 33..126 } }) { "invalid verification credential header" }
  val http =
    HttpClient
      .newBuilder()
      .connectTimeout(Duration.ofSeconds(5))
      .followRedirects(HttpClient.Redirect.NEVER)
      .build()

  fun query(sql: String): List<JsonObject> {
    val response =
      http.send(
        HttpRequest
          .newBuilder(URI("http://torghut-clickhouse.torghut.svc.cluster.local:8123"))
          .timeout(Duration.ofSeconds(30))
          .header("X-ClickHouse-User", user)
          .header("X-ClickHouse-Key", password)
          .POST(HttpRequest.BodyPublishers.ofString("$sql FORMAT JSONEachRow"))
          .build(),
        HttpResponse.BodyHandlers.ofInputStream(),
      )
    val bytes = response.body().use { it.readNBytes(64 * 1024 * 1024 + 1) }
    require(bytes.size <= 64 * 1024 * 1024 && response.statusCode() == 200) {
      "ClickHouse verification query failed (HTTP ${response.statusCode()})"
    }
    return bytes
      .decodeToString(throwOnInvalidSequence = true)
      .lineSequence()
      .filter {
        it.isNotBlank()
      }.map { Json.parseToJsonElement(it).jsonObject }
      .toList()
  }
  val properties =
    KafkaConsumerSettings(
      kafka.bootstrapServers,
      "webull-verification-${UUID.randomUUID()}",
      "webull-verification",
      securityProtocol = kafka.securityProtocol,
      auth = kafka.auth,
      tls = kafka.tls,
    ).toProperties().apply { put("max.partition.fetch.bytes", (8 * 1024 * 1024).toString()) }
  val sampled = linkedMapOf<Pair<Int, Long>, ConsumerRecord<String, String>>()
  val ranges = mutableListOf<JsonObject>()
  val channelWitnesses = mutableListOf<JsonObject>()
  KafkaConsumer<String, String>(properties).use { consumer ->
    val partitions = consumer.partitionsFor(topic).map { TopicPartition(topic, it.partition()) }
    require(partitions.isNotEmpty()) { "Webull Kafka topic has no partitions" }
    consumer.assign(partitions)
    val ends = consumer.endOffsets(partitions)
    val beginnings = consumer.beginningOffsets(partitions)
    partitions.forEach { partition ->
      val start = maxOf(beginnings.getValue(partition), ends.getValue(partition) - 50)
      consumer.seek(partition, start)
      ranges +=
        buildJsonObject {
          put("partition", partition.partition())
          put("fromInclusive", start)
          put("toExclusive", ends.getValue(partition))
        }
    }
    val deadline = Instant.now().plusSeconds(60)
    while (partitions.any { consumer.position(it) < ends.getValue(it) }) {
      require(Instant.now() < deadline) { "Webull Kafka sample did not finish before deadline" }
      consumer.poll(Duration.ofMillis(500)).forEach { record ->
        val end = ends.getValue(TopicPartition(topic, record.partition()))
        if (record.offset() < end) {
          sampled[record.partition() to record.offset()] = record
        }
      }
    }
    // A short tail can fall between bar sweeps. Verify one recent archived witness per market channel against Kafka too.
    val witnesses =
      query(
        """
        SELECT channel, argMax((source_partition,source_offset),received_at) AS coordinate
        FROM signal.webull_market_events_v1 FINAL
        WHERE source_topic='$topic' AND validation_status='VALID' AND notEmpty(symbols)
          AND received_at >= now() - INTERVAL 15 MINUTE
          AND ((channel IN ('quotes','trades') AND JSONExtractString(capture,'source','type')='mqtt')
            OR (channel='bars' AND JSONExtractString(capture,'source','type')='http'))
        GROUP BY channel
        """.trimIndent(),
      )
    for (witness in witnesses) {
      val coordinate = witness.getValue("coordinate") as JsonArray
      val partition = (coordinate[0] as JsonPrimitive).content.toInt()
      val offset = (coordinate[1] as JsonPrimitive).content.toLong()
      val key = partition to offset
      if (key !in sampled) {
        val source = TopicPartition(topic, partition)
        consumer.assign(listOf(source))
        consumer.seek(source, offset)
        val witnessDeadline = Instant.now().plusSeconds(20)
        while (key !in sampled) {
          require(Instant.now() < witnessDeadline) { "archived Webull channel witness is missing from Kafka" }
          consumer.poll(Duration.ofMillis(500)).forEach { record ->
            if (record.partition() == partition && record.offset() == offset) sampled[key] = record
          }
        }
      }
      channelWitnesses +=
        buildJsonObject {
          put("channel", witness.requiredText("channel"))
          put("partition", partition)
          put("offset", offset)
        }
    }
  }
  require(sampled.isNotEmpty()) { "Webull Kafka topic is empty" }
  val archived = mutableMapOf<Pair<Int, Long>, JsonObject>()
  repeat(15) { attempt ->
    for (batch in sampled.keys.filter { it !in archived }.chunked(10)) {
      val coordinates = batch.joinToString(",") { "(${it.first},${it.second})" }
      query(
        "SELECT source_partition, source_offset, capture, payload_sha256, provider, feed, toString(capture_id) AS capture_id, toString(toUnixTimestamp64Nano(received_at)) AS received_ns, toString(toUnixTimestamp64Nano(archived_at)) AS archived_ns FROM signal.webull_market_events_v1 FINAL WHERE source_topic='$topic' AND (source_partition,source_offset) IN ($coordinates)",
      ).forEach { row -> archived[row.requiredText("source_partition").toInt() to row.requiredText("source_offset").toLong()] = row }
    }
    if (sampled.keys.any { it !in archived } && attempt < 14) delay(2_000)
  }
  var mismatches = 0
  val observed = mutableMapOf<String, MutableSet<String>>()
  val sourceAges = mutableMapOf<String, MutableList<Long>>()
  val archiveLags = mutableListOf<Long>()
  var nativeBytes = 0L
  var kafkaBytes = 0L
  for ((coordinate, record) in sampled) {
    val capture = decodeWebullCapture(record.value())
    nativeBytes += capture.bytes().size
    kafkaBytes += record.value().toByteArray().size
    val stored = archived[coordinate]
    val receivedAt = Instant.parse(capture.receivedAt)
    if (stored == null || stored.requiredText("capture") != record.value() ||
      stored.requiredText("payload_sha256") != capture.payloadSha256 || stored.requiredText("provider") != capture.provider ||
      stored.requiredText("feed") != capture.feed || stored.requiredText("capture_id") != capture.captureId ||
      stored.requiredText("received_ns").toLong() != receivedAt.epochSecond * 1_000_000_000 + receivedAt.nano
    ) {
      mismatches++
      continue
    }
    val ns = stored.requiredText("archived_ns").toLong()
    archiveLags +=
      Duration.between(Instant.parse(capture.receivedAt), Instant.ofEpochSecond(ns / 1_000_000_000, ns % 1_000_000_000)).toMillis()
    val parsed = runCatching { inspectWebullCapture(capture) }.getOrNull() ?: continue
    val channel = if (capture.source is WebullSource.Mqtt) "mqtt.${parsed.channel}" else parsed.channel
    for (observation in parsed.observations) {
      observed.getOrPut(channel) { mutableSetOf() }.add(observation.symbol)
      webullProviderInstant(observation.sourceTime)?.let { time ->
        sourceAges.getOrPut(channel) { mutableListOf() }.add(Duration.between(time, Instant.parse(capture.receivedAt)).toMillis())
      }
    }
  }
  val summary =
    query(
      "SELECT channel, count() AS rows, uniqExact(capture_id) AS unique_captures, uniqArray(symbols) AS unique_symbols FROM signal.webull_market_events_v1 FINAL WHERE received_at >= now() - INTERVAL 15 MINUTE GROUP BY channel ORDER BY channel",
    )
  val storage =
    query(
      "SELECT sum(bytes_on_disk) AS compressed_bytes, sum(rows) AS physical_rows FROM system.parts WHERE active AND database='signal' AND table='webull_market_events_v1'",
    )
  val activeMarket = listOf("mqtt.quotes", "mqtt.trades", "bars").all { observed[it].orEmpty().isNotEmpty() }

  fun latency(values: List<Long>): JsonObject =
    buildJsonObject {
      val sorted = values.sorted()
      put("samples", sorted.size)
      if (sorted.isNotEmpty()) {
        put("min", sorted.first())
        put("p50", sorted[(sorted.size - 1) / 2])
        put(
          "p95",
          sorted[
            (
              (sorted.size - 1) *
                95
            ) /
              100,
          ],
        )
        put("max", sorted.last())
      }
    }
  val report =
    buildJsonObject {
      put("schemaVersion", "dorvud.webull.verification.v1")
      put("reportedAt", Instant.now().toString())
      put("sourceRevision", System.getenv("WEBULL_FEED_COMMIT") ?: "development")
      put("imageDigest", System.getenv("WEBULL_FEED_IMAGE_DIGEST") ?: "development")
      put("topic", topic)
      put("sampleRanges", JsonArray(ranges))
      put("recentChannelWitnesses", JsonArray(channelWitnesses))
      put("sampledKafkaRecords", sampled.size)
      put("missingOrDifferentArchiveRecords", mismatches)
      put("pipelineVerified", mismatches == 0)
      put("activeMarketAccepted", activeMarket && mismatches == 0)
      put("sampleNativeBytes", nativeBytes)
      put("sampleKafkaEnvelopeBytes", kafkaBytes)
      put(
        "sampleObservedSymbols",
        buildJsonObject {
          observed.toSortedMap().forEach { (channel, symbols) ->
            put(channel, buildJsonArray { symbols.sorted().forEach { add(JsonPrimitive(it)) } })
          }
        },
      )
      put(
        "sampleSourceAgeMillis",
        buildJsonObject {
          sourceAges.toSortedMap().forEach { (channel, values) ->
            put(channel, latency(values))
          }
        },
      )
      put("sampleArchiveLagMillis", latency(archiveLags))
      put("last15MinuteArchiveCoverage", JsonArray(summary))
      put("localReplicaStorage", JsonArray(storage))
    }
  println(report)
  require(mismatches == 0) { "Webull archive does not match the sampled Kafka range" }
  require(activeMarket) { "active-market quote, trade, and completed-bar delivery still needs verification" }
}
