package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
    "dorvud.retained-feature-replay.v1",
    retainedBytesHash(bytes),
    count,
    "bars",
    "features",
    "core",
    canonicalSymbolHash(symbols),
    symbols,
    "a".repeat(40),
    100,
  )

  private data class CapturedReplay(
    val arrivals: List<RetainedFeatureArrival>,
    val skippedBars: Int,
    val recordedAtMs: Long,
  )

  private fun captureReplay(
    bytes: ByteArray,
    config: RetainedFeatureReplayConfig,
    clock: Clock,
  ): CapturedReplay {
    val arrivals = mutableListOf<RetainedFeatureArrival>()
    val summary = replayRetainedFeatures(bytes, config, clock) { arrivals.add(it) }
    assertEquals(arrivals.size, summary.outputRecordCount)
    return CapturedReplay(arrivals, summary.skippedBars, summary.recordedAtMs)
  }

  @Test fun `both symbols emit at their triggering arrival while computed time remains actual`() {
    val arrivals = input()
    val source = bytes(arrivals)
    val result = captureReplay(source, config(source, arrivals.size), clock)
    assertEquals(4, result.arrivals.size)
    assertEquals(0, result.skippedBars)
    assertEquals(clock.millis(), result.recordedAtMs)
    result.arrivals.forEachIndexed { index, output ->
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
        result.arrivals
          .last()
          .record.value,
      )
    assertEquals(5, result.arrivals.size)
    assertEquals("101000000", corrected.material.values.lastClosePriceMicros)
    assertEquals(
      "31",
      corrected.material.inputs
        .last()
        .sourceOffset,
    )
    assertEquals(arrivals.last().availableAtMs + 100, result.arrivals.last().availableAtMs)
  }

  @Test fun `clock skew cannot reverse availability within the simulated output partition`() {
    val ahead = arrival(30, 0).let { it.copy(availableAtMs = it.availableAtMs - 5000) }
    val lagging = arrival(29, 1, 30, 101.0).copy(availableAtMs = ahead.availableAtMs + 1000)
    val arrivals = input().take(60) + ahead + lagging
    val source = bytes(arrivals)
    val result = captureReplay(source, config(source, arrivals.size), clock)
    assertEquals(4, result.arrivals.size)
    assertTrue(
      result.arrivals.zipWithNext().all { (left, right) ->
        left.availableAtMs <= right.availableAtMs && left.record.offset.toLong() < right.record.offset.toLong()
      },
    )
    assertEquals(start.plusSeconds(31 * 60).toEpochMilli() + 100, result.arrivals[2].availableAtMs)
    assertEquals(result.arrivals[2].availableAtMs, result.arrivals[3].availableAtMs)
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

  @Test fun `retained replay honors the shared producer and Kafka clock-skew allowance`() {
    val sourceArrivals =
      input().map {
        it.copy(availableAtMs = it.availableAtMs - 5000, record = it.record.copy(timestampMs = it.availableAtMs))
      }
    val source = bytes(sourceArrivals)
    assertEquals(4, captureReplay(source, config(source, sourceArrivals.size), clock).arrivals.size)
  }
}
