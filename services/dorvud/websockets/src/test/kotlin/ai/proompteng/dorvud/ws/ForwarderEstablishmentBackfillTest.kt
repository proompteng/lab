package ai.proompteng.dorvud.ws

import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.apache.kafka.clients.producer.Callback
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ForwarderEstablishmentBackfillTest {
  @Test
  fun `healthy subscription and live publication survive paginated backfill beyond establishment deadline`() =
    runBlocking {
      val backfillStarted = CompletableDeferred<Unit>()
      val secondPageStarted = CompletableDeferred<Unit>()
      val releaseBackfill = CompletableDeferred<Unit>()
      val connections = AtomicInteger()
      val records = ConcurrentLinkedQueue<JsonObject>()
      val server =
        embeddedServer(CIO, port = 0) {
          install(WebSockets)
          routing {
            get("/v2/stocks/trades") {
              if (call.request.queryParameters["page_token"] == null) {
                backfillStarted.complete(Unit)
                delay(6000)
                call.respondText("""{"trades":{},"next_page_token":"second"}""")
              } else {
                secondPageStarted.complete(Unit)
                releaseBackfill.await()
                call.respondText("""{"trades":{"SPY":[{"t":"2026-11-12T14:29:59Z","p":100.0,"s":1,"i":1}]}}""")
              }
            }
            webSocket("/v2/iex") {
              connections.incrementAndGet()
              incoming.receive()
              send(Frame.Text("""[{"T":"success","msg":"authenticated"}]"""))
              val request = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
              val ack = JsonObject(request - "action" + ("T" to JsonPrimitive("subscription")))
              send(Frame.Text(JsonArray(listOf(ack)).toString()))
              send(Frame.Text("""[{"T":"t","S":"SPY","t":"2026-11-12T14:30:00Z","p":101.0,"s":1,"i":2}]"""))
              for (frame in incoming) Unit
            }
          }
        }.start(wait = false)
      val producer = mockk<KafkaProducer<String, String>>(relaxed = true)
      val metadata = mockk<RecordMetadata>()
      every { producer.send(any<ProducerRecord<String, String>>(), any<Callback>()) } answers {
        records += Json.parseToJsonElement(firstArg<ProducerRecord<String, String>>().value()).jsonObject
        secondArg<Callback>().onCompletion(metadata, null)
        CompletableFuture.completedFuture(metadata)
      }
      val port = server.resolvedConnectors().single().port
      val config =
        ForwarderConfig.fromEnv(
          mapOf(
            "ALPACA_KEY_ID" to "key",
            "ALPACA_SECRET_KEY" to "secret",
            "ALPACA_STREAM_URL" to "ws://127.0.0.1:$port",
            "ALPACA_BASE_URL" to "http://127.0.0.1:$port",
            "SYMBOLS" to "SPY",
            "ENABLE_TRADES_BACKFILL" to "true",
            "RECONNECT_BASE_MS" to "20",
            "RECONNECT_MAX_MS" to "40",
          ),
        )
      val app = ForwarderApp(config, producerFactory = { producer })
      val job = app.start()
      try {
        withTimeout(5000) {
          backfillStarted.await()
          while (!app
              .readinessInfo()
              .marketDataFeeds
              .single()
              .subscriptionOk ||
            records.none { it["source"] == JsonPrimitive("ws") }
          ) {
            delay(10)
          }
        }
        delay(10_500)
        assertTrue(secondPageStarted.isCompleted)
        assertTrue(
          app
            .readinessInfo()
            .marketDataFeeds
            .single()
            .subscriptionOk,
        )
        assertEquals(1, connections.get())
        releaseBackfill.complete(Unit)
        withTimeout(3000) { while (records.none { it["source"] == JsonPrimitive("rest") }) delay(10) }
        assertEquals(1, records.count { it["source"] == JsonPrimitive("ws") })
        assertEquals(1, records.count { it["source"] == JsonPrimitive("rest") })
        assertEquals(1, connections.get())
      } finally {
        app.stop()
        withTimeout(5000) { job.join() }
        server.stop(0, 1000)
      }
    }
}
