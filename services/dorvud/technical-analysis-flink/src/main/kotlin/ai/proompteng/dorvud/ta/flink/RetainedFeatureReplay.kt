package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
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
  val arrivals: List<RetainedFeatureArrival>,
  val skippedBars: Int,
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
  val lines = bytes.decodeToString(throwOnInvalidSequence = true).lineSequence().dropLastEmptyLine()
  require(lines.size == config.recordCount) { "retained source record count mismatch" }
  val routes =
    mapOf(config.barsTopic to ArchiveRoute("iex", ArchiveUniverse(config.universeId, config.universeSymbolHash, config.symbols.toSet())))
  val states = mutableMapOf<String, RollingFeatureState>()
  val offsets = mutableMapOf<Int, Long>()
  val output = mutableListOf<RetainedFeatureArrival>()
  var previous: RetainedFeatureArrival? = null
  var skipped = 0
  var recordedAt = clock.millis()
  for (line in lines) {
    val arrival = replayJson.decodeFromString<RetainedFeatureArrival>(line)
    val record = arrival.record
    val offset = record.offset.toLong()
    require(record.topic == config.barsTopic && record.partition >= 0 && offset >= 0 && record.offset == offset.toString()) {
      "invalid retained bar coordinate"
    }
    require(arrival.availableAtMs >= 0 && (record.timestampMs == null || record.timestampMs <= arrival.availableAtMs)) {
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
    val bar = decodeArchiveBar(ArchiveKafkaRecord(record.topic, record.partition, offset, record.value), routes)
    require(bar.ingestionTime <= java.time.Instant.ofEpochMilli(arrival.availableAtMs)) { "raw arrival precedes producer ingestion" }
    if (!bar.final || bar.marketSession != "regular") {
      skipped++
      continue
    }
    val key = rollingFeatureKey(bar)
    val computedAt = clock.millis()
    recordedAt = maxOf(recordedAt, computedAt)
    val transition = advanceRollingFeature(states[key] ?: RollingFeatureState(), bar, computedAt, config.producerRevision)
    states[key] = transition.state
    transition.feature?.let { feature ->
      val available = Math.addExact(maxOf(arrival.availableAtMs, feature.material.windowEndMs), config.processingDelayMs)
      output +=
        RetainedFeatureArrival(
          available,
          RetainedFeatureRecord(config.featuresTopic, 0, output.size.toString(), replayJson.encodeToString(feature)),
        )
    }
  }
  return RetainedFeatureReplayResult(output, skipped, recordedAt)
}

private fun Sequence<String>.dropLastEmptyLine(): List<String> = toList().dropLast(1)

@Serializable
private data class RetainedFeatureReceipt(
  val schemaVersion: String = "dorvud.retained-feature-replay-receipt.v1",
  val config: RetainedFeatureReplayConfig,
  val configSha256: String,
  val outputSha256: String,
  val outputRecordCount: Int,
  val skippedBars: Int,
  val recordedAtMs: Long,
  val coordinates: String = "isolated-simulation-partition-zero-offset-order",
  val delivery: String = "max(triggering-raw-arrival,window-end)+processing-delay; actual computedAt is retained",
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
    val result = replayRetainedFeatures(bytes, config, Clock.systemUTC())
    val outputBytes = result.arrivals.joinToString("", transform = { replayJson.encodeToString(it) + "\n" }).toByteArray()
    val receipt =
      RetainedFeatureReceipt(
        config = config,
        configSha256 = retainedBytesHash(configBytes),
        outputSha256 = retainedBytesHash(outputBytes),
        outputRecordCount = result.arrivals.size,
        skippedBars = result.skippedBars,
        recordedAtMs = result.recordedAtMs,
      )
    val directory = Files.createDirectory(Path.of(args[2]))
    Files.write(directory.resolve("arrivals.ndjson"), outputBytes, StandardOpenOption.CREATE_NEW)
    Files.write(directory.resolve("config.json"), configBytes, StandardOpenOption.CREATE_NEW)
    // Receipt is the terminal completion marker. A directory without it is not a completed export.
    Files.writeString(directory.resolve("receipt.json"), replayJson.encodeToString(receipt) + "\n", StandardOpenOption.CREATE_NEW)
  }
}
