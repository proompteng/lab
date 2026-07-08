package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
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
        lastEventMs = null,
        eventCount = 0,
        lastHeartbeatCount = 0,
        lastHeartbeatMs = null,
        perSymbolLatestEventTs = emptyMap(),
      )

    assertNull(payload.lastInputEventTs)
    assertNull(payload.lastOutputEventTs)
    assertNull(payload.sourceLagMs)
    assertNull(payload.watermarkLagMs)
    assertEquals(0, payload.inputEventCount)
    assertEquals(0, payload.outputEventCount)
    assertEquals(emptyMap(), payload.perSymbolLatestEventTs)
    assertEquals("ok", payload.status)
  }

  @Test
  fun `heartbeat payload reports source lag and current input rate`() {
    val now = Instant.parse("2026-07-07T14:00:05Z")
    val lastEvent = Instant.parse("2026-07-07T14:00:02Z")

    val payload =
      taStatusPayload(
        now = now,
        watermark = lastEvent.toEpochMilli(),
        lastEventMs = lastEvent.toEpochMilli(),
        eventCount = 25,
        lastHeartbeatCount = 5,
        lastHeartbeatMs = now.minusSeconds(10).toEpochMilli(),
        perSymbolLatestEventTs = mapOf("NVDA" to lastEvent.toString()),
      )

    assertEquals(lastEvent.toString(), payload.lastInputEventTs)
    assertEquals(lastEvent.toString(), payload.lastOutputEventTs)
    assertEquals(3_000, payload.sourceLagMs)
    assertEquals(3_000, payload.watermarkLagMs)
    assertEquals(25, payload.inputEventCount)
    assertEquals(25, payload.outputEventCount)
    assertEquals(2.0, payload.inputRatePerSecond)
    assertEquals(2.0, payload.outputRatePerSecond)
    assertEquals(mapOf("NVDA" to lastEvent.toString()), payload.perSymbolLatestEventTs)
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
  fun `status heartbeat stream type covers startup ticks and microbars`() {
    val typeInformation = TypeInformation.of(object : TypeHint<StatusHeartbeatInput>() {})
    val microbar = StatusHeartbeatInput.MicroBar(microbarEnvelope())

    assertNotNull(typeInformation)
    assertEquals("NVDA", microbar.envelope.symbol)
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

  private fun assertSerializable(value: Any) {
    val serialized = ByteArrayOutputStream()
    ObjectOutputStream(serialized).use { it.writeObject(value) }
    assertNotNull(serialized.toByteArray())
  }
}
