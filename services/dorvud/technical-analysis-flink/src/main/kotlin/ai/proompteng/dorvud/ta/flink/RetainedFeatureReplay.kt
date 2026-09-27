package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.DigestOutputStream
import java.security.MessageDigest
import java.time.Clock

@Serializable
internal data class RetainedFeatureReplayConfig(
  val schemaVersion: String,
  val sourceSha256: String,
  val recordCount: Int,
  val barsTopic: String,
  val rollingFeaturesTopic: String,
  val technicalFeaturesTopic: String,
  val feed: String,
  val universeId: String,
  val universeSymbolHash: String,
  val symbols: List<String>,
  val producerRevision: String,
  val processingDelayMs: Long,
)

@Serializable
internal data class RetainedFeatureRecord(
  val topic: String,
  val partition: Int,
  val offset: String,
  val value: String,
  val timestampMs: Long? = null,
)

@Serializable
internal data class RetainedFeatureArrival(
  val availableAtMs: Long,
  val record: RetainedFeatureRecord,
)

internal data class RetainedFeatureReplayResult(
  val outputRecordCount: Int,
  val skippedBars: Int,
  val rejectedBars: Int,
  val recordedAtMs: Long,
)

private val replayJson =
  Json {
    encodeDefaults = true
    explicitNulls = false
  }
private val featureJson = Json { encodeDefaults = true }
private val sha256Pattern = Regex("[0-9a-f]{64}")

