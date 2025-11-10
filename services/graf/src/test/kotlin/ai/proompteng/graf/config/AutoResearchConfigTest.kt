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
}
