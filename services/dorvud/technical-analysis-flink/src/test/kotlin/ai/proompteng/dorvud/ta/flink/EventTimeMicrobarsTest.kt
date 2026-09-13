package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.state.ValueState
import org.apache.flink.api.common.state.ValueStateDescriptor
import org.apache.flink.api.common.typeinfo.Types
import org.apache.flink.api.java.functions.KeySelector
import org.apache.flink.streaming.api.functions.KeyedProcessFunction
import org.apache.flink.streaming.api.operators.KeyedProcessOperator
import org.apache.flink.streaming.api.watermark.Watermark
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness
import org.apache.flink.util.Collector
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class EventTimeMicrobarsTest {
  private val start = Instant.parse("2026-09-11T13:30:00Z")

  private fun trade(
    millis: Long,
    price: Double,
    offset: Long,
  ) = RecordedTrade(
    Envelope(
      ingestTs = start.plusSeconds(3),
      eventTs = start.plusMillis(millis),
      feed = "iex",
      channel = "trades",
      symbol = "AAPL",
      seq = offset,
      payload = TradePayload(price, 1.0, start.plusMillis(millis)),
    ),
    "trades",
    0,
    offset,
  )

  private fun harness(interruptible: Boolean = true) =
    KeyedOneInputStreamOperatorTestHarness(
      if (interruptible) MicrobarOperator() else KeyedProcessOperator(MicrobarProcessFunction()),
      KeySelector<RecordedTrade, String> { it.envelope.symbol },
      Types.STRING,
    )

  @Test fun `buckets finalize only on watermark and open close follow event time`() {
    harness().use { h ->
      h.open()
      h.processElement(StreamRecord(trade(800, 103.0, 1)))
      h.processElement(StreamRecord(trade(1200, 105.0, 2)))
      h.processElement(StreamRecord(trade(100, 100.0, 3)))
      h.processElement(StreamRecord(trade(100, 100.0, 3)))
      assertTrue(h.extractOutputValues().isEmpty())
      h.processWatermark(Watermark(start.plusSeconds(1).toEpochMilli()))
      val first: Envelope<MicroBarPayload> = h.extractOutputValues().single()
      assertEquals(100.0, first.payload.o)
      assertEquals(103.0, first.payload.c)
      assertEquals(2.0, first.payload.v)
      assertEquals(101.5, first.payload.vwap)
      assertEquals(2, first.version)
      h.processElement(StreamRecord(trade(500, 999.0, 4)))
      assertEquals(1, h.getSideOutput(MicrobarProcessFunction.lateTradeOutput).size)
      h.processWatermark(Watermark(start.plusSeconds(2).toEpochMilli()))
      assertEquals(listOf(100.0, 105.0), h.extractOutputValues().map { it.payload.o })
    }
  }

  @Test fun `checkpoint restores all open buckets and deduplication before finalization`() {
    val snapshot =
      harness(interruptible = false).use { h ->
        h.open()
        h.processElement(StreamRecord(trade(100, 100.0, 1)))
        h.processElement(StreamRecord(trade(1200, 105.0, 2)))
        val saved = h.snapshot(1, start.toEpochMilli())
        h.processElement(StreamRecord(trade(500, 102.0, 3)))
        h.processWatermark(Watermark(start.plusSeconds(2).toEpochMilli()))
        assertEquals(listOf(2.0, 1.0), h.extractOutputValues().map { it.payload.v })
        saved
      }
    harness().use { h ->
      h.initializeState(snapshot)
      h.open()
      h.processElement(StreamRecord(trade(100, 100.0, 1)))
      h.processWatermark(Watermark(start.plusSeconds(2).toEpochMilli()))
      assertEquals(listOf(1.0, 1.0), h.extractOutputValues().map { it.payload.v })
      assertEquals(listOf(1L, 2L), h.extractOutputValues().map { it.seq })
    }
  }

  @Test fun `equal price distinct records count while conflicting coordinates fail`() {
    val original = trade(100, 100.0, 1)
    val bucket = EventTimeTradeBucket().add(original).add(trade(100, 100.0, 2))
    assertEquals(2L, bucket.payload().count)
    assertFailsWith<IllegalArgumentException> { bucket.add(trade(100, 102.0, 1)) }
  }

  @Test fun `restores bucket bytes from the deployed v2 serializer`() {
    val serializer =
      org.apache.flink.api.java.typeutils.runtime.kryo.KryoSerializer(
        EventTimeTradeBucket::class.java,
        org.apache.flink.api.common.serialization
          .SerializerConfigImpl(),
      )
    // Captured with the unmodified serializer at 254dadd248e1b3b45d01fe90379f38ec587f5561.
    val encoded = checkNotNull(javaClass.getResourceAsStream("/microbar-bucket-v2.base64")).bufferedReader().use { it.readText().trim() }
    val bucket =
      serializer.deserialize(
        org.apache.flink.core.memory
          .DataInputDeserializer(
            java.util.Base64
              .getDecoder()
              .decode(encoded),
          ),
      )
    bucket.add(trade(800, 103.0, 1))
    bucket.add(trade(500, 101.0, 3))
    assertEquals(3L, bucket.payload().count)
    assertEquals(100.0, bucket.payload().o)
    assertEquals(103.0, bucket.payload().c)
    assertFailsWith<IllegalArgumentException> { bucket.add(trade(800, 104.0, 1)) }
  }

  @Test fun `large buckets preserve distinct source records and redelivery`() {
    val count = 20_000
    val started = System.nanoTime()
    var bucket = EventTimeTradeBucket()
    for (index in 0 until count) bucket = bucket.add(trade(index % 1000L, 100.0, index.toLong()))
    for (index in 0 until count) bucket = bucket.add(trade(index % 1000L, 100.0, index.toLong()))
    val payload = bucket.payload()
    assertEquals(count.toLong(), payload.count)
    assertEquals(count.toDouble(), payload.v)
    assertEquals(100.0, payload.vwap)
    println("Microbar bucket $count inserts and redeliveries: ${(System.nanoTime() - started) / 1_000_000} ms")
  }

  @Test fun `legacy savepoint retains sequence and retires unprovable unfinished aggregate`() {
    val legacy =
      object : KeyedProcessFunction<String, RecordedTrade, Envelope<MicroBarPayload>>() {
        private lateinit var bucket: ValueState<BucketState>
        private lateinit var sequence: ValueState<Long>

        override fun open(openContext: OpenContext) {
          bucket = runtimeContext.getState(ValueStateDescriptor("bucket", BucketState::class.java))
          sequence = runtimeContext.getState(ValueStateDescriptor("seq", Long::class.java))
        }

        override fun processElement(
          value: RecordedTrade,
          ctx: Context,
          out: Collector<Envelope<MicroBarPayload>>,
        ) {
          val end = (value.envelope.payload.t.epochSecond + 1) * 1000
          bucket.update(BucketState.fromTrade(end - 1000, end, value.envelope.payload))
          sequence.update(7)
          ctx.timerService().registerEventTimeTimer(end)
        }
      }
    val snapshot =
      KeyedOneInputStreamOperatorTestHarness(
        KeyedProcessOperator(legacy),
        KeySelector<RecordedTrade, String> { it.envelope.symbol },
        Types.STRING,
      ).use { h ->
        h.open()
        h.processElement(StreamRecord(trade(100, 100.0, 1)))
        h.snapshot(1, start.toEpochMilli())
      }
    harness().use { h ->
      h.initializeState(snapshot)
      h.open()
      h.processElement(StreamRecord(trade(1200, 105.0, 2)))
      h.processWatermark(Watermark(start.plusSeconds(2).toEpochMilli()))
      assertEquals(listOf(105.0), h.extractOutputValues().map { it.payload.o })
      assertEquals(8L, h.extractOutputValues().single().seq)
    }
  }
}
