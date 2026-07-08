package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import org.apache.flink.api.common.typeinfo.TypeHint
import org.apache.flink.api.common.typeinfo.TypeInformation
import java.io.ByteArrayOutputStream
import java.io.ObjectOutputStream
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class FlinkTechnicalAnalysisStatusHeartbeatTest {
  @Test
  fun `startup heartbeat payload is explicit when no input event has arrived`() {
    val payload =
      taStatusPayload(
        now = Instant.parse("2026-07-07T14:00:05Z"),
        watermark = Long.MIN_VALUE,
        lastInputEventMs = null,
        lastOutputEventMs = null,
        inputEventCount = 0,
        outputEventCount = 0,
        lastHeartbeatInputCount = 0,
        lastHeartbeatOutputCount = 0,
        lastHeartbeatMs = null,
        perSymbolLatestEventTs = emptyMap(),
        clickhouseSinkEnabled = false,
      )

    assertNull(payload.lastInputEventTs)
    assertNull(payload.lastOutputEventTs)
    assertNull(payload.sourceLagMs)
    assertNull(payload.watermarkLagMs)
    assertEquals(0, payload.inputEventCount)
    assertEquals(0, payload.outputEventCount)
    assertEquals(0, payload.microbarEventCount)
    assertEquals(0, payload.signalEventCount)
    assertEquals(0, payload.currentInputEventCount)
    assertEquals(0, payload.currentOutputEventCount)
    assertEquals(0, payload.currentRecordCount)
    assertNull(payload.microbarRatePerSecond)
    assertNull(payload.signalRatePerSecond)
    assertEquals(false, payload.clickhouseSinkEnabled)
    assertEquals(emptyMap(), payload.perSymbolLatestEventTs)
    assertEquals("regular", payload.marketSessionState)
    assertEquals("source_lag_missing_during_regular_session", payload.statusReason)
    assertEquals("degraded", payload.status)
  }

  @Test
  fun `heartbeat payload reports source lag and current processing rates`() {
    val now = Instant.parse("2026-07-07T14:00:05Z")
    val lastInputEvent = Instant.parse("2026-07-07T14:00:02Z")
    val lastOutputEvent = Instant.parse("2026-07-07T14:00:03Z")

    val payload =
      taStatusPayload(
        now = now,
        watermark = lastInputEvent.toEpochMilli(),
        lastInputEventMs = lastInputEvent.toEpochMilli(),
        lastOutputEventMs = lastOutputEvent.toEpochMilli(),
        inputEventCount = 25,
        outputEventCount = 15,
        lastHeartbeatInputCount = 5,
        lastHeartbeatOutputCount = 10,
        lastHeartbeatMs = now.minusSeconds(10).toEpochMilli(),
        perSymbolLatestEventTs = mapOf("NVDA" to lastOutputEvent.toString()),
        clickhouseSinkEnabled = true,
      )

    assertEquals(lastOutputEvent.toString(), payload.lastEventTs)
    assertEquals(lastInputEvent.toString(), payload.lastInputEventTs)
    assertEquals(lastOutputEvent.toString(), payload.lastOutputEventTs)
    assertEquals(2_000, payload.sourceLagMs)
    assertEquals(3_000, payload.watermarkLagMs)
    assertEquals(25, payload.inputEventCount)
    assertEquals(15, payload.outputEventCount)
    assertEquals(25, payload.microbarEventCount)
    assertEquals(15, payload.signalEventCount)
    assertEquals(20, payload.currentInputEventCount)
    assertEquals(5, payload.currentOutputEventCount)
    assertEquals(25, payload.currentRecordCount)
    assertEquals(2.0, payload.inputRatePerSecond)
    assertEquals(0.5, payload.outputRatePerSecond)
    assertEquals(2.0, payload.microbarRatePerSecond)
    assertEquals(0.5, payload.signalRatePerSecond)
    assertEquals(true, payload.clickhouseSinkEnabled)
    assertEquals("regular", payload.marketSessionState)
    assertNull(payload.statusReason)
    assertEquals("ok", payload.status)
    assertEquals(mapOf("NVDA" to lastOutputEvent.toString()), payload.perSymbolLatestEventTs)
  }

  @Test
  fun `regular session heartbeat degrades on stale source lag even when counters moved`() {
    val now = Instant.parse("2026-07-07T14:10:05Z")
    val lastInputEvent = Instant.parse("2026-07-07T14:00:00Z")
    val lastOutputEvent = Instant.parse("2026-07-07T14:00:05Z")

    val payload =
      taStatusPayload(
        now = now,
        watermark = lastOutputEvent.toEpochMilli(),
        lastInputEventMs = lastInputEvent.toEpochMilli(),
        lastOutputEventMs = lastOutputEvent.toEpochMilli(),
        inputEventCount = 25,
        outputEventCount = 15,
        lastHeartbeatInputCount = 5,
        lastHeartbeatOutputCount = 10,
        lastHeartbeatMs = now.minusSeconds(10).toEpochMilli(),
        perSymbolLatestEventTs = mapOf("NVDA" to lastOutputEvent.toString()),
        clickhouseSinkEnabled = true,
        sourceLagDegradedAfterMs = 300_000,
      )

    assertEquals(600_000, payload.sourceLagMs)
    assertEquals(25, payload.currentRecordCount)
    assertEquals("regular", payload.marketSessionState)
    assertEquals("source_lag_stale_during_regular_session", payload.statusReason)
    assertEquals("degraded", payload.status)
  }

  @Test
  fun `first regular session heartbeat counts records as current when there is no prior heartbeat`() {
    val now = Instant.parse("2026-07-07T14:00:05Z")
    val lastInputEvent = Instant.parse("2026-07-07T14:00:02Z")
    val lastOutputEvent = Instant.parse("2026-07-07T14:00:03Z")

    val payload =
      taStatusPayload(
        now = now,
        watermark = lastOutputEvent.toEpochMilli(),
        lastInputEventMs = lastInputEvent.toEpochMilli(),
        lastOutputEventMs = lastOutputEvent.toEpochMilli(),
        inputEventCount = 2,
        outputEventCount = 1,
        lastHeartbeatInputCount = 0,
        lastHeartbeatOutputCount = 0,
        lastHeartbeatMs = null,
        perSymbolLatestEventTs = mapOf("NVDA" to lastOutputEvent.toString()),
        clickhouseSinkEnabled = true,
      )

    assertEquals(2, payload.currentInputEventCount)
    assertEquals(1, payload.currentOutputEventCount)
    assertEquals(3, payload.currentRecordCount)
    assertNull(payload.inputRatePerSecond)
    assertNull(payload.outputRatePerSecond)
    assertEquals("regular", payload.marketSessionState)
    assertNull(payload.statusReason)
    assertEquals("ok", payload.status)
  }

  @Test
  fun `zero current records are not degraded outside regular market session`() {
    val payload =
      taStatusPayload(
        now = Instant.parse("2026-07-07T02:00:05Z"),
        watermark = Long.MIN_VALUE,
        lastInputEventMs = null,
        lastOutputEventMs = null,
        inputEventCount = 10,
        outputEventCount = 10,
        lastHeartbeatInputCount = 10,
        lastHeartbeatOutputCount = 10,
        lastHeartbeatMs = Instant.parse("2026-07-07T02:00:00Z").toEpochMilli(),
        perSymbolLatestEventTs = emptyMap(),
        clickhouseSinkEnabled = true,
      )

    assertEquals(0, payload.currentRecordCount)
    assertEquals("outside_regular_session", payload.marketSessionState)
    assertNull(payload.statusReason)
    assertEquals("ok", payload.status)
  }

  @Test
  fun `status heartbeat startup tick is java serializable`() {
    assertSerializable(
      StatusHeartbeatInput.StartupTick(
        createdAtEpochMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli(),
      ),
    )
  }

  @Test
  fun `status heartbeat stream type covers startup ticks microbars and signals`() {
    val typeInformation = TypeInformation.of(object : TypeHint<StatusHeartbeatInput>() {})
    val microbar = StatusHeartbeatInput.MicroBar(microbarEnvelope())
    val signal = StatusHeartbeatInput.Signal(signalEnvelope())

    assertNotNull(typeInformation)
    assertEquals("NVDA", microbar.envelope.symbol)
    assertEquals("NVDA", signal.envelope.symbol)
  }

  private fun microbarEnvelope(): Envelope<MicroBarPayload> =
    Envelope(
      ingestTs = Instant.parse("2026-07-07T14:00:01Z"),
      eventTs = Instant.parse("2026-07-07T14:00:00Z"),
      feed = "alpaca",
      channel = "trades",
      symbol = "NVDA",
      seq = 1,
      payload =
        MicroBarPayload(
          o = 100.0,
          h = 101.0,
          l = 99.0,
          c = 100.5,
          v = 10.0,
          vwap = 100.25,
          count = 3,
          t = Instant.parse("2026-07-07T14:00:00Z"),
        ),
      isFinal = true,
      source = "ta",
      window = null,
      version = 1,
    )

  private fun signalEnvelope(): Envelope<TaSignalsPayload> =
    Envelope(
      ingestTs = Instant.parse("2026-07-07T14:00:02Z"),
      eventTs = Instant.parse("2026-07-07T14:00:01Z"),
      feed = "ta",
      channel = "signals",
      symbol = "NVDA",
      seq = 2,
      payload = TaSignalsPayload(),
      isFinal = true,
      source = "ta",
      window = null,
      version = 1,
    )

  private fun assertSerializable(value: Any) {
    val serialized = ByteArrayOutputStream()
    ObjectOutputStream(serialized).use { it.writeObject(value) }
    assertNotNull(serialized.toByteArray())
  }
}
