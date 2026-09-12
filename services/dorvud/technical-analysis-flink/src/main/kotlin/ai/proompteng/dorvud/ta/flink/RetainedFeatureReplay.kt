package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
  val featuresTopic: String,
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
private val sha256Pattern = Regex("[0-9a-f]{64}")

internal fun retainedBytesHash(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Same keyed transition as the Flink branch, with simulated delivery separated from actual computation time. */
internal fun replayRetainedFeatures(
  bytes: ByteArray,
  config: RetainedFeatureReplayConfig,
  clock: Clock,
  emit: (RetainedFeatureArrival) -> Unit,
): RetainedFeatureReplayResult {
  require(config.schemaVersion == "dorvud.retained-feature-replay.v1") { "unsupported replay configuration" }
  require(config.sourceSha256.matches(sha256Pattern) && retainedBytesHash(bytes) == config.sourceSha256) { "retained source hash mismatch" }
  require(config.recordCount > 0 && bytes.isNotEmpty() && bytes.last() == '\n'.code.toByte()) { "incomplete retained source" }
  require(config.processingDelayMs in 0..60_000) { "invalid simulated processing delay" }
  require(config.producerRevision.matches(Regex("[0-9a-f]{40}"))) { "producer revision must be an exact commit" }
  require(config.barsTopic.isNotBlank() && config.featuresTopic.isNotBlank() && config.featuresTopic != config.barsTopic) {
    "invalid replay topics"
  }
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
  val lineCount = bytes.count { it == 10.toByte() }
  require(lineCount == config.recordCount) { "retained source record count mismatch" }
  val routes =
    mapOf(config.barsTopic to ArchiveRoute("iex", ArchiveUniverse(config.universeId, config.universeSymbolHash, config.symbols.toSet())))
  val states = mutableMapOf<String, RollingFeatureState>()
  val offsets = mutableMapOf<Int, Long>()
  var outputCount = 0
  var previousOutputAvailability = 0L
  var previous: RetainedFeatureArrival? = null
  var skipped = 0
  var rejected = 0
  var recordedAt = clock.millis()
  for (line in bytes.decodeToString(throwOnInvalidSequence = true).lineSequence().take(lineCount)) {
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
    val transition = processRollingFeature(states[key] ?: RollingFeatureState(), bar, computedAt, config.producerRevision)
    if (transition.rejection != null) rejected++
    states[key] = transition.state
    transition.feature?.let { feature ->
      val available =
        maxOf(
          previousOutputAvailability,
          Math.addExact(maxOf(arrival.availableAtMs, feature.material.windowEndMs), config.processingDelayMs),
        )
      previousOutputAvailability = available
      emit(
        RetainedFeatureArrival(
          available,
          RetainedFeatureRecord(config.featuresTopic, 0, outputCount.toString(), replayJson.encodeToString(feature)),
        ),
      )
      outputCount++
    }
  }
  return RetainedFeatureReplayResult(outputCount, skipped, rejected, recordedAt)
}

@Serializable
private data class RetainedFeatureReceipt(
  val schemaVersion: String = "dorvud.retained-feature-replay-receipt.v1",
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
    // One immutable in-memory byte snapshot is validated and evaluated; paths are never reopened after validation.
    require(Files.size(source) in 1..134_217_728L) { "extract bars into a source of at most 128 MiB" }
    val bytes = Files.newInputStream(source).use { it.readNBytes(134_217_729) }
    require(bytes.size <= 134_217_728) { "retained source exceeds 128 MiB" }
    val directory = Files.createDirectory(Path.of(args[2]))
    val digest = MessageDigest.getInstance("SHA-256")
    val result =
      Files.newOutputStream(directory.resolve("arrivals.ndjson"), StandardOpenOption.CREATE_NEW).use { stream ->
        DigestOutputStream(stream, digest).bufferedWriter(Charsets.UTF_8).use { writer ->
          replayRetainedFeatures(bytes, config, Clock.systemUTC()) { arrival ->
            writer.write(replayJson.encodeToString(arrival))
            writer.write("\n")
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
