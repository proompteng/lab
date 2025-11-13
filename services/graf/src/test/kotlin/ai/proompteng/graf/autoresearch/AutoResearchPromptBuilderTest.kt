package ai.proompteng.graf.autoresearch

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AutoResearchPromptBuilderTest {
  private val fixedClock = Clock.fixed(Instant.parse("2025-11-12T12:34:56Z"), ZoneOffset.UTC)
  private val config =
    AutoResearchConfig(
      knowledgeBaseName = "Test KB",
      stage = "custom-stage",
      streamId = "stream",
      defaultOperatorGuidance = "use defaults",
      defaultGoalsText = "1. Do things",
    )

  @Test
  fun `buildPrompt injects operator guidance`() {
    val builder = AutoResearchPromptBuilder(config, fixedClock)
    val prompt = builder.buildPrompt("user guidance")

    assertTrue(prompt.contains("Test KB"))
    assertTrue(prompt.contains("custom-stage"))
    assertTrue(prompt.contains("user guidance"))
    assertTrue(prompt.contains("2025-11-12T12:34:56Z"))
  }

  @Test
  fun `buildMetadata falls back to defaults`() {
    val builder = AutoResearchPromptBuilder(config, fixedClock)
    val metadata = builder.buildMetadata(null, "workflow-123")

    assertEquals("custom-stage", metadata["codex.stage"])
    assertEquals("stream", metadata["streamId"])
    assertEquals("workflow-123", metadata["autoResearch.argoWorkflow"])
    assertEquals("2025-11-12T12:34:56Z", metadata["autoResearch.generatedAt"])
  }
}
