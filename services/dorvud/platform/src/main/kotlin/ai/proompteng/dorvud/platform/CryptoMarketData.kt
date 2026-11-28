package ai.proompteng.dorvud.platform

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.booleanOrNull
import java.math.BigDecimal
import java.math.BigInteger
import java.time.Instant

const val CRYPTO_SESSION = "continuous"
const val CRYPTO_DELAY_CLASS = "real_time_crypto"
val CRYPTO_LOCATIONS = setOf("us", "us-1", "eu-1")

enum class CryptoChannel(
  val wireType: String,
  val subscription: String,
) {
  Trade("t", "trades"),
  Quote("q", "quotes"),
  Bar("b", "bars"),
  UpdatedBar("u", "updatedBars"),
  Orderbook("o", "orderbooks"),
}

data class CryptoMarketDataEvent(
  val channel: CryptoChannel,
  val symbol: String,
  val eventTs: Instant,
  val payload: JsonObject,
)

fun isCryptoPair(symbol: String): Boolean = symbol.matches(Regex("^[A-Z0-9]+/[A-Z0-9]+$"))

fun decodeCryptoMarketData(payload: JsonObject): CryptoMarketDataEvent {
  fun text(key: String): String =
    (payload[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
      ?: error("crypto $key must be a string")

  val channel = CryptoChannel.entries.singleOrNull { it.wireType == text("T") } ?: error("unsupported crypto event type")
  val symbol = text("S")
  require(isCryptoPair(symbol)) { "crypto symbol must be a BASE/QUOTE pair" }
  val eventTs = Instant.parse(text("t"))

  fun number(key: String): BigDecimal = cryptoNumber(payload[key], key)

  when (channel) {
    CryptoChannel.Trade -> {
      require(number("p") > BigDecimal.ZERO && number("s") > BigDecimal.ZERO) { "crypto trade price and size must be positive" }
      cryptoUnsignedInteger(payload["i"], "i")
      require(text("tks") in setOf("B", "S")) { "crypto trade taker side must be B or S" }
    }
    CryptoChannel.Quote -> {
      val bid = number("bp")
      val ask = number("ap")
      require(bid > BigDecimal.ZERO && ask >= bid) { "crypto quote must be positive and uncrossed" }
      require(number("bs") >= BigDecimal.ZERO && number("as") >= BigDecimal.ZERO) { "crypto quote sizes must be non-negative" }
    }
    CryptoChannel.Bar, CryptoChannel.UpdatedBar -> {
      val open = number("o")
      val high = number("h")
      val low = number("l")
      val close = number("c")
      val volume = number("v")
      require(listOf(open, high, low, close).all { it > BigDecimal.ZERO }) { "crypto bar prices must be positive" }
      require(high >= maxOf(open, close, low) && low <= minOf(open, close, high)) { "crypto bar OHLC is inconsistent" }
      require(volume >= BigDecimal.ZERO) { "crypto bar volume must be non-negative" }
      payload["vw"]?.let {
        val vwap = cryptoNumber(it, "vw")
        require(vwap > BigDecimal.ZERO || (vwap.signum() == 0 && volume.signum() == 0)) { "invalid crypto bar VWAP" }
      }
      payload["n"]?.let { cryptoUnsignedInteger(it, "n") }
    }
    CryptoChannel.Orderbook -> {
      for (side in listOf("b", "a")) {
        val levels = payload[side] as? JsonArray ?: error("crypto orderbook $side must be an array")
        levels.forEach { level ->
          val values = level as? JsonObject ?: error("crypto orderbook level must be an object")
          require(cryptoNumber(values["p"], "p") > BigDecimal.ZERO) { "crypto orderbook price must be positive" }
          require(cryptoNumber(values["s"], "s") >= BigDecimal.ZERO) { "crypto orderbook size must be non-negative" }
        }
      }
      payload["r"]?.let {
        require(
          it is JsonPrimitive && !it.isString && it.booleanOrNull != null,
        ) { "crypto orderbook reset must be boolean" }
      }
    }
  }
  return CryptoMarketDataEvent(channel, symbol, eventTs, JsonObject(payload.mapValues { (_, value) -> preserveCryptoNumbers(value) }))
}

// JsonElement's default encoder converts decimal literals through Double.
@OptIn(ExperimentalSerializationApi::class)
private fun preserveCryptoNumbers(value: JsonElement): JsonElement =
  when (value) {
    is JsonObject -> JsonObject(value.mapValues { (_, element) -> preserveCryptoNumbers(element) })
    is JsonArray -> JsonArray(value.map(::preserveCryptoNumbers))
    is JsonPrimitive ->
      if (!value.isString && value.content.toBigDecimalOrNull() != null) JsonUnquotedLiteral(value.content) else value
  }

private fun cryptoNumber(
  value: JsonElement?,
  field: String,
): BigDecimal {
  val primitive = value as? JsonPrimitive
  require(primitive != null && !primitive.isString) { "crypto $field must be a JSON number" }
  return primitive.content.toBigDecimalOrNull() ?: error("crypto $field must be finite")
}

private fun cryptoUnsignedInteger(
  value: JsonElement?,
  field: String,
) {
  val primitive = value as? JsonPrimitive
  require(primitive != null && !primitive.isString) { "crypto $field must be a JSON integer" }
  val integer = primitive.content.toBigIntegerOrNull() ?: error("crypto $field must be an integer")
  require(integer >= BigInteger.ZERO && integer.bitLength() <= 64) { "crypto $field must fit UInt64" }
}
