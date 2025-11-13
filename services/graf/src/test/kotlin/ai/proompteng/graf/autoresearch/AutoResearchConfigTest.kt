package ai.proompteng.graf.autoresearch

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AutoResearchConfigTest {
  @Test
  fun `fromEnvMap falls back to defaults`() {
    val config = AutoResearchConfig.fromEnvMap(emptyMap())

    assertEquals(AutoResearchConfig.DEFAULT_KNOWLEDGE_BASE_NAME, config.knowledgeBaseName)
    assertEquals(AutoResearchConfig.DEFAULT_STAGE, config.stage)
    assertEquals(AutoResearchConfig.DEFAULT_STREAM_ID, config.streamId)
    assertEquals(AutoResearchConfig.DEFAULT_OPERATOR_GUIDANCE, config.defaultOperatorGuidance)
    assertEquals(AutoResearchConfig.DEFAULT_GOALS_TEXT, config.defaultGoalsText)
  }

  @Test
  fun `fromEnvMap applies sanitized stage`() {
    val config =
      AutoResearchConfig.fromEnvMap(
        mapOf(
          "AUTO_RESEARCH_STAGE" to "  Te$#ST Stage!!  ",
          "AUTO_RESEARCH_KB_NAME" to "KB",
          "AUTO_RESEARCH_STREAM_ID" to "stream",
          "AUTO_RESEARCH_OPERATOR_GUIDANCE" to "guidance",
          "AUTO_RESEARCH_DEFAULT_GOALS" to "goal",
        ),
      )

    assertEquals("KB", config.knowledgeBaseName)
    assertEquals("stream", config.streamId)
    assertEquals("guidance", config.defaultOperatorGuidance)
    assertEquals("goal", config.defaultGoalsText)
    assertTrue(config.workflowNamePrefix.startsWith("te-st-stage"))
  }
}
