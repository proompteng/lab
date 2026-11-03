package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WEBULL_BARS_PATH
import ai.proompteng.dorvud.platform.WEBULL_INSTRUMENTS_PATH
import ai.proompteng.dorvud.platform.webullSha256
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.temporal.ChronoUnit

internal const val MAX_WEBULL_BAR_SYMBOLS = 20

data class WebullInstrument(
  val symbol: String,
  val instrumentId: String,
  val exchange: String,
  val status: String,
  val subCategory: String,
)

data class WebullCatalog(
  val discovered: Int,
  val instruments: List<WebullInstrument>,
  val exclusions: Map<String, Int>,
) {
  val symbols: List<String> = instruments.map { it.symbol }
  val identity: String =
    webullSha256(instruments.joinToString("\n") { "${it.symbol}\t${it.instrumentId}\t${it.exchange}\t${it.subCategory}" }.toByteArray())
}

internal fun JsonObject.requiredText(key: String): String =
  (get(key) as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() } ?: error("missing Webull $key")

internal fun instrument(row: JsonObject): WebullInstrument =
  WebullInstrument(
    row.requiredText("symbol"),
    row.requiredText("instrument_id"),
    row.requiredText("exchange_code"),
    row.requiredText("status"),
    row.requiredText("sub_category"),
  )

internal fun eligibleWebullCatalog(rows: List<WebullInstrument>): WebullCatalog {
  // Nasdaq Basic covers exchange-listed securities; OTC app permissions are a separate entitlement.
  val otcExchanges = setOf("EXPM", "OTCQ", "PK", "PINL", "OTCB", "OTCID", "OTC")
  val exclusions = mutableMapOf<String, Int>()
  val eligible =
    rows
      .filter { row ->
        val reason =
          when {
            row.subCategory !in setOf("COMMON_STOCK", "ETF") -> "unsupported_instrument_type"
            row.exchange in otcExchanges -> "outside_nasdaq_basic"
            row.status !in setOf("OC", "CO") -> "inactive_instrument"
            else -> null
          }
        if (reason != null) exclusions[reason] = exclusions.getOrDefault(reason, 0) + 1
        reason == null
      }.sortedBy { it.symbol }
  require(eligible.isNotEmpty()) { "Webull returned no eligible instruments" }
  require(eligible.map { it.symbol }.distinct().size == eligible.size) { "Webull catalog has ambiguous active symbols" }
  return WebullCatalog(rows.size, eligible, exclusions.toSortedMap())
}

suspend fun WebullApi.discoverCatalog(): WebullCatalog {
  val rows = mutableListOf<WebullInstrument>()
  for (subCategory in listOf("COMMON_STOCK", "ETF")) {
    var cursor: String? = null
    val seen = mutableSetOf<String>()
    do {
      val query =
        buildMap {
          put("category", "US_STOCK")
          put("sub_category", subCategory)
          cursor?.let { put("pagination_key", it) }
        }
      val response = request(WEBULL_INSTRUMENTS_PATH, query)
      rows += (response["data"] as? JsonArray ?: error("missing Webull instrument list")).map { instrument(it.jsonObject) }
      cursor = (response["pagination_key"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
      if (cursor != null) require(seen.add(cursor)) { "Webull repeated a catalog cursor" }
    } while (cursor != null)
  }
  return eligibleWebullCatalog(rows)
}

suspend fun WebullApi.completedBars(
  symbols: List<String>,
  cutoff: Instant,
): JsonObject {
  require(symbols.isNotEmpty() && symbols.size <= MAX_WEBULL_BAR_SYMBOLS && symbols.distinct().size == symbols.size) {
    "invalid Webull bar batch"
  }
  require(cutoff == cutoff.truncatedTo(ChronoUnit.MINUTES)) { "Webull cutoff must be a completed-minute boundary" }
  return request(
    WEBULL_BARS_PATH,
    body =
      buildJsonObject {
        put("symbols", buildJsonArray { symbols.forEach { add(JsonPrimitive(it)) } })
        put("category", "US_STOCK")
        put("timespan", "M1")
        put("count", "5")
        put("real_time_required", true)
        put("trading_sessions", "PRE,RTH,ATH")
        put("start_time", cutoff.minus(5, ChronoUnit.MINUTES).toEpochMilli())
        put("end_time", cutoff.toEpochMilli() - 1)
      },
    symbols = symbols,
  )
}

internal suspend fun collectWebullBarBatch(
  symbols: List<String>,
  fetch: suspend (List<String>) -> Unit,
  invalid: (String) -> Unit,
) {
  try {
    fetch(symbols)
  } catch (failure: WebullApiFailure) {
    if (failure.code != "INVALID_SYMBOL") throw failure
    if (symbols.size == 1) {
      invalid(symbols.single())
    } else {
      val half = symbols.size / 2
      collectWebullBarBatch(symbols.take(half), fetch, invalid)
      collectWebullBarBatch(symbols.drop(half), fetch, invalid)
    }
  }
}
