package ai.proompteng.dorvud.hyperliquid

import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SubscriptionPlannerTest {
  @Test
  fun `plans only public subscriptions`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_ENABLED" to "false",
          "HYPERLIQUID_WS_CHANNELS" to "allMids,trades,l2Book,bbo,candle,activeAssetCtx,allDexsAssetCtxs",
          "HYPERLIQUID_CANDLE_INTERVALS" to "1m",
        ),
      )
    val shards = SubscriptionPlanner.plan(listOf(perp("BTC"), spot("PURR/USDC", 0)), config)
    val types = shards.flatMap { it.subscriptions }.map { it.type }.toSet()

    assertEquals(setOf("allMids", "trades", "l2Book", "bbo", "candle", "activeAssetCtx", "allDexsAssetCtxs"), types)
    assertTrue(shards.flatMap { it.subscriptions }.none { it.type.startsWith("user") })
  }

  @Test
  fun `rejects plans over total subscription budget`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_ENABLED" to "false",
          "HYPERLIQUID_MAX_TOTAL_SUBSCRIPTIONS" to "4",
          "HYPERLIQUID_WS_CHANNELS" to "trades,l2Book,bbo,candle",
        ),
      )

    assertFailsWith<IllegalStateException> {
      SubscriptionPlanner.plan(listOf(perp("BTC"), perp("ETH")), config)
    }
  }

  @Test
  fun `top one hundred markets with five candle intervals stays within subscription cap`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_ENABLED" to "false",
          "HYPERLIQUID_CANDLE_INTERVALS" to "1m,3m,5m,15m,1h",
          "HYPERLIQUID_MAX_TOTAL_SUBSCRIPTIONS" to "1000",
        ),
      )
    val markets = (1..100).map { index -> perp("TEST$index") }

    val subscriptionCount = SubscriptionPlanner.plan(markets, config).sumOf { it.subscriptions.size }

    assertEquals(902, subscriptionCount)
  }

  private fun perp(coin: String): HyperliquidMarket =
    HyperliquidMarket(
      marketId = HyperliquidMarketIds.perp(coin, null),
      marketType = HyperliquidMarketType.PERP,
      coin = coin,
      subscriptionCoin = coin,
      dex = null,
      spotIndex = null,
      payload = JsonPrimitive(coin),
    )

  private fun spot(
    coin: String,
    index: Int,
  ): HyperliquidMarket =
    HyperliquidMarket(
      marketId = HyperliquidMarketIds.spot(index, coin),
      marketType = HyperliquidMarketType.SPOT,
      coin = coin,
      subscriptionCoin = if (coin == "PURR/USDC") coin else "@$index",
      dex = null,
      spotIndex = index,
      payload = JsonPrimitive(coin),
    )
}
