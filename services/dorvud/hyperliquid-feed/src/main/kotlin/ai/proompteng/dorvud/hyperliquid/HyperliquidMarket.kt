package ai.proompteng.dorvud.hyperliquid

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

enum class HyperliquidMarketType(
  val wireValue: String,
) {
  PERP("perp"),
  SPOT("spot"),
}

@Serializable
data class PerpAsset(
  val name: String,
  val szDecimals: Int? = null,
  val maxLeverage: Int? = null,
  val onlyIsolated: Boolean? = null,
  val isDelisted: Boolean? = null,
)

@Serializable
data class PerpMeta(
  val universe: List<PerpAsset> = emptyList(),
)

@Serializable
data class SpotToken(
  val name: String,
  val index: Int,
  val szDecimals: Int? = null,
  val weiDecimals: Int? = null,
  val tokenId: String? = null,
  val isCanonical: Boolean? = null,
)

@Serializable
data class SpotPair(
  val name: String,
  val tokens: List<Int> = emptyList(),
  val index: Int,
  val isCanonical: Boolean? = null,
)

@Serializable
data class SpotMeta(
  val tokens: List<SpotToken> = emptyList(),
  val universe: List<SpotPair> = emptyList(),
)

data class HyperliquidMarket(
  val marketId: String,
  val marketType: HyperliquidMarketType,
  val coin: String,
  val subscriptionCoin: String,
  val dex: String?,
  val spotIndex: Int?,
  val payload: JsonElement,
)

object HyperliquidMarketIds {
  fun perp(
    coin: String,
    dex: String?,
  ): String = "hl:perp:${dex.orDefaultDex()}:$coin"

  fun spot(
    index: Int,
    name: String,
  ): String = "hl:spot:$index:$name"

  fun String?.orDefaultDex(): String = this?.takeIf { it.isNotBlank() } ?: "default"

  fun spotSubscriptionCoin(pair: SpotPair): String =
    if (pair.name == "PURR/USDC") {
      "PURR/USDC"
    } else {
      "@${pair.index}"
    }
}

@Serializable
data class HyperliquidEnvelope(
  @SerialName("ingest_ts")
  val ingestTs: String,
  @SerialName("event_ts")
  val eventTs: String,
  val provider: String = "hyperliquid",
  val network: String,
  val feed: String,
  val channel: String,
  val symbol: String,
  @SerialName("market_type")
  val marketType: String?,
  @SerialName("market_id")
  val marketId: String?,
  val dex: String?,
  val coin: String?,
  @SerialName("spot_index")
  val spotIndex: Int?,
  val seq: Long,
  @SerialName("is_final")
  val isFinal: Boolean = true,
  val source: String,
  val payload: JsonElement,
  val version: Int = 1,
)

data class RoutedEnvelope(
  val topic: String,
  val key: String,
  val envelope: HyperliquidEnvelope,
)
