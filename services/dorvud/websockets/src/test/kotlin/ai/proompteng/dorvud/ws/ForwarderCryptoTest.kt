package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpSend
import io.ktor.client.plugins.plugin
import io.ktor.http.encodedPath
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.path
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSocketServerSession
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.server.websocket.webSocketRaw
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.apache.kafka.clients.producer.Callback
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import java.io.File
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.client.plugins.websocket.WebSockets as ClientWebSockets

class ForwarderCryptoTest {
  @Test
  fun `same account authenticates equity and crypto and publishes native events on Saturday`() = verifyCryptoSession()

  @Test
  fun `crypto session cancellation reconnects without stopping the equity feed`() = verifyCryptoSession(cancelFirstConnect = true)

  @Test
  fun `stalled crypto HTTP upgrade reconnects and publishes without stopping equity`() =
    verifyCryptoSession(stall = EstablishmentStage.Upgrade)

  @Test
  fun `missing crypto authentication reconnects and releases the old socket`() =
    verifyCryptoSession(stall = EstablishmentStage.Authentication)

  @Test
  fun `missing crypto subscription acknowledgement reconnects and releases the old socket`() =
    verifyCryptoSession(stall = EstablishmentStage.Subscription)

  @Test
  fun `authenticated subscribed crypto session survives the establishment deadline`() = verifyCryptoSession(surviveDeadline = true)

  @Test
  fun `shutdown cancels a pending crypto HTTP upgrade without reconnecting`() =
    verifyCryptoSession(stall = EstablishmentStage.Upgrade, stopWhileEstablishing = true)

  @Test
  fun `shutdown releases a crypto socket waiting for authentication without reconnecting`() =
    verifyCryptoSession(stall = EstablishmentStage.Authentication, stopWhileEstablishing = true)

  @Test
  fun `shutdown releases a crypto socket waiting for subscription without reconnecting`() =
    verifyCryptoSession(stall = EstablishmentStage.Subscription, stopWhileEstablishing = true)

  @Test
  fun `silent established crypto socket reconnects even when peer ignores the close handshake`() =
    verifyCryptoSession(reconnectAfterSilence = true)

  private enum class EstablishmentStage { Upgrade, Authentication, Subscription }

