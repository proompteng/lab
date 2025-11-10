package ai.proompteng.graf.autoresearch

import ai.koog.prompt.executor.clients.openai.OpenAIModels
import ai.koog.prompt.llm.LLMCapability
import ai.koog.prompt.llm.LLMProvider
import ai.koog.prompt.llm.LLModel
import ai.koog.prompt.params.LLMParams
import ai.proompteng.graf.config.AutoResearchConfig
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AutoResearchAgentServiceTest {
  private val baseConfig =
    AutoResearchConfig(
      enabled = true,
      openAiApiKey = "test",
      openAiBaseUrl = null,
      model = "gpt-5",
      maxIterations = 8,
      graphSampleLimit = 25,
      traceLoggingEnabled = false,
      traceLogLevel = "INFO",
      knowledgeBaseName = "Graf knowledge base",
      knowledgeBaseStage = "pilot",
      operatorGuidance = "Focus on the highest-impact relationships.",
      defaultStreamId = "auto-research",
    )

  @Test
  fun `openai prompt params omit explicit temperature`() {
    val params = promptParamsForModel(OpenAIModels.Chat.GPT5, baseConfig)
    assertNull(params.temperature)
    val schema = params.schema as LLMParams.Schema.JSON.Standard
    assertEquals(GraphRelationshipPlanSchema.SCHEMA_NAME, schema.name)
    assertEquals(GraphRelationshipPlanSchema.json, schema.schema)
  }

  @Test
  fun `non openai prompt params keep configured temperature`() {
    val customProvider = object : LLMProvider("custom", "Custom") {}
    val customModel = LLModel(customProvider, "custom-model", emptyList<LLMCapability>(), 4096, null)

    val params = promptParamsForModel(customModel, baseConfig)

    assertEquals(0.2, params.temperature)
    assertNull(params.schema)
  }
}
