package ai.proompteng.dorvud.webull

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class WebullSubscriptionCoverage(
  val requested: Set<String>,
  val accepted: Set<String>,
  val invalid: Set<String>,
  val quotaWitness: String?,
)

internal suspend fun admitWebullSubscriptions(
  candidates: List<String>,
  subscribe: suspend (List<String>) -> Unit,
): WebullSubscriptionCoverage {
  require(candidates.distinct().size == candidates.size) { "duplicate Webull subscription candidates" }
  val requested = linkedSetOf<String>()
  val accepted = linkedSetOf<String>()
  val invalid = linkedSetOf<String>()
  var quotaWitness: String? = null

  suspend fun admit(batch: List<String>) {
    if (quotaWitness != null) return
    requested += batch
    try {
      subscribe(batch)
      accepted += batch
    } catch (failure: WebullApiFailure) {
      if (failure.code !in setOf("INVALID_SYMBOL", "TOO_MANY_SYMBOLS_SUBSCRIPTION")) throw failure
      if (batch.size > 1) {
        val half = batch.size / 2
        admit(batch.take(half))
        admit(batch.drop(half))
      } else if (failure.code == "INVALID_SYMBOL") {
        invalid += batch.single()
      } else {
        quotaWitness = batch.single()
      }
    }
  }

  for (batch in candidates.chunked(100)) {
    admit(batch)
    if (quotaWitness != null) break
  }
  return WebullSubscriptionCoverage(requested, accepted, invalid, quotaWitness)
}

suspend fun WebullApi.subscribeMaximum(
  sessionId: String,
  candidates: List<String>,
): WebullSubscriptionCoverage =
  admitWebullSubscriptions(candidates) { symbols ->
    request(
      "/market-data/streaming/subscribe",
      body =
        buildJsonObject {
          put("session_id", sessionId)
          put("symbols", buildJsonArray { symbols.forEach { add(JsonPrimitive(it)) } })
          put("category", "US_STOCK")
          put(
            "sub_types",
            buildJsonArray {
              add(JsonPrimitive("QUOTE"))
              add(JsonPrimitive("TICK"))
            },
          )
          put("depth", "1")
          put("overnight_required", false)
        },
    )
  }
