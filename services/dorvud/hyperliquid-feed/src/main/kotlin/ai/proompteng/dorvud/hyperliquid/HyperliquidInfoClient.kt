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
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import mu.KotlinLogging
import java.time.Instant

private val infoLogger = KotlinLogging.logger {}

@Serializable
private data class InfoRequest(
  val type: String,
  val dex: String? = null,
)

private data class MarketVolumeScore(
  val marketId: String,
  val dayNotionalVolume: Double,
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
    val selected = applyCoverage(markets)
    return if (config.marketCoverage in setOf("top-volume", "top-volume-100")) {
      selected
    } else {
      selected.sortedWith(compareBy({ it.marketType.name }, { it.marketId }))
    }
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

  private suspend fun applyCoverage(markets: List<HyperliquidMarket>): List<HyperliquidMarket> =
    when (config.marketCoverage) {
      "all" -> markets
      "canary", "top-liquidity-canary" ->
        markets.filter { market ->
          market.coin.uppercase() in config.canaryCoins ||
            market.coin.substringBefore('/').uppercase() in config.canaryCoins
        }
      "top-volume", "top-volume-100" -> selectTopVolumeMarkets(markets)
      else -> error("HYPERLIQUID_MARKET_COVERAGE must be all, canary, top-liquidity-canary, top-volume, or top-volume-100")
    }

  private suspend fun selectTopVolumeMarkets(markets: List<HyperliquidMarket>): List<HyperliquidMarket> {
    val scores =
      buildList {
        if (config.includePerps) addAll(loadPerpMarketVolumeScores())
        if (config.includeSpot) addAll(loadSpotMarketVolumeScores())
      }.associateBy({ it.marketId }, { it.dayNotionalVolume })

    val topVolume =
      markets
        .sortedWith(
          compareByDescending<HyperliquidMarket> { scores[it.marketId] ?: 0.0 }
            .thenBy { it.marketType.name }
            .thenBy { it.marketId },
        ).take(config.topMarketCount)
    val pinned =
      markets
        .filter { market ->
          market.marketType == HyperliquidMarketType.PERP &&
            market.coin.uppercase() in config.pinnedPerpCoins
        }.sortedBy { it.marketId }
    val selected = (topVolume + pinned).distinctBy { it.marketId }

    val minSelectedVolume = topVolume.minOfOrNull { scores[it.marketId] ?: 0.0 } ?: 0.0
    infoLogger.info {
      "selected Hyperliquid top-volume markets count=${selected.size} configured=${config.topMarketCount} " +
        "pinned=${pinned.size} catalog=${markets.size} scored=${scores.size} min_day_notional_volume=$minSelectedVolume"
    }
    return selected
  }

  private suspend fun loadPerpMarketVolumeScores(): List<MarketVolumeScore> =
    loadPerpDexNames().flatMap { dex ->
      val context = postInfo("metaAndAssetCtxs", weight = 20, dex = dex)
      val (universe, contexts) = contextPair(context) ?: return@flatMap emptyList()
      universe.mapIndexedNotNull { index, marketElement ->
        val market = marketElement as? JsonObject ?: return@mapIndexedNotNull null
        val name = market["name"]?.jsonPrimitive?.contentOrNull ?: return@mapIndexedNotNull null
        val volume = dayNotionalVolume(contexts.getOrNull(index) as? JsonObject)
        MarketVolumeScore(
          marketId = HyperliquidMarketIds.perp(name, dex),
          dayNotionalVolume = volume,
        )
      }
    }

  private suspend fun loadSpotMarketVolumeScores(): List<MarketVolumeScore> {
    val context = postInfo("spotMetaAndAssetCtxs", weight = 20)
    val (universe, contexts) = contextPair(context) ?: return emptyList()
    return universe.mapIndexedNotNull { index, marketElement ->
      val market = marketElement as? JsonObject ?: return@mapIndexedNotNull null
      val name = market["name"]?.jsonPrimitive?.contentOrNull ?: return@mapIndexedNotNull null
      val spotIndex = market["index"]?.jsonPrimitive?.intOrNull ?: return@mapIndexedNotNull null
      val volume = dayNotionalVolume(contexts.getOrNull(index) as? JsonObject)
      MarketVolumeScore(
        marketId = HyperliquidMarketIds.spot(spotIndex, name),
        dayNotionalVolume = volume,
      )
    }
  }

  private fun contextPair(context: JsonElement): Pair<JsonArray, JsonArray>? {
    val response = context as? JsonArray ?: return null
    val meta = response.getOrNull(0) as? JsonObject ?: return null
    val contexts = response.getOrNull(1) as? JsonArray ?: return null
    val universe = meta["universe"] as? JsonArray ?: return null
    return universe to contexts
  }

  private fun dayNotionalVolume(context: JsonObject?): Double =
    context
      ?.get("dayNtlVlm")
      ?.jsonPrimitive
      ?.contentOrNull
      ?.toDoubleOrNull()
      ?: 0.0

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
