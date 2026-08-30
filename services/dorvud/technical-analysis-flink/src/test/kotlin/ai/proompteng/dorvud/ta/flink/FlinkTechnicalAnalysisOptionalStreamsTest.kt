package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import org.apache.flink.api.common.typeinfo.TypeHint
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class FlinkTechnicalAnalysisOptionalStreamsTest {
  @Test
  fun `missing quote topic builds typed empty stream`() {
    val env = StreamExecutionEnvironment.getExecutionEnvironment()

    val stream = emptyQuoteStream(env)

    assertEquals(TypeInformation.of(object : TypeHint<Envelope<QuotePayload>>() {}), stream.type)
    assertNotNull(env.getStreamGraph())
  }

  @Test
  fun `missing bars topic builds typed empty stream`() {
    val env = StreamExecutionEnvironment.getExecutionEnvironment()

    val stream = emptyBars1mStream(env)

    assertEquals(TypeInformation.of(object : TypeHint<Envelope<MicroBarPayload>>() {}), stream.type)
    assertNotNull(env.getStreamGraph())
  }
}
