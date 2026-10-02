package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import java.nio.file.Files
import java.security.DigestOutputStream
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RetainedFeatureReplayTest {
  private val start = Instant.parse("2026-09-11T13:30:00Z")
  private val clock = Clock.fixed(Instant.parse("2026-09-12T12:00:00Z"), ZoneOffset.UTC)
  private val symbols = listOf("AAPL", "SPY")

  private fun arrival(
    minute: Int,
    partition: Int,
    offset: Int = minute,
    close: Double = 100.0,
  ): RetainedFeatureArrival {
    val event = start.plusSeconds(minute * 60L)
    val ingest = start.plusSeconds((offset + 1) * 60L + 1)
    val envelope =
      Envelope(
        ingestTs = ingest,
        eventTs = event,
        feed = "iex",
        channel = "bars",
        symbol = symbols[partition],
        seq = offset.toLong(),
        payload =
          AlpacaBarPayload(
            open = 100.0,
            high = 110.0,
            low = 90.0,
            close = close,
            volume = 10.0,
            vwap = 100.0,
            tradeCount = 1,
            timestamp = event.toString(),
          ),
        provider = "alpaca",
        marketSession = "regular",
        delayClass = "real_time_exchange_only",
        version = 2,
      )
    return RetainedFeatureArrival(
      ingest.toEpochMilli(),
      RetainedFeatureRecord("bars", partition, offset.toString(), Json.encodeToString(envelope)),
    )
  }

  private fun input() = (0..30).flatMap { minute -> symbols.indices.map { arrival(minute, it) } }

  private fun bytes(arrivals: List<RetainedFeatureArrival>) = arrivals.joinToString("") { Json.encodeToString(it) + "\n" }.toByteArray()

  private fun config(
    bytes: ByteArray,
    count: Int,
  ) = RetainedFeatureReplayConfig(
    "dorvud.retained-feature-replay.v2",
    retainedBytesHash(bytes),
    count,
    "bars",
    "features",
    "technical",
    "iex",
    "core",
    canonicalSymbolHash(symbols),
    symbols,
    "a".repeat(40),
    100,
  )

  private data class CapturedReplay(
    val arrivals: List<RetainedFeatureArrival>,
    val skippedBars: Int,
    val rejectedBars: Int,
    val recordedAtMs: Long,
  ) {
    val rolling get() = arrivals.filter { it.record.topic == "features" }
    val technical get() = arrivals.filter { it.record.topic == "technical" }
  }

  private fun captureReplay(
    bytes: ByteArray,
    config: RetainedFeatureReplayConfig,
    clock: Clock,
  ): CapturedReplay {
    val arrivals = mutableListOf<RetainedFeatureArrival>()
    val summary = bytes.inputStream().use { replayRetainedFeatures(it, config, clock) { arrivals.add(it) } }
    assertEquals(arrivals.size, summary.outputRecordCount)
    return CapturedReplay(arrivals, summary.skippedBars, summary.rejectedBars, summary.recordedAtMs)
  }

  @Test fun `command streams sources larger than 128 MiB without resetting feature state`() {
    val directory = Files.createTempDirectory("retained-large-source-")
    try {
      val source = directory.resolve("source.ndjson")
      val digest = MessageDigest.getInstance("SHA-256")
      val padding = " ".repeat(512 * 1024)
      val count = 260
      Files.newOutputStream(source).use { stream ->
        DigestOutputStream(stream, digest).bufferedWriter(Charsets.UTF_8).use { writer ->
          for (minute in 0 until count) {
            writer.write(Json.encodeToString(arrival(minute, 0)))
            writer.write(padding)
            writer.write("\n")
          }
        }
      }
      assertTrue(Files.size(source) > 134_217_728L)
      val config = config(byteArrayOf(), count).copy(sourceSha256 = digest.digest().joinToString("") { "%02x".format(it) })
      val configPath = directory.resolve("config.json")
      Files.writeString(configPath, Json.encodeToString(config))
      val output = directory.resolve("output")
      RetainedFeatureReplay.main(arrayOf(configPath.toString(), source.toString(), output.toString()))
      val arrivals = Files.readAllLines(output.resolve("arrivals.ndjson")).map { Json.decodeFromString<RetainedFeatureArrival>(it) }
      assertEquals(count, arrivals.count { it.record.topic == "technical" })
      assertEquals(count - 29, arrivals.count { it.record.topic == "features" })
      assertTrue(Files.exists(output.resolve("receipt.json")))
    } finally {
      Files.walk(directory).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach { Files.delete(it) } }
    }
  }

  @Test fun `changing the original path during emission cannot change the verified snapshot`() {
    val source = bytes(input())
    val config = config(source, input().size)
    val expected = captureReplay(source, config, clock)
    val path = Files.createTempFile("retained-replaced-source-", ".ndjson")
    try {
      Files.write(path, source)
      val arrivals = mutableListOf<RetainedFeatureArrival>()
      Files.newInputStream(path).use { input ->
        replayRetainedFeatures(input, config, clock) { arrival ->
          if (arrivals.isEmpty()) Files.writeString(path, "replaced source\n")
          arrivals.add(arrival)
        }
      }
      assertEquals(expected.arrivals, arrivals)
    } finally {
      Files.delete(path)
    }
  }

  @Test fun `streaming input retains final newline strict UTF-8 and per-record bounds`() {
    val truncated = bytes(input()).dropLast(1).toByteArray()
    assertFailsWith<IllegalArgumentException> { captureReplay(truncated, config(truncated, input().size), clock) }
    val oversized = (" ".repeat(1024 * 1024 + 1) + "\n").toByteArray()
    assertFailsWith<IllegalArgumentException> { captureReplay(oversized, config(oversized, 1), clock) }
    val malformed = byteArrayOf(0xc3.toByte(), 0x28, 10)
    assertFailsWith<java.nio.charset.MalformedInputException> { captureReplay(malformed, config(malformed, 1), clock) }
  }

  @Test fun `both symbols emit at their triggering arrival while computed time remains actual`() {
    val arrivals = input()
    val source = bytes(arrivals)
    val result = captureReplay(source, config(source, arrivals.size), clock)
    assertEquals(4, result.rolling.size)
    assertEquals(0, result.skippedBars)
    assertEquals(clock.millis(), result.recordedAtMs)
    result.rolling.forEachIndexed { index, output ->
      val feature = Json.decodeFromString<RollingMarketFeature>(output.record.value)
      assertEquals(symbols[index % 2], feature.material.symbol)
      assertEquals(clock.millis(), feature.computedAtMs)
      assertEquals(arrivals[58 + index].availableAtMs + 100, output.availableAtMs)
      assertEquals(index.toString(), output.record.offset)
      assertEquals(30, feature.material.inputs.size)
      assertTrue(feature.material.inputs.all { it.sourcePartition == index % 2 })
    }
    assertEquals(result, captureReplay(source, config(source, arrivals.size), clock))
  }

  @Test fun `canonical correction creates a new feature at correction availability`() {
    val arrivals = input() + arrival(30, 0, 31, 101.0)
    val source = bytes(arrivals)
    val result = captureReplay(source, config(source, arrivals.size), clock)
    val corrected =
      Json.decodeFromString<RollingMarketFeature>(
        result.rolling
          .last()
          .record.value,
      )
    assertEquals(5, result.rolling.size)
    assertEquals("101000000", corrected.material.values.lastClosePriceMicros)
    assertEquals(
      "31",
      corrected.material.inputs
        .last()
        .sourceOffset,
    )
    assertEquals(arrivals.last().availableAtMs + 100, result.rolling.last().availableAtMs)
  }

  @Test fun `technical replay equals the live transition including session seed and corrections`() {
    val arrivals = (0..34).flatMap { minute -> symbols.indices.map { arrival(minute, it) } } + arrival(12, 0, 35, 105.0)
    val source = bytes(arrivals)
    val result = captureReplay(source, config(source, arrivals.size), clock)
    val routes = mapOf("bars" to ArchiveRoute("iex", ArchiveUniverse("core", canonicalSymbolHash(symbols), symbols.toSet())))
    val states = mutableMapOf<String, TechnicalFeatureState>()
    val expected = mutableListOf<TechnicalMarketFeature>()
    for (arrival in arrivals) {
      val record = arrival.record
      val bar = decodeArchiveBar(ArchiveKafkaRecord(record.topic, record.partition, record.offset.toLong(), record.value), routes)
      val key = rollingFeatureKey(bar)
      val transition = processTechnicalFeature(states[key] ?: TechnicalFeatureState(), bar, clock.millis(), "a".repeat(40))
      states[key] = transition.state
      transition.feature?.let { expected.add(it) }
    }
    val actual = result.technical.map { Json.decodeFromString<TechnicalMarketFeature>(it.record.value) }
    assertEquals(expected, actual)
    val wireJson = Json { encodeDefaults = true }
    result.technical.forEachIndexed { index, arrival ->
      val material = Json.parseToJsonElement(arrival.record.value).jsonObject.getValue("material")
      assertEquals(actual[index].featureId, featureHash(material))
      assertEquals(wireJson.encodeToString(expected[index]), arrival.record.value)
    }
    val firstValues =
      Json
        .parseToJsonElement(
          result.technical
            .first()
            .record.value,
        ).jsonObject
        .getValue("material")
        .jsonObject
        .getValue("values")
        .jsonObject
    assertEquals(JsonNull, firstValues.getValue("ema12PriceMicros").jsonObject.getValue("value"))
    assertEquals(71, actual.size)
    assertEquals(
      TechnicalReadiness.WARMING,
      actual
        .first()
        .material.values.ema12PriceMicros.status,
    )
    assertEquals(
      TechnicalReadiness.READY,
      actual
        .last()
        .material.values.macdSignalPriceMicros.status,
    )
    assertEquals(
      "35",
      actual
        .last()
        .material.inputs[12]
        .sourceOffset,
    )
    assertEquals(arrivals.last().availableAtMs + 100, result.technical.last().availableAtMs)
    assertEquals(clock.millis(), actual.last().computedAtMs)
  }

  @Test fun `all output topics share canonical delivery order with independent offsets`() {
    val arrivals = input()
    val source = bytes(arrivals)
    val result =
      captureReplay(
        source,
        config(source, arrivals.size).copy(rollingFeaturesTopic = "z-rolling", technicalFeaturesTopic = "a-technical"),
        clock,
      )
    val output = result.arrivals
    assertEquals(66, output.size)
    assertTrue(
      output.zipWithNext().all { (left, right) ->
        left.availableAtMs < right.availableAtMs ||
          (
            left.availableAtMs == right.availableAtMs &&
              (
                left.record.topic < right.record.topic ||
                  (left.record.topic == right.record.topic && left.record.offset.toLong() < right.record.offset.toLong())
              )
          )
      },
    )
    output.groupBy { it.record.topic }.forEach { (_, values) ->
      assertEquals(values.indices.map { it.toString() }, values.map { it.record.offset })
    }
    assertFailsWith<IllegalArgumentException> {
      captureReplay(source, config(source, arrivals.size).copy(schemaVersion = "dorvud.retained-feature-replay.v1"), clock)
    }
  }

  @Test fun `clock skew cannot reverse availability within the simulated output partition`() {
    val ahead = arrival(30, 0).let { it.copy(availableAtMs = it.availableAtMs - 5000) }
    val lagging = arrival(29, 1, 30, 101.0).copy(availableAtMs = ahead.availableAtMs + 1000)
    val arrivals = input().take(60) + ahead + lagging
    val source = bytes(arrivals)
    val result = captureReplay(source, config(source, arrivals.size), clock)
    assertEquals(4, result.rolling.size)
    assertTrue(
      result.rolling.zipWithNext().all { (left, right) ->
        left.availableAtMs <= right.availableAtMs && left.record.offset.toLong() < right.record.offset.toLong()
      },
    )
    assertEquals(start.plusSeconds(31 * 60).toEpochMilli() + 100, result.rolling[2].availableAtMs)
    assertEquals(result.rolling[2].availableAtMs, result.rolling[3].availableAtMs)
  }

  @Test fun `live-equivalent rejections preserve keyed history and permit later valid features`() {
    val invalidMinute =
      arrival(29, 0).let { arrival ->
        arrival.copy(
          record =
            arrival.record.copy(
              value =
                arrival.record.value.replace(
                  start.plusSeconds(29 * 60).toString(),
                  start.plusSeconds(29 * 60 + 1).toString(),
                ),
            ),
        )
      }
    val malformed = arrival(30, 0).let { it.copy(record = it.record.copy(value = "{invalid-json")) }
    val arrivals = (0..28).map { arrival(it, 0) } + invalidMinute + malformed + arrival(29, 0, 31)
    val source = bytes(arrivals)
    val result = captureReplay(source, config(source, arrivals.size), clock)
    assertEquals(2, result.rejectedBars)
    assertEquals(0, result.skippedBars)
    assertEquals(1, result.rolling.size)
    val feature =
      Json.decodeFromString<RollingMarketFeature>(
        result.rolling
          .single()
          .record.value,
      )
    assertEquals(30, feature.material.inputs.size)
    assertEquals(
      "0",
      feature.material.inputs
        .first()
        .sourceOffset,
    )
    assertEquals(
      "31",
      feature.material.inputs
        .last()
        .sourceOffset,
    )
    assertEquals(arrivals.last().availableAtMs + 100, result.rolling.single().availableAtMs)
  }

  @Test fun `hash count ordering and premature arrival failures cannot produce a receipt`() {
    val arrivals = input()
    val source = bytes(arrivals)
    val config = config(source, arrivals.size)
    assertFailsWith<IllegalArgumentException> { captureReplay(source, config.copy(sourceSha256 = "0".repeat(64)), clock) }
    assertFailsWith<IllegalArgumentException> { captureReplay(source, config.copy(recordCount = 1), clock) }
    for (invalid in listOf(
      arrivals.reversed(),
      arrivals + arrivals.last(),
      arrivals.map { it.copy(availableAtMs = it.availableAtMs - 5001) },
    )) {
      val invalidBytes = bytes(invalid)
      assertFailsWith<IllegalArgumentException> { captureReplay(invalidBytes, config(invalidBytes, invalid.size), clock) }
    }
  }

  @Test fun `Kafka timestamps must stay within the two-sided producer clock bound`() {
    for (difference in listOf(-5000L, 5000L, -5001L, 5001L)) {
      val arrivals = input().map { it.copy(record = it.record.copy(timestampMs = it.availableAtMs + difference)) }
      val source = bytes(arrivals)
      if (difference in -5000L..5000L) {
        assertEquals(4, captureReplay(source, config(source, arrivals.size), clock).rolling.size)
      } else {
        assertFailsWith<IllegalArgumentException> { captureReplay(source, config(source, arrivals.size), clock) }
      }
    }
  }

  @Test fun `retained replay honors the shared producer and Kafka clock-skew allowance`() {
    val sourceArrivals =
      input().map {
        it.copy(availableAtMs = it.availableAtMs - 5000, record = it.record.copy(timestampMs = it.availableAtMs))
      }
    val source = bytes(sourceArrivals)
    assertEquals(4, captureReplay(source, config(source, sourceArrivals.size), clock).rolling.size)
  }
}
