package ai.proompteng.graf.config

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AutoResearchConfigTest {
  @Test
  fun `trace logging defaults to enabled info`() {
    val config = AutoResearchConfig.fromEnvironment(emptyMap<String, String>())

    assertTrue(config.traceLoggingEnabled)
    assertEquals("INFO", config.traceLogLevel)
  }

  @Test
  fun `trace logging env overrides applied`() {
    val config =
      AutoResearchConfig.fromEnvironment(
        mapOf(
          "AGENT_OPENAI_API_KEY" to "test",
          "AGENT_TRACE_LOGGING" to "FALSE",
          "AGENT_TRACE_LOG_LEVEL" to "warn",
        ),
      )

    assertFalse(config.traceLoggingEnabled)
    assertEquals("warn", config.traceLogLevel)
  }

  @Test
  fun `blank trace log level falls back to default`() {
    val config =
      AutoResearchConfig.fromEnvironment(
        mapOf(
          "AGENT_OPENAI_API_KEY" to "test",
          "AGENT_TRACE_LOGGING" to "true",
          "AGENT_TRACE_LOG_LEVEL" to "",
        ),
      )

    assertTrue(config.traceLoggingEnabled)
    assertEquals("INFO", config.traceLogLevel)
  }

  @Test
  fun `knowledge base metadata defaults to neutral values`() {
    val config = AutoResearchConfig.fromEnvironment(emptyMap<String, String>())

    assertEquals("Graf knowledge base", config.knowledgeBaseName)
    assertEquals("pilot", config.knowledgeBaseStage)
    assertEquals(
      "Focus on the highest-impact relationships in the knowledge base, explain why each matters, and share any follow-up artifacts ops should capture.",
      config.operatorGuidance,
    )
    assertEquals("auto-research", config.defaultStreamId)
  }

  @Test
  fun `knowledge base metadata env overrides applied`() {
    val config =
      AutoResearchConfig.fromEnvironment(
        mapOf(
          "AGENT_KNOWLEDGE_BASE_NAME" to "Summit research base",
          "AGENT_KNOWLEDGE_BASE_STAGE" to "production",
          "AGENT_OPERATOR_GUIDANCE" to "Prioritize compliance relationships.",
          "AGENT_DEFAULT_STREAM_ID" to "summit-stream",
        ),
      )

    assertEquals("Summit research base", config.knowledgeBaseName)
    assertEquals("production", config.knowledgeBaseStage)
    assertEquals("Prioritize compliance relationships.", config.operatorGuidance)
    assertEquals("summit-stream", config.defaultStreamId)
  }
}

