package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.autoresearch.AutoResearchConfig
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AutoResearchPromptBuilderTest {
  private val fixedClock: Clock = Clock.fixed(Instant.parse("2025-11-10T05:00:00Z"), ZoneOffset.UTC)
  private val defaultConfig =
    AutoResearchConfig(
      knowledgeBaseName = AutoResearchConfig.DEFAULT_KNOWLEDGE_BASE_NAME,
      stage = AutoResearchConfig.DEFAULT_STAGE,
      streamId = AutoResearchConfig.DEFAULT_STREAM_ID,
      defaultOperatorGuidance = AutoResearchConfig.DEFAULT_OPERATOR_GUIDANCE,
      defaultGoalsText = AutoResearchConfig.DEFAULT_GOALS_TEXT,
    )
  private val builder = AutoResearchPromptBuilder(defaultConfig, clock = fixedClock)

  @Test
  fun `workflow prefix sanitizes invalid characters`() {
    val funkyStage = AutoResearchConfig(
      knowledgeBaseName = AutoResearchConfig.DEFAULT_KNOWLEDGE_BASE_NAME,
      stage = "Auto Research_stage.v2",
      streamId = AutoResearchConfig.DEFAULT_STREAM_ID,
      defaultOperatorGuidance = AutoResearchConfig.DEFAULT_OPERATOR_GUIDANCE,
      defaultGoalsText = AutoResearchConfig.DEFAULT_GOALS_TEXT,
    )

    assertEquals("auto-research-stage-v2", funkyStage.workflowNamePrefix)
  }

  @Test
  fun `buildPrompt injects timestamp and operator guidance`() {
    val prompt = builder.buildPrompt("Focus on HBM capacity and ASE contracts")

    assertTrue(prompt.contains("UTC 2025-11-10T05:00:00Z"))
    assertTrue(prompt.contains("/usr/local/bin/codex-graf"))
    assertTrue(prompt.contains("`streamId` = \"${defaultConfig.streamId}\""))
    assertTrue(prompt.contains("Operator guidance:"))
    assertTrue(prompt.contains("Focus on HBM capacity and ASE contracts"))
  }

  @Test
  fun `buildMetadata trims and caps user prompt`() {
    val metadata = builder.buildMetadata("  Focus on OSAT expansions  ", "auto-research-123")

    assertEquals(defaultConfig.stage, metadata["codex.stage"])
    assertEquals(defaultConfig.streamId, metadata["streamId"])
    assertEquals("2025-11-10T05:00:00Z", metadata["autoResearch.generatedAt"])
    assertEquals("auto-research-123", metadata["autoResearch.argoWorkflow"])
    assertEquals("Focus on OSAT expansions", metadata["autoResearch.userPrompt"])
    assertEquals("2025-11-10", metadata["autoResearch.promptVersion"])
  }

  @Test
  fun `buildMetadata truncates extremely long user prompt`() {
    val longPrompt = buildString { repeat(1000) { append('a') } }
    val metadata = builder.buildMetadata(longPrompt, "auto-research-x")

    assertEquals(800, metadata["autoResearch.userPrompt"]?.length)
  }

  @Test
  fun `buildPrompt respects config overrides`() {
    val overrideConfig =
      AutoResearchConfig(
        knowledgeBaseName = "Acme Knowledge Graph",
        stage = "targeted-research",
        streamId = "acme-stream",
        defaultOperatorGuidance = "Stay close to the energy supply chain narrative.",
        defaultGoalsText = "1. Track energy partners\n2. Annotate resilience data",
      )
    val overrideBuilder = AutoResearchPromptBuilder(overrideConfig, clock = fixedClock)
    val prompt = overrideBuilder.buildPrompt(null)

    assertTrue(prompt.contains("Acme Knowledge Graph"))
    assertTrue(prompt.contains("stage targeted-research"))
    assertTrue(prompt.contains("streamId"))
  }
}
