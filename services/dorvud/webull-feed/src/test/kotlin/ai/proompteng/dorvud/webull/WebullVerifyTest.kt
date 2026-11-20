package ai.proompteng.dorvud.webull

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WebullVerifyTest {
  @Test
  fun `market freshness ages against verification time when collection stops`() {
    val verifiedAt = Instant.parse("2026-11-01T12:00:00Z")
    val fresh =
      mapOf(
        "mqtt.quotes" to listOf(verifiedAt.minusSeconds(1)),
        "mqtt.trades" to listOf(verifiedAt.minusSeconds(2)),
        "bars" to listOf(verifiedAt.minusSeconds(120)),
      )
    assertTrue(hasFreshWebullMarketData(fresh, verifiedAt))
    assertFalse(hasFreshWebullMarketData(fresh, verifiedAt.plusSeconds(600)))
    assertFalse(hasFreshWebullMarketData(fresh - "mqtt.trades", verifiedAt))
    assertFalse(hasFreshWebullMarketData(fresh + ("mqtt.trades" to emptyList()), verifiedAt))
    assertFalse(hasFreshWebullMarketData(fresh + ("mqtt.quotes" to listOf(verifiedAt.minusMillis(120_001))), verifiedAt))
    assertFalse(hasFreshWebullMarketData(fresh + ("bars" to listOf(verifiedAt.minusMillis(360_001))), verifiedAt))
    assertFalse(hasFreshWebullMarketData(fresh + ("mqtt.trades" to listOf(verifiedAt.plusMillis(5_001))), verifiedAt))
  }
}
