package ai.proompteng.dorvud.hyperliquid

import kotlin.test.Test
import kotlin.test.assertEquals
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

  @Test
  fun `optional clickhouse mirror does not block readiness when feed path is healthy`() {
    assertTrue(
      hyperliquidReadinessReady(
        wsReady = true,
        kafkaReady = true,
        clickHouseFresh = false,
        clickHouseRequiredForReadiness = false,
        marketDataFresh = true,
        catalogReady = true,
      ),
    )
  }

  @Test
  fun `required clickhouse mirror blocks readiness when stale`() {
    assertFalse(
      hyperliquidReadinessReady(
        wsReady = true,
        kafkaReady = true,
        clickHouseFresh = false,
        clickHouseRequiredForReadiness = true,
        marketDataFresh = true,
        catalogReady = true,
      ),
    )
  }

  @Test
  fun `transient kafka failure does not block readiness while producer ack is fresh`() {
    var nowMs = 1_000L
    val tracker = KafkaReadinessTracker(maxSuccessAgeMs = 120_000, nowMs = { nowMs })

    assertFalse(tracker.isReady())

    tracker.recordSuccess()
    assertTrue(tracker.isReady())

    nowMs += 30_000
    tracker.recordFailure(RuntimeException("NOT_LEADER_OR_FOLLOWER"))
    assertTrue(tracker.isReady())
    assertEquals("RuntimeException", tracker.snapshot().lastFailureReason)

    nowMs += 91_000
    assertFalse(tracker.isReady())
  }

  @Test
  fun `readiness blockers identify failed dependencies`() {
    assertEquals(
      listOf("websocket_not_connected", "kafka_no_recent_success", "clickhouse_not_fresh", "market_data_stale"),
      hyperliquidReadinessBlockers(
        wsReady = false,
        kafkaReady = false,
        clickHouseFresh = false,
        clickHouseRequiredForReadiness = true,
        marketDataFresh = false,
        catalogReady = true,
      ),
    )

    assertEquals(
      emptyList(),
      hyperliquidReadinessBlockers(
        wsReady = true,
        kafkaReady = true,
        clickHouseFresh = false,
        clickHouseRequiredForReadiness = false,
        marketDataFresh = true,
        catalogReady = true,
      ),
    )
  }
}
