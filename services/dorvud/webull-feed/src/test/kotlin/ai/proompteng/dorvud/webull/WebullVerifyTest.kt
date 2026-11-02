package ai.proompteng.dorvud.webull

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WebullVerifyTest {
  @Test
  fun `market acceptance requires recent parsed provider times for every required channel`() {
    val fresh = mapOf("mqtt.quotes" to listOf(1_000L), "mqtt.trades" to listOf(2_000L), "bars" to listOf(120_000L))
    assertTrue(hasFreshWebullMarketData(fresh))
    assertFalse(hasFreshWebullMarketData(fresh - "mqtt.trades"))
    assertFalse(hasFreshWebullMarketData(fresh + ("mqtt.trades" to emptyList())))
    assertFalse(hasFreshWebullMarketData(fresh + ("mqtt.quotes" to listOf(120_001L))))
    assertFalse(hasFreshWebullMarketData(fresh + ("bars" to listOf(360_001L))))
    assertFalse(hasFreshWebullMarketData(fresh + ("mqtt.trades" to listOf(-5_001L))))
  }
}
