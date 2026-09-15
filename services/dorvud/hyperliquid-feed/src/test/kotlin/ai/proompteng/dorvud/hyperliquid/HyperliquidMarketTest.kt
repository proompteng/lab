package ai.proompteng.dorvud.hyperliquid

import kotlin.test.Test
import kotlin.test.assertEquals

class HyperliquidMarketTest {
  @Test
  fun `builds canonical perp and spot market ids`() {
    assertEquals("hl:perp:default:BTC", HyperliquidMarketIds.perp("BTC", dex = null))
    assertEquals("hl:perp:perp2:ETH", HyperliquidMarketIds.perp("ETH", dex = "perp2"))
    assertEquals("hl:spot:7:PURR/USDC", HyperliquidMarketIds.spot(7, "PURR/USDC"))
  }

  @Test
  fun `uses documented spot subscription symbol rules`() {
    assertEquals("PURR/USDC", HyperliquidMarketIds.spotSubscriptionCoin(SpotPair("PURR/USDC", index = 0)))
    assertEquals("@42", HyperliquidMarketIds.spotSubscriptionCoin(SpotPair("HFUN/USDC", index = 42)))
  }
}
