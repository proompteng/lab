package ai.proompteng.dorvud.ws

import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.mockk.every
import io.mockk.mockk
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
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForwarderCryptoTest {
  @Test
  fun `same account authenticates equity and crypto and publishes native events on Saturday`() =
    runBlocking {
      val payloads = Json.parseToJsonElement(File("../fixtures/alpaca-crypto-v1.json").readText()) as JsonArray
      val authentications = ConcurrentLinkedQueue<JsonObject>()
      val subscriptions = ConcurrentLinkedQueue<JsonObject>()
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      val published = CompletableDeferred<Unit>()
      val bothAuthenticated = CompletableDeferred<Unit>()
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
        if (records.count { it.topic() == "crypto-events" } == payloads.size) published.complete(Unit)
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
      val app = ForwarderApp(config, producerFactory = { producer }, nowMs = clock::get)
      val job = app.start()
      try {
        withTimeout(10_000) {
          published.await()
          bothAuthenticated.await()
        }
        assertEquals(2, authentications.size)
        assertTrue(
          authentications.all {
            it["key"] == JsonPrimitive("same-account-key") &&
              it["secret"] == JsonPrimitive("same-account-secret")
          },
        )
        assertTrue(subscriptions.any { "orderbooks" in it && "updatedBars" in it })
        val crypto = records.filter { it.topic() == "crypto-events" }
        assertEquals(payloads, crypto.map { Json.parseToJsonElement(it.value()).jsonObject.getValue("payload") })
        assertTrue(crypto.all { it.key() == "BTC/USD" })
        assertEquals(
          (1L..payloads.size.toLong()).toList(),
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
        app.stop()
        withTimeout(5000) { job.join() }
        server.stop(0, 1000)
      }
    }
}
