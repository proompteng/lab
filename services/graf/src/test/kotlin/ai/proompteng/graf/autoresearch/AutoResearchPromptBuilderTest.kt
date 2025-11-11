package ai.proompteng.graf.autoresearch

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AutoResearchPromptBuilderTest {
  private val fixedClock: Clock = Clock.fixed(Instant.parse("2025-11-10T05:00:00Z"), ZoneOffset.UTC)
  private val builder = AutoResearchPromptBuilder(clock = fixedClock)

  @Test
  fun `buildPrompt injects timestamp and operator guidance`() {
    val prompt = builder.buildPrompt("Focus on HBM capacity and ASE contracts")

    assertTrue(prompt.contains("UTC timestamp: 2025-11-10T05:00:00Z"))
    assertTrue(prompt.contains("/usr/local/bin/codex-graf"))
    assertTrue(prompt.contains("`streamId` = \"auto-research\""))
    assertTrue(prompt.contains("Operator guidance:"))
    assertTrue(prompt.contains("Focus on HBM capacity and ASE contracts"))
  }

  @Test
  fun `buildMetadata trims and caps user prompt`() {
    val metadata = builder.buildMetadata("  Focus on OSAT expansions  ", "auto-research-123")

    assertEquals("auto-research", metadata["codex.stage"])
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
}
