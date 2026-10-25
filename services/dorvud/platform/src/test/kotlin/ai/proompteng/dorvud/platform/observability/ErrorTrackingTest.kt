package ai.proompteng.dorvud.platform.observability

import io.sentry.SentryEvent
import io.sentry.protocol.Message
import io.sentry.protocol.Request
import io.sentry.protocol.SentryException
import io.sentry.protocol.SentryStackFrame
import io.sentry.protocol.SentryStackTrace
import io.sentry.protocol.User
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ErrorTrackingTest {
  private val env =
    mapOf(
      "DORVUD_GLITCHTIP_DSN" to "http://${"a".repeat(32)}@glitchtip-web.glitchtip.svc.cluster.local:80/9",
      "DORVUD_ERROR_SERVICE" to "torghut-ws",
      "TORGHUT_WS_COMMIT" to "b".repeat(40),
    )

  @Test
  fun `optional local tracking and strict production ingestion identity`() {
    assertNull(ErrorTracking.options(emptyMap()))
    for (dsn in listOf(
      "https://${"a".repeat(32)}@external.example/9",
      "http://${"a".repeat(32)}:secret@glitchtip-web.glitchtip.svc.cluster.local:80/9",
      "http://${"a".repeat(32)}@glitchtip-web.glitchtip.svc.cluster.local:80/9?token=secret",
      "http://${"a".repeat(32)}@glitchtip-web.glitchtip.svc.cluster.local:8000/9",
      "http://${"a".repeat(32)}@glitchtip-web.glitchtip.svc.cluster.local:8001/9",
    )) {
      assertFailsWith<IllegalArgumentException> {
        ErrorTracking.options(env + ("DORVUD_GLITCHTIP_DSN" to dsn))
      }
    }
    assertFailsWith<IllegalArgumentException> {
      ErrorTracking.options(env + ("DORVUD_ERROR_SERVICE" to "unrecognized"))
    }
    val options = requireNotNull(ErrorTracking.options(env))
    assertEquals("b".repeat(40), options.release)
    assertEquals(false, options.dataCollection.userInfo)
    assertFalse(options.isEnableExternalConfiguration)
    assertFalse(options.isEnableAutoSessionTracking)
    assertFalse(options.logs.isEnabled)
    assertEquals(0.0, options.tracesSampleRate)
    assertEquals(0, options.maxBreadcrumbs)
    assertEquals(3000, options.flushTimeoutMillis)
  }

  @Test
  fun `malformed ingestion configuration never echoes credential input`() {
    val error =
      assertFailsWith<IllegalArgumentException> {
        ErrorTracking.options(env + ("DORVUD_GLITCHTIP_DSN" to "http://private:secret@bad host/9"))
      }
    assertEquals("Dorvud GlitchTip DSN must use the internal ingestion service", error.message)
    assertNull(error.cause)
  }

  @Test
  fun `event retains grouping frames without provider messages identities or source values`() {
    val frame =
      SentryStackFrame().apply {
        function = "publish"
        filename = "ForwarderApp.kt"
        lineno = 31
        vars = mapOf("key" to "secret")
        contextLine = "token=secret"
        preContext = listOf("private")
        postContext = listOf("private")
      }
    val exception =
      SentryException().apply {
        type = "IllegalStateException"
        value = "broker account private token=secret"
        stacktrace = SentryStackTrace(listOf(frame))
      }
    val event =
      SentryEvent().apply {
        message = Message().apply { formatted = "private account" }
        user = User().apply { id = "private" }
        request = Request().apply { url = "https://external.example/?token=secret" }
        setExtra("account", "private")
        contexts["private"] = "secret"
        setTag("private", "secret")
        exceptions = listOf(exception)
      }
    val scrubbed = ErrorTracking.sanitize(event, "torghut-ta")
    assertEquals("Dorvud application error", scrubbed.message?.formatted)
    assertNull(scrubbed.user)
    assertNull(scrubbed.request)
    assertTrue(scrubbed.extras.isNullOrEmpty())
    assertTrue(scrubbed.contexts.isEmpty())
    assertEquals(mapOf("service" to "torghut-ta", "namespace" to "torghut", "logger" to "unknown"), scrubbed.tags)
    assertEquals("Message withheld: potentially sensitive runtime data", scrubbed.exceptions?.single()?.value)
    assertEquals("publish", frame.function)
    assertEquals(31, frame.lineno)
    assertNull(frame.vars)
    assertNull(frame.contextLine)
    assertNull(frame.preContext)
    assertNull(frame.postContext)
  }

  @Test
  fun `log-only errors retain a safe component and separate grouping without runtime values`() {
    val logger = "org.apache.flink.runtime.rest.handler.job.checkpoints.CheckpointingStatisticsHandler"
    val event =
      SentryEvent().apply {
        this.logger = logger
        message = Message().apply { formatted = "Job private-identity not found token=secret" }
      }
    val scrubbed = ErrorTracking.sanitize(event, "torghut-ta")
    assertEquals(logger, scrubbed.tags?.get("logger"))
    assertEquals(listOf("{{ default }}", "torghut-ta", logger), scrubbed.fingerprints)
    assertEquals("Dorvud application error", scrubbed.message?.formatted)
    assertTrue(scrubbed.exceptions.isNullOrEmpty())
  }

  @Test
  fun `production named component loggers remain distinct`() {
    for (logger in listOf(
      "market-data-archive",
      "market-feature-archive",
      "technical-market-features",
      "rolling-market-features",
      "crypto-market-features",
      "crypto-market-feature-archive",
      "crypto-market-data-archive",
      "options-ta-clickhouse",
      "ta-clickhouse",
      "parse-envelope",
      "parse-bars1m",
      "microbars",
      "ta-signals",
      "torghut-ta",
    )) {
      val scrubbed = ErrorTracking.sanitize(SentryEvent().apply { this.logger = logger }, "torghut-ta")
      assertEquals(logger, scrubbed.tags?.get("logger"))
      assertEquals(listOf("{{ default }}", "torghut-ta", logger), scrubbed.fingerprints)
    }
  }

  @Test
  fun `untrusted logger names cannot transmit provider values`() {
    for (logger in listOf("private.token.secret", "org.apache.flink token=secret", "org.apache.${"x".repeat(300)}")) {
      val scrubbed = ErrorTracking.sanitize(SentryEvent().apply { this.logger = logger }, "torghut-ta")
      assertEquals("unknown", scrubbed.logger)
      assertEquals("unknown", scrubbed.tags?.get("logger"))
      assertEquals(listOf("{{ default }}", "torghut-ta", "unknown"), scrubbed.fingerprints)
    }
  }
}
