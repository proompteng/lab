package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoResearchPlanIntent
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.temporal.common.converter.DataConverterException
import io.temporal.common.converter.DefaultDataConverter
import io.temporal.common.converter.JacksonJsonPayloadConverter
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AutoResearchTemporalSerializationTest {
  private val intent =
    AutoResearchPlanIntent(
      objective = "Map supply chain partnerships",
      focus = "HBM",
      streamId = "stream-123",
      metadata = mapOf("requester" to "graf-api", "region" to "NA"),
      sampleLimit = 25,
    )
  private val input = AutoResearchWorkflowInput(intent)

  @Test
  fun `default converter fails to deserialize AutoResearch workflow input`() {
    val converter = DefaultDataConverter.newDefaultInstance()
    val payloads = converter.toPayloads(input)

    assertFailsWith<DataConverterException> {
      converter.fromPayloads(0, payloads, AutoResearchWorkflowInput::class.java, AutoResearchWorkflowInput::class.java)
    }
  }

  @Test
  fun `jackson kotlin converter round trips AutoResearch workflow input`() {
    val mapper =
      jacksonObjectMapper()
        .findAndRegisterModules()
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
    val converter =
      DefaultDataConverter
        .newDefaultInstance()
        .withPayloadConverterOverrides(JacksonJsonPayloadConverter(mapper))
    val payloads = converter.toPayloads(input)

    val restored =
      converter.fromPayloads(0, payloads, AutoResearchWorkflowInput::class.java, AutoResearchWorkflowInput::class.java)

    assertEquals(input, restored)
  }
}
