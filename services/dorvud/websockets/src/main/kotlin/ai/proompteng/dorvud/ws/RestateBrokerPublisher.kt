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
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException

private val brokerIdentityPattern = Regex("[a-f0-9]{64}")
internal const val RESTATE_IDEMPOTENCY_HEADER = "idempotency-key"
internal const val BROKER_SOURCE_PROJECTION_CONTRACT = "bayn.broker-source-projection.v1"

internal class RestateBrokerPublisher(
  private val client: HttpClient,
  ingressUrl: String,
  private val sourceRevision: String,
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
    retry { post(key, eventId, notification) }
  }

  suspend fun activityCursor(key: String): BrokerActivityCursorReceipt {
    require(key.matches(brokerIdentityPattern)) { "broker activity key is not a canonical identity hash" }
    return retry { postActivityCursor(key) }
  }

  suspend fun publishActivity(
    key: String,
    eventId: String,
    activity: SignedBrokerActivity,
  ): BrokerActivityCursorReceipt = publishActivityMessage(key, eventId, activity, "ingest")

  suspend fun completeActivityCatchup(
    key: String,
    eventId: String,
    activity: SignedBrokerActivity,
  ): BrokerActivityCursorReceipt = publishActivityMessage(key, eventId, activity, "catchup")

  suspend fun publishActivityHeartbeat(
    key: String,
    eventId: String,
    activity: SignedBrokerActivity,
  ): BrokerActivityCursorReceipt = publishActivityMessage(key, eventId, activity, "heartbeat")

  private suspend fun publishActivityMessage(
    key: String,
    eventId: String,
    activity: SignedBrokerActivity,
    handler: String,
  ): BrokerActivityCursorReceipt {
    require(key.matches(brokerIdentityPattern)) { "broker activity key is not a canonical identity hash" }
    require(eventId.matches(brokerIdentityPattern)) { "broker activity event id is not canonical" }
    return retry { postActivity(key, eventId, activity, handler) }
  }

  private suspend fun <A> retry(action: suspend () -> A): A {
    for (attempt in 0..retryDelaysMs.size) {
      try {
        return action()
      } catch (failure: IOException) {
        if (attempt == retryDelaysMs.size) throw failure
        delay(retryDelaysMs[attempt])
      }
    }
    error("broker publication retry exhausted without an attempt")
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
    if (response.status.value == 408 || response.status.value == 429 || response.status.value >= 500) {
      throw IOException("Restate broker ingress is temporarily unavailable (${response.status.value})")
    }
    check(response.status.value in 200..299) {
      "Restate broker ingress rejected the notification (${response.status.value})"
    }
    val receipt =
      runCatching { Json.parseToJsonElement(responseBody).jsonObject }
        .getOrElse { throw IllegalStateException("Restate broker ingress returned an invalid receipt", it) }
    check(
      receipt["accepted"]?.jsonPrimitive?.booleanOrNull == true &&
        receipt["eventId"]?.jsonPrimitive?.content == eventId &&
        receipt["sourceRevision"]?.jsonPrimitive?.content == sourceRevision &&
        receipt["projectionContract"]?.jsonPrimitive?.content == BROKER_SOURCE_PROJECTION_CONTRACT,
    ) {
      "Restate broker ingress returned a mismatched receipt"
    }
  }

  private suspend fun postActivityCursor(key: String): BrokerActivityCursorReceipt {
    val response =
      client.post("$ingressUrl/BaynBrokerActivities/$key/cursor") {
        contentType(ContentType.Application.Json)
        setBody("{}")
      }
    return activityReceipt(response.status.value, response.bodyAsText(), null)
  }

  private suspend fun postActivity(
    key: String,
    eventId: String,
    activity: SignedBrokerActivity,
    handler: String,
  ): BrokerActivityCursorReceipt {
    val response =
      client.post("$ingressUrl/BaynBrokerActivities/$key/$handler") {
        contentType(ContentType.Application.Json)
        header(RESTATE_IDEMPOTENCY_HEADER, eventId)
        setBody(Json.encodeToString(activity))
      }
    return activityReceipt(response.status.value, response.bodyAsText(), eventId)
  }

  private fun activityReceipt(
    status: Int,
    body: String,
    expectedEventId: String?,
  ): BrokerActivityCursorReceipt {
    if (status == 408 || status == 429 || status >= 500) {
      throw IOException("Restate broker activity ingress is unavailable ($status)")
    }
    check(status in 200..299) { "Restate broker activity ingress rejected the request ($status)" }
    val receipt =
      runCatching { Json.parseToJsonElement(body).jsonObject }
        .getOrElse { throw IllegalStateException("Restate broker activity ingress returned an invalid receipt", it) }
    check(
      receipt["sourceRevision"]?.jsonPrimitive?.content == sourceRevision &&
        receipt["projectionContract"]?.jsonPrimitive?.content == BROKER_ACTIVITY_PROJECTION_CONTRACT &&
        (
          expectedEventId == null ||
            (
              receipt["accepted"]?.jsonPrimitive?.booleanOrNull == true &&
                receipt["eventId"]?.jsonPrimitive?.content == expectedEventId
            )
        ),
    ) { "Restate broker activity ingress returned a mismatched receipt" }
    return BrokerActivityCursorReceipt(
      cursor = receipt["cursor"]?.jsonPrimitive?.contentOrNull,
      caughtUp =
        receipt["caughtUp"]?.jsonPrimitive?.booleanOrNull
          ?: error("Restate broker activity receipt omitted catchup state"),
      coveredThrough = receipt["coveredThrough"]?.jsonPrimitive?.contentOrNull,
      fillFeeComplete =
        receipt["fillFeeComplete"]?.jsonPrimitive?.booleanOrNull
          ?: error("Restate broker activity receipt omitted fill and fee completeness"),
      sourceRevision = sourceRevision,
    )
  }
}
