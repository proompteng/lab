package ai.proompteng.graf.autoresearch

import ai.koog.agents.core.feature.writer.FeatureMessageLogWriter
import ai.koog.agents.core.feature.writer.FeatureMessageLogWriter.LogLevel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AutoResearchAgentTraceLoggingTest {
  @Test
  fun `resolveTraceLogLevel handles valid values case insensitive`() {
    val level = AutoResearchAgentService.resolveTraceLogLevel(" debug ")

    assertEquals(LogLevel.DEBUG, level)
  }

  @Test
  fun `resolveTraceLogLevel warns and defaults on invalid`() {
    var warning: String? = null

    val level =
      AutoResearchAgentService.resolveTraceLogLevel("not-a-real-level") { message ->
        warning = message
      }

    assertEquals(LogLevel.INFO, level)
    assertEquals("Unknown trace log level 'not-a-real-level', defaulting to INFO", warning)
  }

  @Test
  fun `resolveTraceLogLevel allows explicit info`() {
    val level = AutoResearchAgentService.resolveTraceLogLevel(" info ")

    assertEquals(LogLevel.INFO, level)
  }
}
