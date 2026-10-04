package ai.proompteng.dorvud.hyperliquid

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class PlannedSubscription(
  val type: String,
  val market: HyperliquidMarket?,
  val interval: String? = null,
  val dex: String? = null,
) {
  fun toJson(): JsonObject =
    buildJsonObject {
      put("type", type)
      market?.let { put("coin", it.subscriptionCoin) }
      interval?.let { put("interval", it) }
      dex?.let { put("dex", it) }
    }

  val key: String =
    listOfNotNull(type, dex, market?.marketId, interval).joinToString(":")
}

data class SubscriptionShard(
  val index: Int,
  val subscriptions: List<PlannedSubscription>,
)

object SubscriptionPlanner {
  fun plan(
    markets: List<HyperliquidMarket>,
    config: HyperliquidConfig,
  ): List<SubscriptionShard> {
    val subscriptions = mutableListOf<PlannedSubscription>()
    val dexes =
      markets
        .filter { it.marketType == HyperliquidMarketType.PERP }
        .mapNotNull { it.dex }
        .distinct()

    if ("allMids" in config.wsChannels) {
      subscriptions += PlannedSubscription("allMids", market = null)
      dexes.forEach { subscriptions += PlannedSubscription("allMids", market = null, dex = it) }
    }
    if ("allDexsAssetCtxs" in config.wsChannels) {
      subscriptions += PlannedSubscription("allDexsAssetCtxs", market = null)
    }

    markets.forEach { market ->
      if ("trades" in config.wsChannels) subscriptions += PlannedSubscription("trades", market)
      if ("l2Book" in config.wsChannels) subscriptions += PlannedSubscription("l2Book", market)
      if ("bbo" in config.wsChannels) subscriptions += PlannedSubscription("bbo", market)
      if ("activeAssetCtx" in config.wsChannels) subscriptions += PlannedSubscription("activeAssetCtx", market)
      if ("candle" in config.wsChannels) {
        config.candleIntervals.forEach { interval ->
          subscriptions += PlannedSubscription("candle", market, interval = interval)
        }
      }
    }

    val deduped = subscriptions.distinctBy { it.key }
    if (deduped.size > config.maxTotalSubscriptions) {
      error(
        "Hyperliquid subscription plan has ${deduped.size} subscriptions, exceeding " +
          "HYPERLIQUID_MAX_TOTAL_SUBSCRIPTIONS=${config.maxTotalSubscriptions}",
      )
    }

    return deduped
      .chunked(config.maxSubscriptionsPerConnection)
      .also { shards ->
        if (shards.size > config.maxWsConnections) {
          error(
            "Hyperliquid subscription plan needs ${shards.size} websocket connections, exceeding " +
              "HYPERLIQUID_MAX_WS_CONNECTIONS=${config.maxWsConnections}",
          )
        }
      }.mapIndexed { index, subscriptionsForShard ->
        SubscriptionShard(index = index, subscriptions = subscriptionsForShard)
      }
  }
}
