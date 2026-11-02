package ai.proompteng.dorvud.platform

import com.google.protobuf.CodedInputStream
import com.google.protobuf.WireFormat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.math.BigDecimal
import java.time.Instant

data class WebullObservation(
  val symbol: String,
  val sourceTime: String,
)

data class WebullPayload(
  val channel: String,
  val observations: List<WebullObservation>,
  val outOfWindowBars: Int = 0,
)

private fun protobufFields(bytes: ByteArray): Map<Int, List<ByteArray>> {
  val input = CodedInputStream.newInstance(bytes)
  val fields = mutableMapOf<Int, MutableList<ByteArray>>()
  while (!input.isAtEnd) {
    val tag = input.readTag()
    require(tag != 0) { "unexpected protobuf end tag" }
    if (WireFormat.getTagWireType(tag) == WireFormat.WIRETYPE_LENGTH_DELIMITED) {
      fields.getOrPut(WireFormat.getTagFieldNumber(tag)) { mutableListOf() }.add(input.readByteArray())
    } else {
      require(input.skipField(tag)) { "unsupported protobuf group" }
    }
  }
  return fields
}

private fun Map<Int, List<ByteArray>>.text(field: Int): String =
  get(field)?.singleOrNull()?.decodeToString(throwOnInvalidSequence = true) ?: error("missing or repeated Webull field $field")

fun webullProviderInstant(value: String): Instant? =
  runCatching {
    if (value.matches(Regex("[0-9]{13}"))) {
      Instant.ofEpochMilli(value.toLong())
    } else {
      Instant.parse(value.replace(Regex("([+-][0-9]{2})([0-9]{2})$"), "$1:$2"))
    }
  }.getOrNull()

private fun decimal(
  value: String,
  positive: Boolean = false,
) {
  val parsed = value.toBigDecimalOrNull() ?: error("invalid Webull decimal")
  require(if (positive) parsed > BigDecimal.ZERO else parsed >= BigDecimal.ZERO) { "invalid Webull decimal sign" }
}

private fun symbol(value: String): String {
  require(value.isNotBlank() && value.length <= 64 && value.none { it.isISOControl() }) { "invalid Webull symbol" }
  return value
}

private fun JsonObject.text(key: String): String = (get(key) as? JsonPrimitive)?.content ?: error("missing Webull $key")

fun inspectWebullCapture(capture: WebullCapture): WebullPayload {
  val bytes = capture.bytes()
  return when (val source = capture.source) {
    is WebullSource.Collector -> {
      Json.parseToJsonElement(bytes.decodeToString(throwOnInvalidSequence = true)).jsonObject
      WebullPayload(source.operation, emptyList())
    }
    is WebullSource.Mqtt -> {
      if (source.topic == "notice") {
        Json.parseToJsonElement(bytes.decodeToString(throwOnInvalidSequence = true)).jsonObject
        WebullPayload("notice", emptyList())
      } else {
        val payload = protobufFields(bytes)
        val basic = protobufFields(payload[1]?.singleOrNull() ?: error("missing Webull basic record"))
        val observedSymbol = symbol(basic.text(1))
        basic.text(2).also { require(it.isNotBlank()) { "missing Webull instrument id" } }
        val sourceTime = basic.text(3)
        require(sourceTime.isNotBlank()) { "missing Webull provider timestamp" }
        if (source.topic == "tick") {
          require(payload.text(2).isNotBlank()) { "missing Webull trade clock" }
          decimal(payload.text(3), positive = true)
          decimal(payload.text(4), positive = true)
        } else {
          for (side in listOf(2, 3)) {
            for (level in payload[side].orEmpty()) {
              val quote = protobufFields(level)
              decimal(quote.text(1))
              decimal(quote.text(2))
            }
          }
        }
        WebullPayload(if (source.topic == "tick") "trades" else "quotes", listOf(WebullObservation(observedSymbol, sourceTime)))
      }
    }
    is WebullSource.Http -> {
      val body = Json.parseToJsonElement(bytes.decodeToString(throwOnInvalidSequence = true)).jsonObject
      when (source.endpoint) {
        WEBULL_INSTRUMENTS_PATH -> {
          val rows = body["data"] as? JsonArray ?: error("missing Webull instrument list")
          WebullPayload("instruments", rows.map { WebullObservation(symbol(it.jsonObject.text("symbol")), "") })
        }
        WEBULL_QUOTES_PATH -> {
          WebullPayload("quotes", listOf(WebullObservation(symbol(body.text("symbol")), body.text("quote_time"))))
        }
        WEBULL_BARS_PATH -> {
          val request = Json.parseToJsonElement(source.requestBody ?: error("missing Webull bar request")).jsonObject
          require(request.text("timespan") == "M1" && request.text("real_time_required") == "true") { "invalid Webull bar request" }
          val start = Instant.ofEpochMilli(request.text("start_time").toLong())
          val end = Instant.ofEpochMilli(request.text("end_time").toLong()).plusMillis(1)
          require(start < end && end <= Instant.parse(capture.receivedAt)) { "unfinished Webull bar request" }
          val groups = body["result"] as? JsonArray ?: error("missing Webull bar groups")
          var outOfWindowBars = 0
          val observations =
            groups.flatMap { group ->
              val item = group.jsonObject
              val observedSymbol = symbol(item.text("symbol"))
              require(observedSymbol in source.requestedSymbols) { "unexpected Webull bar symbol" }
              require(item.text("delay_minutes") == "0") { "Webull bars do not have the real-time entitlement" }
              val bars = item["result"] as? JsonArray ?: error("missing Webull bars")
              bars.mapNotNull { raw ->
                val bar = raw.jsonObject
                for (price in listOf("open", "high", "low", "close")) decimal(bar.text(price), positive = true)
                decimal(bar.text("volume"))
                val low = bar.text("low").toBigDecimal()
                val high = bar.text("high").toBigDecimal()
                require(low <= high && bar.text("open").toBigDecimal() in low..high && bar.text("close").toBigDecimal() in low..high) {
                  "inconsistent Webull OHLC"
                }
                val time = webullProviderInstant(bar.text("time")) ?: error("invalid Webull bar timestamp")
                require(time.epochSecond % 60 == 0L && time.nano == 0) { "Webull M1 bar is not aligned to a minute" }
                if (time < start || time.plusSeconds(60) > end) {
                  outOfWindowBars++
                  null
                } else {
                  WebullObservation(observedSymbol, bar.text("time"))
                }
              }
            }
          WebullPayload("bars", observations, outOfWindowBars)
        }
        else -> error("unsupported Webull payload endpoint")
      }
    }
  }
}
