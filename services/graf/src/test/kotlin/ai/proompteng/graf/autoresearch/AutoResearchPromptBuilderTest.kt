package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.config.AutoResearchConfig
import ai.proompteng.graf.model.AutoResearchPlanIntent
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertTrue

class AutoResearchPromptBuilderTest {
  private val baseIntent =
    AutoResearchPlanIntent(
      objective = "Map partnerships",
      metadata = mapOf("requester" to "graf-api"),
    )

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

  private val json = Json { encodeDefaults = true }
  private val builder = AutoResearchPromptBuilder(baseConfig, json)

  @Test
  fun `prompt includes configured metadata defaults`() {
    val prompt = builder.build(baseIntent)

    assertTrue(prompt.contains("Graf knowledge base"))
    assertTrue(prompt.contains("stage pilot"))
    assertTrue(prompt.contains("Research stream: auto-research"))
    assertTrue(prompt.contains("Focus on the highest-impact relationships."))
  }

  @Test
  fun `prompt honors overrides and metadata`() {
    val customConfig =
      baseConfig.copy(
        knowledgeBaseName = "Summit Collective",
        knowledgeBaseStage = "production",
        operatorGuidance = "Surface regulatory relationships first.",
        defaultStreamId = "summit-stream",
      )
    val customBuilder = AutoResearchPromptBuilder(customConfig, json)
    val prompt = customBuilder.build(baseIntent.copy(streamId = null))

    assertTrue(prompt.contains("Summit Collective"))
    assertTrue(prompt.contains("stage production"))
    assertTrue(prompt.contains("Research stream: summit-stream"))
    assertTrue(prompt.contains("Surface regulatory relationships first."))
  }
}
