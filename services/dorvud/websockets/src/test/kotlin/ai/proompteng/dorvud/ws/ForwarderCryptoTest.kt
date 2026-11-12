package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpSend
import io.ktor.client.plugins.plugin
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.statement.HttpResponseContainer
import io.ktor.client.statement.HttpResponsePipeline
import io.ktor.http.encodedPath
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
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
import java.util.concurrent.atomic.AtomicReference
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
  fun `crypto reauthenticates and resubscribes after a stalled close without restarting equity`() =
    verifyCryptoSession(stallFirstClose = true)

  private fun verifyCryptoSession(
    cancelFirstConnect: Boolean = false,
    stallFirstClose: Boolean = false,
  ) = runBlocking {
    val payloads = Json.parseToJsonElement(File("../fixtures/alpaca-crypto-v1.json").readText()) as JsonArray
    val authentications = ConcurrentLinkedQueue<JsonObject>()
    val subscriptions = ConcurrentLinkedQueue<JsonObject>()
    val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
    val published = CompletableDeferred<Unit>()
    val republished = CompletableDeferred<Unit>()
    val bothAuthenticated = CompletableDeferred<Unit>()
    val closeStarted = CompletableDeferred<Unit>()
    val cryptoConnections = AtomicInteger(0)
    val stalledSession = AtomicReference<Job?>(null)
    val stalledCall = AtomicReference<Job?>(null)
    val stalledWriter = AtomicReference<Job?>(null)
    val server =
      embeddedServer(CIO, port = 0) {
        install(WebSockets)
        routing {
          for (path in listOf("/v2/iex", "/v1beta3/crypto/us")) {
            webSocket(path) {
              send(Frame.Text("""[{"T":"success","msg":"connected"}]"""))
              authentications += Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
              if (authentications.size == 2) bothAuthenticated.complete(Unit)
              send(Frame.Text("""[{"T":"success","msg":"authenticated"}]"""))
              val subscription = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
              subscriptions += subscription
              val ack = JsonObject(subscription - "action" + ("T" to JsonPrimitive("subscription")))
              send(Frame.Text(JsonArray(listOf(ack)).toString()))
              if (path.endsWith("/crypto/us")) {
                val connection = cryptoConnections.incrementAndGet()
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
                if (stallFirstClose && connection == 1) {
                  close(CloseReason(CloseReason.Codes.GOING_AWAY, "test disconnect"))
                  return@webSocket
                }
              }
              awaitCancellation()
            }
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
      val cryptoCount = records.count { it.topic() == "crypto-events" }
      if (cryptoCount == payloads.size) published.complete(Unit)
      if (cryptoCount == payloads.size * 2) republished.complete(Unit)
      CompletableFuture.completedFuture(metadata)
    }
    val config =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "same-account-key",
          "ALPACA_SECRET_KEY" to "same-account-secret",
          "ALPACA_STREAM_URL" to "ws://127.0.0.1:$port",
          "SYMBOLS" to "SPY",
          "ALPACA_CRYPTO_SYMBOLS" to "BTC/USD",
          "TOPIC_CRYPTO_EVENTS" to "crypto-events",
        ),
      )
    val now = Instant.parse("2026-10-10T02:04:01Z")
    val clock = AtomicLong(now.toEpochMilli())
    val cancelConnect = AtomicBoolean(cancelFirstConnect)
    val stallClose = AtomicBoolean(stallFirstClose)
    val client =
      HttpClient(ClientCIO) {
        install(ClientWebSockets)
      }.apply {
        responsePipeline.intercept(HttpResponsePipeline.After) {
          val session = subject.response as? DefaultClientWebSocketSession
          if (session != null &&
            session.call.request.url.encodedPath
              .endsWith("/crypto/us") &&
            stallClose.compareAndSet(true, false)
          ) {
            // Model a disconnected transport whose close frame queues successfully
            // but whose flush remains suspended until the caller cancels it.
            val lifecycle = Job()
            stalledSession.set(lifecycle)
            stalledCall.set(session.call.coroutineContext.job)
            // A stuck raw writer keeps HttpStatement's final call-job join open
            // even after the higher-level WebSocket session has been cancelled.
            stalledWriter.set(Job(session.call.coroutineContext.job))
            val delegate =
              object : DefaultWebSocketSession by session {
                override val coroutineContext = session.coroutineContext.minusKey(Job) + lifecycle

                override suspend fun send(frame: Frame) {
                  if (frame !is Frame.Close) session.send(frame)
                }

                override suspend fun flush() {
                  closeStarted.complete(Unit)
                  if (lifecycle.isActive) awaitCancellation()
                }
              }
            proceedWith(HttpResponseContainer(subject.expectedType, DefaultClientWebSocketSession(session.call, delegate)))
          }
        }
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
      withTimeout(10_000) {
        published.await()
        bothAuthenticated.await()
      }
      if (stallFirstClose) {
        withTimeout(12_000) {
          closeStarted.await()
          republished.await()
          while (authentications.size < 3 || !app.isReady()) delay(10)
        }
        assertTrue(requireNotNull(stalledSession.get()).isCancelled)
        assertTrue(requireNotNull(stalledCall.get()).isCancelled)
        assertTrue(requireNotNull(stalledWriter.get()).isCancelled)
        assertEquals(2, cryptoConnections.get())
      }
      assertEquals(if (stallFirstClose) 3 else 2, authentications.size)
      assertTrue(
        authentications.all {
          it["key"] == JsonPrimitive("same-account-key") &&
            it["secret"] == JsonPrimitive("same-account-secret")
        },
      )
      assertTrue(subscriptions.any { "orderbooks" in it && "updatedBars" in it })
      val crypto = records.filter { it.topic() == "crypto-events" }
      val expectedPayloads = if (stallFirstClose) payloads + payloads else payloads.toList()
      assertEquals(expectedPayloads, crypto.map { Json.parseToJsonElement(it.value()).jsonObject.getValue("payload") })
      assertTrue(crypto.all { it.key() == "BTC/USD" })
      assertEquals(
        (1L..expectedPayloads.size.toLong()).toList(),
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
      stalledSession.get()?.cancel()
      stalledCall.get()?.cancel()
      app.stop()
      withTimeout(5000) { job.join() }
      server.stop(0, 1000)
    }
  }
}
