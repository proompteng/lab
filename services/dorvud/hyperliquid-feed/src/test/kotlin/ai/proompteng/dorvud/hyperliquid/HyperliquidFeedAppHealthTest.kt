package ai.proompteng.dorvud.hyperliquid

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HyperliquidFeedAppHealthTest {
  @Test
  fun `liveness stays alive while dependency freshness keeps readiness false`() {
    var nowMs = 0L
    val app =
      HyperliquidFeedApp(
        config =
          HyperliquidConfig.fromEnv(
            mapOf(
              "KAFKA_SASL_PASSWORD" to "secret",
              "CLICKHOUSE_PASSWORD" to "secret",
              "CLICKHOUSE_ENABLED" to "true",
            ),
          ),
        nowMs = { nowMs },
      )

    assertFalse(app.readinessInfo().ready)
    assertFalse(app.readinessInfo().clickhouse)

    nowMs = 600_000
    assertTrue(app.isAlive())

    app.stop()
    assertFalse(app.isAlive())
  }
}
