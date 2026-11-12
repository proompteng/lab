package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.url
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.websocket.Frame
import io.ktor.websocket.readBytes
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant

internal data class TradeUpdateSubscription(
  val authenticatedAt: Instant,
  val subscribedAt: Instant,
)

internal data class AlpacaTradeUpdate(
  val data: JsonObject,
  val frameJson: String,
  val receivedAt: Instant,
)

internal class BrokerStreamAuthenticationException : IllegalStateException("broker stream authorization failed")

internal class BrokerStreamEstablishmentTimeoutException : IllegalStateException("broker stream establishment timed out")

internal const val ALPACA_TRADE_UPDATE_MAX_FRAME_BYTES = 262_144L

private sealed interface TradeUpdateSessionState {
  data object Authenticating : TradeUpdateSessionState

  data class Subscribing(
    val authenticatedAt: Instant,
  ) : TradeUpdateSessionState

  data object Ready : TradeUpdateSessionState
}

internal suspend fun HttpClient.streamAlpacaTradeUpdates(
  streamUrl: String,
  keyId: String,
  secretKey: String,
  onReady: suspend (TradeUpdateSubscription) -> Unit,
  onUpdate: suspend (AlpacaTradeUpdate) -> Unit,
  now: () -> Instant = Instant::now,
  establishmentTimeoutMs: Long = 10_000,
): Unit =
  coroutineScope {
    require(establishmentTimeoutMs > 0) { "broker stream establishment timeout must be positive" }
    val established = CompletableDeferred<Unit>()
    val streaming =
      async {
        webSocketWithBoundedCleanup(
          request = {
            url(streamUrl)
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
          },
        ) {
          maxFrameSize = ALPACA_TRADE_UPDATE_MAX_FRAME_BYTES
          send(
            Frame.Text(
              buildJsonObject {
                put("action", "auth")
                put("key", keyId)
                put("secret", secretKey)
              }.toString(),
            ),
          )
          var state: TradeUpdateSessionState = TradeUpdateSessionState.Authenticating
          while (isActive) {
            val frame = incoming.receive()
            val receivedAt = now()
            require(frame.data.size <= ALPACA_TRADE_UPDATE_MAX_FRAME_BYTES) { "broker frame exceeds the source limit" }
            val text =
              when (frame) {
                is Frame.Text -> frame.data.decodeToString(throwOnInvalidSequence = true)
                is Frame.Binary -> frame.readBytes().decodeToString(throwOnInvalidSequence = true)
                else -> continue
              }
            val message = Json.parseToJsonElement(text).jsonObject
            when (message["stream"]?.jsonPrimitive?.contentOrNull) {
              "authorization" -> {
                if (message["data"]?.jsonObject?.get("status") != JsonPrimitive("authorized")) {
                  throw BrokerStreamAuthenticationException()
                }
                if (state == TradeUpdateSessionState.Authenticating) {
                  state = TradeUpdateSessionState.Subscribing(receivedAt)
                  send(
                    Frame.Text(
                      buildJsonObject {
                        put("action", "listen")
                        put("data", buildJsonObject { put("streams", buildJsonArray { add(JsonPrimitive("trade_updates")) }) })
                      }.toString(),
                    ),
                  )
                }
              }
              "listening" -> {
                val streams = message["data"]?.jsonObject?.get("streams") as? JsonArray
                check(streams?.contains(JsonPrimitive("trade_updates")) == true) { "broker stream subscription failed" }
                when (val current = state) {
                  TradeUpdateSessionState.Authenticating -> error("broker subscribed before authentication")
                  is TradeUpdateSessionState.Subscribing -> {
                    val subscription = TradeUpdateSubscription(current.authenticatedAt, receivedAt)
                    established.complete(Unit)
                    onReady(subscription)
                    state = TradeUpdateSessionState.Ready
                  }
                  TradeUpdateSessionState.Ready -> Unit
                }
              }
              "trade_updates" -> {
                check(state is TradeUpdateSessionState.Ready) { "broker update preceded authenticated subscription" }
                val data = message["data"] as? JsonObject ?: error("broker update has no object payload")
                onUpdate(AlpacaTradeUpdate(data, text, receivedAt))
              }
            }
          }
        }
        check(established.isCompleted) { "broker stream closed before subscription" }
      }
    // Ktor 2.3.12 HttpTimeout skips WebSockets. End this deadline at the listening ACK,
    // before Kafka publication or the lifetime of the streaming session.
    val acknowledged =
      withTimeoutOrNull(establishmentTimeoutMs) {
        established.await()
        true
      }
    if (acknowledged != true) throw BrokerStreamEstablishmentTimeoutException()
    streaming.await()
  }
