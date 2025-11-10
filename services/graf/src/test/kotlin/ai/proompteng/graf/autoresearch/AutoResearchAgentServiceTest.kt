package ai.proompteng.graf.autoresearch

import ai.koog.prompt.executor.clients.openai.OpenAIChatParams
import ai.koog.prompt.executor.clients.openai.OpenAIModels
import ai.koog.prompt.executor.clients.openai.base.models.ReasoningEffort
import ai.koog.prompt.llm.LLMCapability
import ai.koog.prompt.llm.LLModel
import ai.koog.prompt.llm.LLMProvider
import ai.proompteng.graf.config.AutoResearchConfig
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AutoResearchAgentServiceTest {
  private val baseConfig =
    AutoResearchConfig(
      enabled = true,
      openAiApiKey = "test",
      openAiBaseUrl = null,
      model = "gpt-5",
      temperature = 0.2,
      maxIterations = 8,
      graphSampleLimit = 25,
    )

  @Test
  fun `openai prompt params omit explicit temperature`() {
    val params = promptParamsForModel(OpenAIModels.Chat.GPT5, baseConfig)

    assertTrue(params is OpenAIChatParams)
    assertNull(params.temperature)
    assertEquals(ReasoningEffort.HIGH, params.reasoningEffort)
  }

  @Test
  fun `non openai prompt params keep configured temperature`() {
    val customProvider = object : LLMProvider("custom", "Custom") {}
    val customModel = LLModel(customProvider, "custom-model", emptyList<LLMCapability>(), 4096, null)

    val params = promptParamsForModel(customModel, baseConfig)

    assertEquals(baseConfig.temperature, params.temperature)
  }
}
