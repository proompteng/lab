package ai.proompteng.dorvud.ta.flink

import org.apache.flink.streaming.api.operators.StreamFlatMap
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord
import org.apache.flink.streaming.util.OneInputStreamOperatorTestHarness
import kotlin.test.Test
import kotlin.test.assertEquals

class LatestTradeExclusionTest {
  @Test
  fun `latest REST samples never enter the trade-volume stream`() {
    OneInputStreamOperatorTestHarness(StreamFlatMap(ParseRecordedTrade())).use { h ->
      h.open()
      for ((offset, source) in listOf("rest_latest", "ws", "rest").withIndex()) {
        val body = """
          {"ingestTs":"2026-09-11T14:00:01Z","eventTs":"2026-09-11T14:00:00Z","feed":"iex","channel":"trades","symbol":"AMD","seq":1,
          "payload":{"p":100,"s":10,"t":"2026-09-11T14:00:00Z"},"source":"$source"}
        """
        h.processElement(StreamRecord(ArchiveKafkaRecord("trades", 0, offset.toLong(), body)))
      }
      assertEquals(listOf("ws", "rest"), h.extractOutputValues().map { it.envelope.source })
    }
  }
}
