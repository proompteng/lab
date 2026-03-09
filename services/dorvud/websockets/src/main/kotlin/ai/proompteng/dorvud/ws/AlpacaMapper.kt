package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import java.time.Instant

/** Maps raw Alpaca JSON message into our envelope + channel name. */
object AlpacaMapper {
  private val json = Json { ignoreUnknownKeys = true }
  private val occSymbolRegex = Regex("^([A-Z]{1,6})\\d{6}[CP]\\d{8}$")

  fun decode(raw: String): AlpacaMessage = json.decodeFromString(AlpacaMessageSerializer, raw)

  fun toEnvelope(
    message: AlpacaMessage,
    marketType: AlpacaMarketType,
    feed: String,
    seqProvider: (String) -> Long,
  ): Envelope<JsonElement>? =
    when (message) {
      is AlpacaTrade ->
        envelope(
          message.symbol,
          channel = if (marketType == AlpacaMarketType.OPTIONS) "trade" else "trades",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = tradePayload(message, marketType),
          feed = feed,
          isFinal = true,
        )
      is AlpacaQuote ->
        envelope(
          message.symbol,
          channel = if (marketType == AlpacaMarketType.OPTIONS) "quote" else "quotes",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = quotePayload(message, marketType),
          feed = feed,
          isFinal = true,
        )
      is AlpacaBar ->
        envelope(
          message.symbol,
          channel = "bars",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = json.encodeToJsonElement(AlpacaBar.serializer(), message),
          feed = feed,
          isFinal = true,
        )
      is AlpacaUpdatedBar ->
        envelope(
          message.symbol,
          channel = "updatedBars",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = json.encodeToJsonElement(AlpacaUpdatedBar.serializer(), message),
          feed = feed,
          isFinal = false,
          source = "ws",
        )
      is AlpacaStatus ->
        envelope(
          message.symbol,
          channel = "status",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = json.encodeToJsonElement(AlpacaStatus.serializer(), message),
          feed = feed,
          isFinal = true,
        )
      else -> null
    }

  private fun tradePayload(
    message: AlpacaTrade,
    marketType: AlpacaMarketType,
  ): JsonElement =
    if (marketType == AlpacaMarketType.OPTIONS) {
      buildJsonObject {
        put("contract_symbol", message.symbol)
        put("underlying_symbol", occUnderlyingSymbol(message.symbol))
        put("price", message.price)
        put("size", message.size)
        put("exchange", message.exchange)
        put("trade_id", message.id.toString())
        putJsonArray("conditions") {
          message.conditions.orEmpty().forEach { add(JsonPrimitive(it)) }
        }
        put("tape", message.tape)
        put("participant_ts", message.timestamp)
        put("receipt_ts", Instant.now().toString())
        put("schema_version", 1)
      }
    } else {
      json.encodeToJsonElement(AlpacaTrade.serializer(), message)
    }

  private fun quotePayload(
    message: AlpacaQuote,
    marketType: AlpacaMarketType,
  ): JsonElement =
    if (marketType == AlpacaMarketType.OPTIONS) {
      buildJsonObject {
        put("contract_symbol", message.symbol)
        put("underlying_symbol", occUnderlyingSymbol(message.symbol))
        put("bid_price", message.bidPrice)
        put("bid_size", message.bidSize)
        put("ask_price", message.askPrice)
        put("ask_size", message.askSize)
        put("bid_exchange", message.bidExchange)
        put("ask_exchange", message.askExchange)
        put("quote_condition", message.conditions?.firstOrNull())
        put("participant_ts", message.timestamp)
        put("receipt_ts", Instant.now().toString())
        put("schema_version", 1)
      }
    } else {
      json.encodeToJsonElement(AlpacaQuote.serializer(), message)
    }

  internal fun occUnderlyingSymbol(symbol: String): String =
    occSymbolRegex.matchEntire(symbol)?.groupValues?.get(1) ?: symbol

  private fun envelope(
    symbol: String,
    channel: String,
    eventTs: String,
    seq: Long,
    payload: JsonElement,
    feed: String,
    isFinal: Boolean,
    source: String = "ws",
  ): Envelope<JsonElement> =
    Envelope(
      ingestTs = Instant.now(),
      eventTs = Instant.parse(eventTs),
      feed = feed,
      channel = channel,
      symbol = symbol,
      seq = seq,
      payload = payload,
      isFinal = isFinal,
      source = source,
    )
}
