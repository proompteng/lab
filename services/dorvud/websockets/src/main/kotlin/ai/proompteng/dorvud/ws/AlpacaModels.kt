package ai.proompteng.dorvud.ws

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Alpaca market data frames (v2 streaming). */
@Serializable
sealed interface AlpacaMessage {
  val type: String
}

@Serializable
@SerialName("error")
data class AlpacaError(
  @SerialName("T") override val type: String = "error",
  val code: Int? = null,
  val msg: String? = null,
) : AlpacaMessage

data class AlpacaUnknownMessage(
  override val type: String,
  val raw: JsonElement,
) : AlpacaMessage

@Serializable
@SerialName("success")
data class AlpacaSuccess(
  @SerialName("T") override val type: String = "success",
  val msg: String,
) : AlpacaMessage

@Serializable
@SerialName("subscription")
data class AlpacaSubscription(
  @SerialName("T") override val type: String = "subscription",
  val trades: List<String> = emptyList(),
  val quotes: List<String> = emptyList(),
  @SerialName("bars") val bars1m: List<String> = emptyList(),
  @SerialName("updatedBars") val updatedBars: List<String> = emptyList(),
  val dailyBars: List<String> = emptyList(),
  val statuses: List<String> = emptyList(),
) : AlpacaMessage

@Serializable
@SerialName("t")
data class AlpacaTrade(
  @SerialName("T") override val type: String = "t",
  @SerialName("S") val symbol: String,
  @SerialName("i") val id: Long,
  @SerialName("x") val exchange: String? = null,
  @SerialName("p") val price: Double,
  @SerialName("s") val size: Long,
  @SerialName("c") val conditions: List<String>? = null,
  @SerialName("t") val timestamp: String,
  @SerialName("z") val tape: String? = null,
) : AlpacaMessage

@Serializable
@SerialName("q")
data class AlpacaQuote(
  @SerialName("T") override val type: String = "q",
  @SerialName("S") val symbol: String,
  @SerialName("bx") val bidExchange: String? = null,
  @SerialName("bp") val bidPrice: Double,
  @SerialName("bs") val bidSize: Double,
  @SerialName("ax") val askExchange: String? = null,
  @SerialName("ap") val askPrice: Double,
  @SerialName("as") val askSize: Double,
  @SerialName("c") val conditions: List<String>? = null,
  @SerialName("t") val timestamp: String,
  @SerialName("z") val tape: String? = null,
) : AlpacaMessage

@Serializable
@SerialName("b")
data class AlpacaBar(
  @SerialName("T") override val type: String = "b",
  @SerialName("S") val symbol: String,
  @SerialName("o") val open: Double,
  @SerialName("h") val high: Double,
  @SerialName("l") val low: Double,
  @SerialName("c") val close: Double,
  @SerialName("v") val volume: Long,
  @SerialName("vw") val vwap: Double? = null,
  @SerialName("n") val tradeCount: Long? = null,
  @SerialName("t") val timestamp: String,
) : AlpacaMessage

@Serializable
@SerialName("u")
data class AlpacaUpdatedBar(
  @SerialName("T") override val type: String = "u",
  @SerialName("S") val symbol: String,
  @SerialName("o") val open: Double,
  @SerialName("h") val high: Double,
  @SerialName("l") val low: Double,
  @SerialName("c") val close: Double,
  @SerialName("v") val volume: Long,
  @SerialName("vw") val vwap: Double? = null,
  @SerialName("n") val tradeCount: Long? = null,
  @SerialName("t") val timestamp: String,
) : AlpacaMessage

@Serializable
@SerialName("s")
data class AlpacaStatus(
  @SerialName("T") override val type: String = "s",
  @SerialName("S") val symbol: String,
  val statusCode: String? = null,
  val statusMessage: String? = null,
  @SerialName("t") val timestamp: String,
) : AlpacaMessage
