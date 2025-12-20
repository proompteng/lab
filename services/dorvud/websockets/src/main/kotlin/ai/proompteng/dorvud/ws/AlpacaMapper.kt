package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.InstantIsoSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import java.time.Instant

/** Maps raw Alpaca JSON message into our envelope + channel name. */
object AlpacaMapper {
  private val json = Json { ignoreUnknownKeys = true }

  fun decode(raw: String): AlpacaMessage = json.decodeFromString(AlpacaMessageSerializer, raw)

  fun toEnvelope(
    message: AlpacaMessage,
    seqProvider: (String) -> Long,
  ): Envelope<JsonElement>? =
    when (message) {
      is AlpacaTrade ->
        envelope(
          message.symbol,
          channel = "trades",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = json.encodeToJsonElement(AlpacaTrade.serializer(), message),
          isFinal = true,
        )
      is AlpacaQuote ->
        envelope(
          message.symbol,
          channel = "quotes",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = json.encodeToJsonElement(AlpacaQuote.serializer(), message),
          isFinal = true,
        )
      is AlpacaBar ->
        envelope(
          message.symbol,
          channel = "bars",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = json.encodeToJsonElement(AlpacaBar.serializer(), message),
          isFinal = true,
        )
      is AlpacaUpdatedBar ->
        envelope(
          message.symbol,
          channel = "updatedBars",
          eventTs = message.timestamp,
          seq = seqProvider(message.symbol),
          payload = json.encodeToJsonElement(AlpacaUpdatedBar.serializer(), message),
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
          isFinal = true,
        )
      else -> null
    }

  private fun envelope(
    symbol: String,
    channel: String,
    eventTs: String,
    seq: Long,
    payload: JsonElement,
    isFinal: Boolean,
    source: String = "ws",
  ): Envelope<JsonElement> =
    Envelope(
      ingestTs = Instant.now(),
      eventTs = Instant.parse(eventTs),
      feed = "alpaca",
      channel = channel,
      symbol = symbol,
      seq = seq,
      payload = payload,
      isFinal = isFinal,
      source = source,
    )
}
