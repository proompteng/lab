package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import org.apache.flink.api.common.typeinfo.Types
import org.apache.flink.api.java.functions.KeySelector
import org.apache.flink.streaming.api.operators.co.KeyedCoProcessOperator
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord
import org.apache.flink.streaming.util.KeyedTwoInputStreamOperatorTestHarness
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class CanonicalSignalsTest {
  private val start = Instant.parse("2026-09-11T13:30:00Z")

  private fun bar(
    index: Int,
    price: Double = 100.0 + index,
  ): Envelope<MicroBarPayload> {
    val time = start.plusSeconds(index * 60L)
    return Envelope(
      ingestTs = time.plusSeconds(61),
      eventTs = time,
      feed = "iex",
      channel = "bars",
      symbol = "AAPL",
      seq = index.toLong(),
      payload = MicroBarPayload(price, price, price, price, 1.0, price, 1, time),
    )
  }

  private fun harness() =
    KeyedTwoInputStreamOperatorTestHarness(
      KeyedCoProcessOperator(
        TaSignalsFunction(FlinkTaConfig.fromEnv(), Duration.ofMinutes(1), SignalBarTimestampAnchor.START, false),
      ),
      KeySelector<Envelope<MicroBarPayload>, String> { it.symbol },
      KeySelector<Envelope<QuotePayload>, String> { it.symbol },
      Types.STRING,
    )

  @Test fun `duplicates are inert and corrections rebuild all affected outputs`() {
    harness().use { h ->
      h.open()
      for (index in 0..39) h.processElement1(StreamRecord(bar(index)))
      val initial: List<Envelope<TaSignalsPayload>> = h.extractOutputValues()
      assertEquals(40, initial.size)
      assertEquals(119.5, assertNotNull(initial.last().payload.vwap).session)
      h.processElement1(StreamRecord(bar(0)))
      assertEquals(40, h.extractOutputValues().size)
      h.processElement1(StreamRecord(bar(0, 80.0).copy(ingestTs = start.plusSeconds(3000))))
      assertEquals(80, h.extractOutputValues().size)
      assertEquals(
        119.0,
        assertNotNull(
          h
            .extractOutputValues()
            .last()
            .payload.vwap,
        ).session,
      )
      harness().use { expected ->
        expected.open()
        for (index in 0..39) expected.processElement1(StreamRecord(bar(index, if (index == 0) 80.0 else 100.0 + index)))
        assertEquals(expected.extractOutputValues().map { it.payload }, h.extractOutputValues().takeLast(40).map { it.payload })
      }
    }
  }

  @Test fun `rollover clears session volume and indicator readiness`() {
    harness().use { h ->
      h.open()
      for (index in 0..39) h.processElement1(StreamRecord(bar(index)))
      assertNotNull(
        h
          .extractOutputValues()
          .last()
          .payload.ema,
      )
      val next = bar(0, 200.0)
      val nextTime = start.plusSeconds(86400)
      h.processElement1(
        StreamRecord(next.copy(eventTs = nextTime, ingestTs = nextTime.plusSeconds(61), payload = next.payload.copy(t = nextTime))),
      )
      val payload = h.extractOutputValues().last().payload
      assertEquals(200.0, assertNotNull(payload.vwap).session)
      assertNull(payload.ema)
      assertNull(payload.rsi14)
      assertNull(payload.vol_realized)
      h.processElement1(StreamRecord(bar(39).copy(ingestTs = nextTime.plusSeconds(120))))
      assertEquals(41, h.extractOutputValues().size)
    }
  }

  @Test fun `restore retains recursive seed and session totals`() {
    val snapshot =
      harness().use { h ->
        h.open()
        for (index in 0..99) h.processElement1(StreamRecord(bar(index)))
        h.snapshot(1, start.plusSeconds(6000).toEpochMilli())
      }
    harness().use { restored ->
      restored.initializeState(snapshot)
      restored.open()
      restored.processElement1(StreamRecord(bar(100)))
      harness().use { uninterrupted ->
        uninterrupted.open()
        for (index in 0..100) uninterrupted.processElement1(StreamRecord(bar(index)))
        assertEquals(uninterrupted.extractOutputValues().last().payload, restored.extractOutputValues().single().payload)
      }
    }
  }
}
