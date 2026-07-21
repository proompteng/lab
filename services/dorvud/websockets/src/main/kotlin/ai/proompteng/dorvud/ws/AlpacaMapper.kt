package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset

/** Maps raw Alpaca JSON message into our envelope + channel name. */
object AlpacaMapper {
  private val json = Json { ignoreUnknownKeys = true }
  private val occSymbolRegex = Regex("^([A-Z]{1,6})\\d{6}[CP]\\d{8}$")

  fun decode(raw: String): AlpacaMessage = json.decodeFromString(AlpacaMessageSerializer, raw)

  fun toEnvelope(
    message: AlpacaMessage,
    marketType: AlpacaMarketType,
    feed: String,
    equityFeed: EquityFeed? = null,
    seqProvider: (String) -> Long,
  ): Envelope<JsonElement>? =
    when (message) {
      is AlpacaTrade ->
        envelope(
          message.symbol,
          channel = if (marketType == AlpacaMarketType.OPTIONS) "trade" else "trades",
          eventTs = message.timestamp,
          seq = seqProvider("trades:${message.symbol}"),
          payload = tradePayload(message, marketType),
          feed = feed,
          equityFeed = equityFeed,
          isFinal = true,
        )
      is AlpacaQuote ->
        envelope(
          message.symbol,
          channel = if (marketType == AlpacaMarketType.OPTIONS) "quote" else "quotes",
          eventTs = message.timestamp,
          seq = seqProvider("quotes:${message.symbol}"),
          payload = quotePayload(message, marketType),
          feed = feed,
          equityFeed = equityFeed,
          isFinal = true,
        )
      is AlpacaBar ->
        envelope(
          message.symbol,
          channel = "bars",
          eventTs = message.timestamp,
          seq = seqProvider("bars:${message.symbol}"),
          payload = json.encodeToJsonElement(AlpacaBar.serializer(), message),
          feed = feed,
          equityFeed = equityFeed,
          isFinal = true,
        )
      is AlpacaUpdatedBar ->
        envelope(
          message.symbol,
          channel = "updatedBars",
          eventTs = message.timestamp,
          seq = seqProvider("updatedBars:${message.symbol}"),
          payload = json.encodeToJsonElement(AlpacaUpdatedBar.serializer(), message),
          feed = feed,
          equityFeed = equityFeed,
          isFinal = false,
          source = "ws",
        )
      is AlpacaStatus ->
        envelope(
          message.symbol,
          channel = "status",
          eventTs = message.timestamp,
          seq = seqProvider("status:${message.symbol}"),
          payload = json.encodeToJsonElement(AlpacaStatus.serializer(), message),
          feed = feed,
          equityFeed = equityFeed,
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
        message.id?.let { put("trade_id", it.toString()) }
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

  internal fun occUnderlyingSymbol(symbol: String): String = occSymbolRegex.matchEntire(symbol)?.groupValues?.get(1) ?: symbol

  private fun envelope(
    symbol: String,
    channel: String,
    eventTs: String,
    seq: Long,
    payload: JsonElement,
    feed: String,
    equityFeed: EquityFeed?,
    isFinal: Boolean,
    source: String = "ws",
  ): Envelope<JsonElement>? {
    val parsedEventTs = parseAlpacaEventInstant(eventTs) ?: return null
    val delayClass =
      equityFeed
        ?.takeIf { canonicalMarketDataChannel(channel) != null }
        ?.let { marketDataDelayClass(it, channel).id }
    return Envelope(
      ingestTs = Instant.now(),
      eventTs = parsedEventTs,
      feed = feed,
      channel = channel,
      symbol = symbol,
      seq = seq,
      payload = payload,
      provider = "alpaca",
      marketSession = equityFeed?.let { classifyMarketSession(parsedEventTs).id },
      delayClass = delayClass,
      isFinal = isFinal,
      source = source,
      version = 2,
    )
  }
}

internal fun parseAlpacaEventInstant(eventTs: String): Instant? {
  val normalized = normalizeTimestampText(eventTs) ?: return null
  return runCatching { Instant.parse(normalized) }.getOrNull()
    ?: runCatching { OffsetDateTime.parse(normalized).toInstant() }.getOrNull()
    ?: runCatching { LocalDateTime.parse(normalized).toInstant(ZoneOffset.UTC) }.getOrNull()
    ?: parseEpochTimestamp(normalized)
}

private fun parseEpochTimestamp(value: String): Instant? {
  if ('.' in value) return parseDecimalEpochSeconds(value)
  val timestamp = value.toLongOrNull()?.takeIf { it >= 0 } ?: return null
  return runCatching {
    when (value.length) {
      in 1..10 -> Instant.ofEpochSecond(timestamp)
      in 11..13 -> Instant.ofEpochMilli(timestamp)
      in 14..16 -> Instant.ofEpochSecond(timestamp / 1_000_000, (timestamp % 1_000_000) * 1_000)
      else -> Instant.ofEpochSecond(timestamp / 1_000_000_000, timestamp % 1_000_000_000)
    }
  }.getOrNull()
}

private fun parseDecimalEpochSeconds(value: String): Instant? {
  val timestamp = runCatching { BigDecimal(value) }.getOrNull()?.takeIf { it.signum() >= 0 } ?: return null
  val seconds = timestamp.setScale(0, RoundingMode.DOWN)
  val nanos =
    timestamp
      .subtract(seconds)
      .movePointRight(9)
      .setScale(0, RoundingMode.DOWN)
      .toLong()
  return runCatching { Instant.ofEpochSecond(seconds.toLong(), nanos) }.getOrNull()
}

private fun normalizeTimestampText(raw: String): String? {
  val trimmed =
    raw
      .trim()
      .removeSurrounding("\"")
      .takeIf { it.isNotEmpty() }
      ?: return null
  val withSeparator =
    if (trimmed.length > 10 && trimmed[10] == ' ') {
      trimmed.replaceRange(10, 11, "T")
    } else {
      trimmed
    }
  return withSeparator.replace(Regex("([+-]\\d{2})(\\d{2})$"), "$1:$2")
}
