package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class ForwarderConfigTest {
  @Test
  fun `loads defaults when optional envs missing`() {
    val cfg = ForwarderConfig.fromEnv(
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
      ),
    )

    assertEquals(listOf("NVDA"), cfg.symbols)
    assertFalse(cfg.enableTradeUpdates)
    assertEquals("torghut.nvda.trades.v1", cfg.topics.trades)
  }
}
