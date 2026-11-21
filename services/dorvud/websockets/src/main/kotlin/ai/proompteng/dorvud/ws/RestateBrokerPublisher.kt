package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.delay
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException

private val brokerIdentityPattern = Regex("[a-f0-9]{64}")
internal const val RESTATE_IDEMPOTENCY_HEADER = "idempotency-key"

internal class RestateBrokerPublisher(
  private val client: HttpClient,
  ingressUrl: String,
  private val retryDelaysMs: List<Long> = listOf(50, 200),
) {
  private val ingressUrl = ingressUrl.trimEnd('/')

  suspend fun publish(
    key: String,
    eventId: String,
    notification: SignedBrokerNotification,
  ) {
    require(key.matches(brokerIdentityPattern)) { "broker notification key is not a canonical identity hash" }
    require(eventId.matches(brokerIdentityPattern)) { "broker notification event id is not canonical" }
    for (attempt in 0..retryDelaysMs.size) {
      try {
        post(key, eventId, notification)
        return
      } catch (failure: IOException) {
        if (attempt == retryDelaysMs.size) throw failure
        delay(retryDelaysMs[attempt])
      }
    }
  }

  private suspend fun post(
    key: String,
    eventId: String,
    notification: SignedBrokerNotification,
  ) {
    val response =
      client.post("$ingressUrl/BaynBrokerObservations/$key/notify") {
        contentType(ContentType.Application.Json)
        header(RESTATE_IDEMPOTENCY_HEADER, eventId)
        setBody(Json.encodeToString(notification))
      }
    val responseBody = response.bodyAsText()
    if (response.status.value >= 500 || response.status.value == 429) {
      throw IOException("Restate broker ingress is temporarily unavailable (${response.status.value})")
    }
    check(response.status.value in 200..299) {
      "Restate broker ingress rejected the notification (${response.status.value})"
    }
    val receipt =
      runCatching { Json.parseToJsonElement(responseBody).jsonObject }
        .getOrElse { throw IllegalStateException("Restate broker ingress returned an invalid receipt", it) }
    check(receipt["accepted"]?.jsonPrimitive?.booleanOrNull == true && receipt["eventId"]?.jsonPrimitive?.content == eventId) {
      "Restate broker ingress returned a mismatched receipt"
    }
  }
}