  private fun verifyCryptoSession(
    cancelFirstConnect: Boolean = false,
    stall: EstablishmentStage? = null,
    surviveDeadline: Boolean = false,
    stopWhileEstablishing: Boolean = false,
    reconnectAfterSilence: Boolean = false,
  ) = runBlocking {
    val payloads = Json.parseToJsonElement(File("../fixtures/alpaca-crypto-v1.json").readText()) as JsonArray
    val authentications = ConcurrentLinkedQueue<JsonObject>()
    val subscriptions = ConcurrentLinkedQueue<JsonObject>()
    val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
    val published = CompletableDeferred<Unit>()
    val bothAuthenticated = CompletableDeferred<Unit>()
    val stalled = CompletableDeferred<Unit>()
    val stalledSocketClosed = CompletableDeferred<Unit>()
    val publishAfterDeadline = CompletableDeferred<Unit>()
    val stallNext = AtomicBoolean(stall != null)
    val cryptoConnections = AtomicInteger()
    val now = Instant.parse("2026-10-10T02:04:01Z")
    val clock = AtomicLong(now.toEpochMilli())
    val expectedPublications = payloads.size * if (reconnectAfterSilence) 2 else 1
    val server =
      embeddedServer(CIO, port = 0) {
        install(WebSockets)
        intercept(ApplicationCallPipeline.Plugins) {
          if (call.request.path() == "/v1beta3/crypto/us" && stall == EstablishmentStage.Upgrade &&
            stallNext.compareAndSet(true, false)
          ) {
            stalled.complete(Unit)
            awaitCancellation()
          }
        }
        routing {
          for (path in listOf("/v2/iex", "/v1beta3/crypto/us")) {
            val handler: suspend WebSocketServerSession.() -> Unit = session@{
              val crypto = path.endsWith("/crypto/us")
              if (crypto) cryptoConnections.incrementAndGet()
              val stallThisSocket = crypto && stallNext.compareAndSet(true, false)
              try {
                send(Frame.Text("""[{"T":"success","msg":"connected"}]"""))
                authentications += Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
                if (authentications.size == 2) bothAuthenticated.complete(Unit)
                if (stallThisSocket && stall == EstablishmentStage.Authentication) {
                  stalled.complete(Unit)
                  for (frame in incoming) Unit
                  return@session
                }
                send(Frame.Text("""[{"T":"success","msg":"authenticated"}]"""))
                val subscription = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
                subscriptions += subscription
                if (stallThisSocket && stall == EstablishmentStage.Subscription) {
                  stalled.complete(Unit)
                  send(Frame.Text(payloads.toString()))
                  for (frame in incoming) Unit
                  return@session
                }
                val ack = JsonObject(subscription - "action" + ("T" to JsonPrimitive("subscription")))
                send(Frame.Text(JsonArray(listOf(ack)).toString()))
                if (path.endsWith("/crypto/us")) {
                  val trade = payloads.first().jsonObject
                  val batch =
                    JsonArray(
                      listOf(
                        payloads.first(),
                        JsonObject(trade + ("t" to JsonPrimitive("invalid-timestamp"))),
                        JsonObject(trade + ("T" to JsonObject(emptyMap()))),
                        JsonObject(trade + ("T" to JsonArray(emptyList()))),
                      ) + payloads.drop(1),
                    )
                  send(Frame.Text(batch.toString()))
                  if (reconnectAfterSilence && cryptoConnections.get() == 1) clock.addAndGet(1001)
                  if (surviveDeadline) {
                    publishAfterDeadline.await()
                    send(Frame.Binary(true, JsonArray(listOf(payloads[1])).toString().toByteArray()))
                  }
                }
                for (frame in incoming) Unit
              } finally {
                if (stallThisSocket) stalledSocketClosed.complete(Unit)
              }
            }
            if (reconnectAfterSilence) webSocketRaw(path, handler = handler) else webSocket(path, handler = handler)
          }
        }
      }.start(wait = false)
    val port = server.resolvedConnectors().single().port
    val producer = mockk<KafkaProducer<String, String>>(relaxed = true)
    val metadata = mockk<RecordMetadata>()
    every { producer.send(any<ProducerRecord<String, String>>(), any<Callback>()) } answers {
      val record = firstArg<ProducerRecord<String, String>>()
      records += record
      secondArg<Callback>().onCompletion(metadata, null)
      if (records.count { it.topic() == "crypto-events" } == expectedPublications) published.complete(Unit)
      CompletableFuture.completedFuture(metadata)
    }
    val config =
      ForwarderConfig
        .fromEnv(
          mapOf(
            "ALPACA_KEY_ID" to "same-account-key",
            "ALPACA_SECRET_KEY" to "same-account-secret",
            "ALPACA_STREAM_URL" to "ws://127.0.0.1:$port",
            "SYMBOLS" to "SPY",
            "ALPACA_CRYPTO_SYMBOLS" to "BTC/USD",
            "TOPIC_CRYPTO_EVENTS" to "crypto-events",
            "RECONNECT_BASE_MS" to "20",
            "RECONNECT_MAX_MS" to "40",
          ),
        ).let { if (reconnectAfterSilence) it.copy(marketDataReadIdleTimeoutMs = 100) else it }
    val cancelConnect = AtomicBoolean(cancelFirstConnect)
    val client =
      HttpClient(ClientCIO) {
        install(ClientWebSockets)
      }.apply {
        plugin(HttpSend).intercept { request ->
          if (request.url.encodedPath.endsWith("/crypto/us") && cancelConnect.compareAndSet(true, false)) {
            throw CancellationException("Crypto session handshake canceled")
          }
          execute(request)
        }
      }
    val app = ForwarderApp(config, producerFactory = { producer }, nowMs = clock::get, httpClient = client)
    val job = app.start()
    try {
      if (stopWhileEstablishing) {
        withTimeout(5000) { stalled.await() }
        app.stop()
        withTimeout(5000) { job.join() }
        assertEquals(if (stall == EstablishmentStage.Upgrade) 0 else 1, cryptoConnections.get())
        if (stall != EstablishmentStage.Upgrade) withTimeout(5000) { stalledSocketClosed.await() }
        assertFalse(job.isActive)
        return@runBlocking
      }
      if (stall == EstablishmentStage.Subscription) {
        withTimeout(5000) { stalled.await() }
        delay(100)
        assertTrue(records.none { it.topic() == "crypto-events" })
        assertFalse(
          app
            .readinessInfo()
            .marketDataFeeds
            .single { it.feed == "us" }
            .subscriptionOk,
        )
      }
      withTimeout(14_000) {
        published.await()
        bothAuthenticated.await()
        if (stall != null && stall != EstablishmentStage.Upgrade) stalledSocketClosed.await()
      }
      val reestablished = stall == EstablishmentStage.Authentication || stall == EstablishmentStage.Subscription || reconnectAfterSilence
      assertEquals(if (reestablished) 3 else 2, authentications.size)
      assertEquals(if (reestablished) 2 else 1, cryptoConnections.get())
      assertTrue(
        authentications.all {
          it["key"] == JsonPrimitive("same-account-key") &&
            it["secret"] == JsonPrimitive("same-account-secret")
        },
      )
      assertTrue(subscriptions.any { "orderbooks" in it && "updatedBars" in it })
      val crypto = records.filter { it.topic() == "crypto-events" }
      val expectedPayloads = if (reconnectAfterSilence) payloads + payloads else payloads
      assertEquals(expectedPayloads, crypto.map { Json.parseToJsonElement(it.value()).jsonObject.getValue("payload") })
      assertTrue(crypto.all { it.key() == "BTC/USD" })
      assertEquals(
        (1L..expectedPublications.toLong()).toList(),
        crypto.map {
          Json
            .parseToJsonElement(it.value())
            .jsonObject
            .getValue("seq")
            .jsonPrimitive.content
            .toLong()
        },
      )
      withTimeout(5000) { while (!app.isReady()) delay(10) }
      if (surviveDeadline) {
        delay(10_500)
        assertEquals(1, cryptoConnections.get())
        assertTrue(app.isReady())
        publishAfterDeadline.complete(Unit)
        withTimeout(5000) { while (records.count { it.topic() == "crypto-events" } != payloads.size + 1) delay(10) }
        assertEquals(payloads[1], Json.parseToJsonElement(records.last().value()).jsonObject.getValue("payload"))
      }
      assertTrue(
        app
          .readinessInfo()
          .marketDataFeeds
          .single { it.feed == "us" }
          .ready,
      )
      clock.addAndGet(180_001)
      assertFalse(app.isReady())
      assertFalse(
        app
          .readinessInfo()
          .marketDataFeeds
          .single { it.feed == "us" }
          .ready,
      )
      assertFalse(
        providerMarketDataIdleRequiresReconnect(now, now, now.plusSeconds(1), AlpacaMarketType.CRYPTO, emptySet(), null, 180_000),
      )
      assertTrue(
        providerMarketDataIdleRequiresReconnect(now, now, now.plusSeconds(180), AlpacaMarketType.CRYPTO, emptySet(), null, 180_000),
      )
    } finally {
      app.stop()
      withTimeout(5000) { job.join() }
      server.stop(0, 1000)
    }
  }
}
