package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import mu.KotlinLogging
import java.time.Instant

private val infoLogger = KotlinLogging.logger {}

@Serializable
private data class InfoRequest(
  val type: String,
  val dex: String? = null,
)

class HyperliquidInfoClient(
  private val config: HyperliquidConfig,
  private val httpClient: HttpClient,
  private val budget: MinuteWeightBudget,
  private val json: Json,
) {
  suspend fun loadMarkets(): List<HyperliquidMarket> {
    val markets = mutableListOf<HyperliquidMarket>()
    if (config.includePerps) {
      markets += loadPerpMarkets()
    }
    if (config.includeSpot) {
      markets += loadSpotMarkets()
    }
    return applyCoverage(markets).sortedWith(compareBy({ it.marketType.name }, { it.marketId }))
  }

  suspend fun loadFundingAndContextRecords(markets: List<HyperliquidMarket>): List<RoutedEnvelope> {
    val now = Instant.now().toString()
    val records = mutableListOf<RoutedEnvelope>()
    if (config.includePerps) {
      val metaAndCtx = postInfo("metaAndAssetCtxs", weight = 20)
      records +=
        HyperliquidEnvelope(
          ingestTs = now,
          eventTs = now,
          network = config.network,
          feed = "info",
          channel = "metaAndAssetCtxs",
          symbol = "perps",
          marketType = "perp",
          marketId = null,
          dex = null,
          coin = null,
          spotIndex = null,
          seq = 0,
          source = "rest",
          payload = metaAndCtx,
        ).route(config.topics.assetCtx, "perps")

      val predictedFundings = postInfo("predictedFundings", weight = 20)
      records +=
        HyperliquidEnvelope(
          ingestTs = now,
          eventTs = now,
          network = config.network,
          feed = "info",
          channel = "predictedFundings",
          symbol = "perps",
          marketType = "perp",
          marketId = null,
          dex = null,
          coin = null,
          spotIndex = null,
          seq = 0,
          source = "rest",
          payload = predictedFundings,
        ).route(config.topics.funding, "predictedFundings")
    }
    if (config.includeSpot) {
      val spotMetaAndCtx = postInfo("spotMetaAndAssetCtxs", weight = 20)
      records +=
        HyperliquidEnvelope(
          ingestTs = now,
          eventTs = now,
          network = config.network,
          feed = "info",
          channel = "spotMetaAndAssetCtxs",
          symbol = "spot",
          marketType = "spot",
          marketId = null,
          dex = null,
          coin = null,
          spotIndex = null,
          seq = 0,
          source = "rest",
          payload = spotMetaAndCtx,
        ).route(config.topics.assetCtx, "spot")
    }
    infoLogger.info { "loaded Hyperliquid context records=${records.size} markets=${markets.size}" }
    return records
  }

  private suspend fun loadPerpMarkets(): List<HyperliquidMarket> =
    loadPerpDexNames()
      .flatMap { dex ->
        val meta = postInfo("meta", weight = 20, dex = dex)
        val parsed = json.decodeFromJsonElement<PerpMeta>(meta)
        parsed.universe
          .filterNot { it.isDelisted == true }
          .map { asset ->
            HyperliquidMarket(
              marketId = HyperliquidMarketIds.perp(asset.name, dex = dex),
              marketType = HyperliquidMarketType.PERP,
              coin = asset.name,
              subscriptionCoin = asset.name,
              dex = dex,
              spotIndex = null,
              payload = json.encodeToJsonElement(PerpAsset.serializer(), asset),
            )
          }
      }

  private suspend fun loadPerpDexNames(): List<String?> {
    val response = postInfo("perpDexs", weight = 20)
    val dexes = response as? JsonArray ?: return listOf(null)
    return dexes
      .map { item ->
        when (item) {
          is JsonObject -> item["name"]?.jsonPrimitive?.contentOrNull
          else -> null
        }
      }.ifEmpty { listOf(null) }
  }

  private suspend fun loadSpotMarkets(): List<HyperliquidMarket> {
    val meta = postInfo("spotMeta", weight = 20)
    val parsed = json.decodeFromJsonElement<SpotMeta>(meta)
    return parsed.universe.map { pair ->
      HyperliquidMarket(
        marketId = HyperliquidMarketIds.spot(pair.index, pair.name),
        marketType = HyperliquidMarketType.SPOT,
        coin = pair.name,
        subscriptionCoin = HyperliquidMarketIds.spotSubscriptionCoin(pair),
        dex = null,
        spotIndex = pair.index,
        payload = json.encodeToJsonElement(SpotPair.serializer(), pair),
      )
    }
  }

  private fun applyCoverage(markets: List<HyperliquidMarket>): List<HyperliquidMarket> =
    when (config.marketCoverage) {
      "all" -> markets
      "canary", "top-liquidity-canary" ->
        markets.filter { market ->
          market.coin.uppercase() in config.canaryCoins ||
            market.coin.substringBefore('/').uppercase() in config.canaryCoins
        }
      else -> error("HYPERLIQUID_MARKET_COVERAGE must be all, canary, or top-liquidity-canary")
    }

  private suspend fun postInfo(
    type: String,
    weight: Int,
    dex: String? = null,
  ): JsonElement {
    budget.acquire(weight)
    return httpClient
      .post(config.infoUrl) {
        contentType(ContentType.Application.Json)
        setBody(json.encodeToString(InfoRequest.serializer(), InfoRequest(type = type, dex = dex)))
      }.body()
  }
}

private fun HyperliquidEnvelope.route(
  topic: String,
  key: String,
): RoutedEnvelope = RoutedEnvelope(topic = topic, key = key, envelope = this)