internal fun retainedBytesHash(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Snapshot and verify a bounded stream before feeding the shared keyed transitions. The caller owns the source. */
internal fun replayRetainedFeatures(
  source: InputStream,
  config: RetainedFeatureReplayConfig,
  clock: Clock,
  emit: (RetainedFeatureArrival) -> Unit,
): RetainedFeatureReplayResult {
  require(config.sourceSha256.matches(sha256Pattern) && config.recordCount > 0) { "invalid retained source identity" }
  val snapshot = Files.createTempFile("dorvud-retained-", ".ndjson")
  try {
    FileChannel.open(snapshot, StandardOpenOption.READ, StandardOpenOption.WRITE, StandardOpenOption.DELETE_ON_CLOSE).use { channel ->
      val digest = MessageDigest.getInstance("SHA-256")
      val buffer = ByteArray(64 * 1024)
      var recordCount = 0
      var lineBytes = 0
      while (true) {
        val size = source.read(buffer)
        if (size == -1) break
        digest.update(buffer, 0, size)
        for (index in 0 until size) {
          if (buffer[index] == '\n'.code.toByte()) {
            recordCount = Math.incrementExact(recordCount)
            lineBytes = 0
          } else {
            lineBytes++
            require(lineBytes <= 1024 * 1024) { "retained record exceeds 1 MiB" }
          }
        }
        val bytes = ByteBuffer.wrap(buffer, 0, size)
        while (bytes.hasRemaining()) channel.write(bytes)
      }
      require(recordCount > 0 && lineBytes == 0) { "incomplete retained source" }
      require(recordCount == config.recordCount) { "retained source record count mismatch" }
      require(digest.digest().joinToString("") { "%02x".format(it) } == config.sourceSha256) { "retained source hash mismatch" }
      channel.position(0)
      Channels.newReader(channel, Charsets.UTF_8.newDecoder(), -1).buffered().use { reader ->
        return replayRetainedFeatureLines(reader.lineSequence(), config, clock, emit)
      }
    }
  } finally {
    Files.deleteIfExists(snapshot)
  }
}

/** Same keyed transition as the Flink branch, with simulated delivery separated from actual computation time. */
private fun replayRetainedFeatureLines(
  lines: Sequence<String>,
  config: RetainedFeatureReplayConfig,
  clock: Clock,
  emit: (RetainedFeatureArrival) -> Unit,
): RetainedFeatureReplayResult {
  require(config.schemaVersion == "dorvud.retained-feature-replay.v2") { "unsupported replay configuration" }
  require(config.processingDelayMs in 0..60_000) { "invalid simulated processing delay" }
  require(config.producerRevision.matches(Regex("[0-9a-f]{40}"))) { "producer revision must be an exact commit" }
  val topics = listOf(config.barsTopic, config.rollingFeaturesTopic, config.technicalFeaturesTopic)
  require(topics.all { it.isNotBlank() } && topics.distinct().size == topics.size) { "invalid replay topics" }
  require(config.feed in setOf("iex", "sip", "delayed_sip")) { "unsupported replay feed" }
  require(config.universeId.isNotBlank() && config.symbols.isNotEmpty() && config.symbols == config.symbols.distinct().sorted()) {
    "noncanonical replay universe"
  }
  require(
    config.symbols.all {
      it.matches(Regex("[A-Z][A-Z0-9.]{0,9}"))
    } && canonicalSymbolHash(config.symbols) == config.universeSymbolHash,
  ) {
    "replay universe hash mismatch"
  }
  val routes =
    mapOf(
      config.barsTopic to ArchiveRoute(config.feed, ArchiveUniverse(config.universeId, config.universeSymbolHash, config.symbols.toSet())),
    )
  val rollingStates = mutableMapOf<String, RollingFeatureState>()
  val technicalStates = mutableMapOf<String, TechnicalFeatureState>()
  val offsets = mutableMapOf<Int, Long>()
  var outputCount = 0
  var previousOutputAvailability = 0L
  val outputOffsets = mutableMapOf<String, Int>()
  val pending = mutableListOf<Pair<String, String>>()

  fun flush() {
    for ((topic, value) in pending.sortedBy { it.first }) {
      val offset = outputOffsets[topic] ?: 0
      emit(RetainedFeatureArrival(previousOutputAvailability, RetainedFeatureRecord(topic, 0, offset.toString(), value)))
      outputOffsets[topic] = offset + 1
      outputCount++
    }
    pending.clear()
  }

  fun publish(
    topic: String,
    value: String,
    rawAvailableAtMs: Long,
    windowEndMs: Long,
  ) {
    val available = maxOf(previousOutputAvailability, Math.addExact(maxOf(rawAvailableAtMs, windowEndMs), config.processingDelayMs))
    if (available > previousOutputAvailability) flush()
    previousOutputAvailability = available
    pending.add(topic to value)
  }
  var previous: RetainedFeatureArrival? = null
  var skipped = 0
  var rejected = 0
  var recordedAt = clock.millis()
  for (line in lines) {
    val arrival = replayJson.decodeFromString<RetainedFeatureArrival>(line)
    val record = arrival.record
    val offset = record.offset.toLong()
    require(record.topic == config.barsTopic && record.partition >= 0 && offset >= 0 && record.offset == offset.toString()) {
      "invalid retained bar coordinate"
    }
    require(
      arrival.availableAtMs >= 0 &&
        (
          record.timestampMs == null ||
            (record.timestampMs >= 0 && record.timestampMs <= Math.addExact(arrival.availableAtMs, FEATURE_MAX_CLOCK_SKEW_MS))
        ),
    ) {
      "raw arrival precedes Kafka availability"
    }
    require(offset > (offsets[record.partition] ?: -1L)) { "repeated or reversed retained partition offset" }
    previous?.let { prior ->
      require(
        arrival.availableAtMs > prior.availableAtMs ||
          (
            arrival.availableAtMs == prior.availableAtMs &&
              (
                record.partition > prior.record.partition ||
                  (record.partition == prior.record.partition && offset > prior.record.offset.toLong())
              )
          ),
      ) { "retained arrivals are not canonically ordered" }
    }
    offsets[record.partition] = offset
    previous = arrival
    val parsed = runCatching { decodeArchiveBar(ArchiveKafkaRecord(record.topic, record.partition, offset, record.value), routes) }
    if (parsed.isFailure) {
      rejected++
      continue
    }
    val bar = parsed.getOrThrow()
    require(bar.ingestionTime <= java.time.Instant.ofEpochMilli(Math.addExact(arrival.availableAtMs, FEATURE_MAX_CLOCK_SKEW_MS))) {
      "raw arrival precedes producer ingestion"
    }
    record.timestampMs?.let { timestamp ->
      val ingestion = bar.ingestionTime.toEpochMilli()
      require(
        timestamp >= Math.subtractExact(ingestion, FEATURE_MAX_CLOCK_SKEW_MS) &&
          timestamp <= Math.addExact(ingestion, FEATURE_MAX_CLOCK_SKEW_MS),
      ) {
        "Kafka timestamp violates the producer clock contract"
      }
    }
    if (!bar.final || bar.marketSession != "regular") {
      skipped++
      continue
    }
    val key = rollingFeatureKey(bar)
    val computedAt = clock.millis()
    recordedAt = maxOf(recordedAt, computedAt)
    val rolling = processRollingFeature(rollingStates[key] ?: RollingFeatureState(), bar, computedAt, config.producerRevision)
    val technical = processTechnicalFeature(technicalStates[key] ?: TechnicalFeatureState(), bar, computedAt, config.producerRevision)
    if (rolling.rejection != null || technical.rejection != null) rejected++
    rollingStates[key] = rolling.state
    technicalStates[key] = technical.state
    rolling.feature?.let { feature ->
      publish(config.rollingFeaturesTopic, featureJson.encodeToString(feature), arrival.availableAtMs, feature.material.windowEndMs)
    }
    technical.feature?.let { feature ->
      publish(config.technicalFeaturesTopic, featureJson.encodeToString(feature), arrival.availableAtMs, feature.material.windowEndMs)
    }
  }
  flush()
  return RetainedFeatureReplayResult(outputCount, skipped, rejected, recordedAt)
}

@Serializable
private data class RetainedFeatureReceipt(
  val schemaVersion: String = "dorvud.retained-feature-replay-receipt.v2",
  val config: RetainedFeatureReplayConfig,
  val configSha256: String,
  val outputSha256: String,
  val outputRecordCount: Int,
  val skippedBars: Int,
  val rejectedBars: Int,
  val recordedAtMs: Long,
  val coordinates: String = "isolated-simulation-partition-zero-offset-order",
  val delivery: String =
    "max(previous-output-availability,max(triggering-raw-arrival,window-end)+processing-delay); " +
      "actual computedAt is retained",
)

/** Offline only: no Kafka client, network endpoint, database or broker credentials. */
object RetainedFeatureReplay {
  @JvmStatic
  fun main(args: Array<String>) {
    require(args.size == 3) { "usage: RetainedFeatureReplay <config.json> <retained-bars.ndjson> <new-output-directory>" }
    val configBytes = Files.readAllBytes(Path.of(args[0]))
    val config = replayJson.decodeFromString<RetainedFeatureReplayConfig>(configBytes.decodeToString(throwOnInvalidSequence = true))
    val source = Path.of(args[1])
    val directory = Files.createDirectory(Path.of(args[2]))
    val digest = MessageDigest.getInstance("SHA-256")
    val result =
      Files.newOutputStream(directory.resolve("arrivals.ndjson"), StandardOpenOption.CREATE_NEW).use { stream ->
        DigestOutputStream(stream, digest).bufferedWriter(Charsets.UTF_8).use { writer ->
          Files.newInputStream(source).use { input ->
            replayRetainedFeatures(input, config, Clock.systemUTC()) { arrival ->
              writer.write(replayJson.encodeToString(arrival))
              writer.write("\n")
            }
          }
        }
      }
    val receipt =
      RetainedFeatureReceipt(
        config = config,
        configSha256 = retainedBytesHash(configBytes),
        outputSha256 = digest.digest().joinToString("") { "%02x".format(it) },
        outputRecordCount = result.outputRecordCount,
        skippedBars = result.skippedBars,
        rejectedBars = result.rejectedBars,
        recordedAtMs = result.recordedAtMs,
      )
    Files.write(directory.resolve("config.json"), configBytes, StandardOpenOption.CREATE_NEW)
    // Receipt is the terminal completion marker. A directory without it is not a completed export.
    Files.writeString(directory.resolve("receipt.json"), replayJson.encodeToString(receipt) + "\n", StandardOpenOption.CREATE_NEW)
  }
}
