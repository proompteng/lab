package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.CRYPTO_DELAY_CLASS
import ai.proompteng.dorvud.platform.CRYPTO_SESSION
import ai.proompteng.dorvud.platform.CryptoMarketDataEvent
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.decodeCryptoMarketData
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.DateTimeException
import java.time.Instant

data class AlpacaCryptoMessage(
  val event: CryptoMarketDataEvent,
) : AlpacaMessage {
  override val type: String get() = event.channel.wireType
}

internal fun decodeAlpacaCryptoMessage(payload: JsonObject): AlpacaCryptoMessage =
  try {
    AlpacaCryptoMessage(decodeCryptoMarketData(payload))
  } catch (cause: DateTimeException) {
    throw SerializationException("invalid Alpaca crypto event", cause)
  } catch (cause: IllegalArgumentException) {
    throw SerializationException("invalid Alpaca crypto event", cause)
  } catch (cause: IllegalStateException) {
    throw SerializationException("invalid Alpaca crypto event", cause)
  }

internal fun cryptoEnvelope(
  message: AlpacaCryptoMessage,
  location: String,
  ingestTs: Instant,
  sequence: Long,
): Envelope<JsonElement> =
  Envelope(
    ingestTs = ingestTs,
    eventTs = message.event.eventTs,
    feed = location,
    channel = message.event.channel.subscription,
    symbol = message.event.symbol,
    seq = sequence,
    payload = message.event.payload,
    provider = "alpaca",
    marketSession = CRYPTO_SESSION,
    delayClass = CRYPTO_DELAY_CLASS,
    version = 2,
  )
