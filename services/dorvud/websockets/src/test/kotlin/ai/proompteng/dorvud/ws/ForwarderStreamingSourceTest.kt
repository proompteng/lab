package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.http.ContentType
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.apache.kafka.clients.producer.Callback
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.client.plugins.websocket.WebSockets as ClientWebSockets

class ForwarderStreamingSourceTest {
  private val all =
    listOf("AAPL", "AMD", "AMZN", "AVGO", "COHR", "CRDO", "IWM", "LITE", "MRVL", "MU", "NVDA", "QQQ", "SMH", "SNDK", "SPY", "WDC")
  private val admitted = mapOf("trades" to all, "quotes" to all, "bars" to all)

  @Test
  fun `one authenticated socket publishes every configured channel without ordinary REST acquisition`() =
    runBlocking {
      withForwarder(scenario = { state, connection ->
        assertEquals(1, connection)
        val time = state.clock.get()
        val events = all.flatMap { listOf(quote(it, time), trade(it, time), bar(it, time)) }
        sendBatch(events.take(24))
        sendBatch(events.drop(24), binary = true)
        sendBatch(listOf(quote("XYZ", time), JsonObject(bar("AAPL", time) + ("T" to JsonPrimitive("u")))))
        sendBatch(listOf(bar("AAPL", time + 60000), quote("AAPL", time + 60000)))
      }) { state, app ->
        state.await { state.envelopes().count { it.string("source") == "ws" } == 50 }
        val published = state.envelopes().filter { it.string("source") == "ws" }
        assertEquals(admitted.keys, published.map { it.string("channel") }.toSet())
        admitted.forEach { (channel, symbols) ->
          assertEquals(symbols.toSet(), published.filter { it.string("channel") == channel }.map { it.string("symbol") }.toSet())
        }
        assertEquals(JsonPrimitive(2), published.last()["seq"])
        assertEquals(JsonPrimitive(2), published.last { it.string("channel") == "bars" && it.string("symbol") == "AAPL" }["seq"])
        assertEquals(1, state.connections.get())
        assertEquals(1, state.requests.size)
        assertEquals(0, state.latestRequests.get())
        assertTrue(app.readinessInfo().alpacaMarketDataWs.subscriptionOk)
        assertEquals(admitted, app.readinessInfo().alpacaMarketDataWs.subscribedSymbolsByChannel)
      }
    }

  @Test
  fun `partial acknowledgement withholds frames until the missing channel memberships arrive`() =
    runBlocking {
      withForwarder(acknowledgeInitially = false, scenario = { state, connection ->
        assertEquals(1, connection)
        sendBatch(listOf(ack(admitted + ("quotes" to all.dropLast(1)))))
        sendBatch(listOf(quote("AAPL", state.clock.get()), quote("WDC", state.clock.get())))
        assertMembership(request(state), "subscribe", mapOf("quotes" to listOf("WDC")))
        state.clock.incrementAndGet()
        sendBatch(listOf(ack(admitted), quote("WDC", state.clock.get())))
      }) { state, app ->
        state.await { state.envelopes().any { it.string("source") == "ws" } }
        val published = state.envelopes().filter { it.string("source") == "ws" }
        assertEquals(1, published.size)
        assertEquals("WDC", published.single().string("symbol"))
        assertEquals(Instant.ofEpochMilli(state.clock.get()).toString(), published.single().string("eventTs"))
        assertEquals(2, state.requests.size)
        assertEquals(0, state.latestRequests.get())
        assertTrue(app.readinessInfo().alpacaMarketDataWs.subscriptionOk)
      }
    }

  @Test
  fun `provider rejection reconnects with fresh admission and never starts REST acquisition`() =
    runBlocking {
      withForwarder(acknowledgeInitially = false, scenario = { state, connection ->
        sendBatch(listOf(quote("AAPL", state.clock.get())))
        if (connection == 1) {
          sendBatch(
            listOf(
              buildJsonObject {
                put("T", "error")
                put("code", 405)
                put("msg", "subscription limit exceeded")
              },
            ),
          )
        } else {
          assertEquals(2, connection)
          state.clock.incrementAndGet()
          sendBatch(listOf(ack(admitted), quote("AAPL", state.clock.get())), binary = true)
        }
      }) { state, app ->
        state.await { state.connections.get() == 2 && state.envelopes().any { it.string("source") == "ws" } }
        val published = state.envelopes().filter { it.string("source") == "ws" }
        assertEquals(1, published.size)
        assertEquals(JsonPrimitive(1), published.single()["seq"])
        assertEquals(2, state.requests.size)
        assertEquals(0, state.latestRequests.get())
        assertTrue(app.readinessInfo().alpacaMarketDataWs.authOk)
        assertTrue(app.readinessInfo().alpacaMarketDataWs.subscriptionOk)
      }
    }

  @Test
  fun `oversized IEX frames close the session before publication and recover with fresh admission`() =
    runBlocking {
      withForwarder(scenario = { state, connection ->
        if (connection == 1) {
          val oversized = JsonObject(quote("AAPL", state.clock.get()) + ("padding" to JsonPrimitive("x".repeat(1_048_576))))
          sendBatch(listOf(oversized))
        } else {
          assertEquals(2, connection)
          state.clock.incrementAndGet()
          sendBatch(listOf(quote("AAPL", state.clock.get())))
        }
      }) { state, app ->
        state.await { state.envelopes().any { it.string("source") == "ws" } }
        assertEquals(2, state.connections.get())
        val published = state.envelopes().filter { it.string("source") == "ws" }
        assertEquals(1, published.size)
        assertEquals(JsonPrimitive(1), published.single()["seq"])
        assertEquals(2, state.requests.size)
        assertEquals(0, state.latestRequests.get())
        assertTrue(app.readinessInfo().alpacaMarketDataWs.authOk)
        assertTrue(app.readinessInfo().alpacaMarketDataWs.subscriptionOk)
      }
    }

  private fun assertMembership(
    request: JsonObject,
    action: String,
    expected: Map<String, List<String>>,
  ) {
    assertEquals(JsonPrimitive(action), request["action"])
    assertEquals(expected.keys + "action", request.keys)
    expected.forEach { (channel, symbols) ->
      assertEquals(
        symbols.sorted(),
        request
          .getValue(channel)
          .let { it as JsonArray }
          .map { it.jsonPrimitive.content }
          .sorted(),
      )
    }
  }

  private fun ack(channels: Map<String, List<String>>): JsonObject =
    JsonObject(channels.mapValues { (_, symbols) -> JsonArray(symbols.map(::JsonPrimitive)) } + ("T" to JsonPrimitive("subscription")))

  private fun quote(
    symbol: String,
    time: Long,
  ): JsonObject =
    buildJsonObject {
      put("T", "q")
      put("S", symbol)
      put("bp", 100.0)
      put("bs", 1)
      put("ap", 101.0)
      put("as", 1)
      put("t", Instant.ofEpochMilli(time).toString())
    }

  private fun trade(
    symbol: String,
    time: Long,
    idOffset: Long = 0,
  ): JsonObject =
    buildJsonObject {
      put("T", "t")
      put("S", symbol)
      put("i", all.indexOf(symbol).toLong() + time + idOffset)
      put("p", 100.5)
      put("s", 1)
      put("t", Instant.ofEpochMilli(time).toString())
    }

  private fun bar(
    symbol: String,
    time: Long,
  ): JsonObject =
    buildJsonObject {
      put("T", "b")
      put("S", symbol)
      put("o", 100.0)
      put("h", 101.0)
      put("l", 100.0)
      put("c", 100.5)
      put("v", 1)
      put("t", Instant.ofEpochMilli(time).toString())
    }

  private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.content

  private suspend fun DefaultWebSocketServerSession.sendBatch(
    messages: List<JsonObject>,
    binary: Boolean = false,
  ) {
    val body = JsonArray(messages).toString()
    send(if (binary) Frame.Binary(true, body.toByteArray()) else Frame.Text(body))
  }

  private suspend fun DefaultWebSocketServerSession.request(state: ProviderState): JsonObject {
    val message = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
    state.requests += message
    return message
  }

  private class ProviderState {
    val clock = AtomicLong(Instant.parse("2026-11-12T15:00:00Z").toEpochMilli())
    val connections = AtomicInteger()
    val requests = ConcurrentLinkedQueue<JsonObject>()
    val latestRequests = AtomicInteger()
    val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
    val failure = CompletableDeferred<Throwable>()

    fun envelopes(): List<JsonObject> = records.map { Json.parseToJsonElement(it.value()).jsonObject }

    fun checkFailure() {
      if (failure.isCompleted) throw runBlocking { failure.await() }
    }

    suspend fun await(condition: () -> Boolean) {
      withTimeout(10_000) {
        while (!condition()) {
          checkFailure()
          delay(10)
        }
      }
      checkFailure()
    }
  }

  private suspend fun withForwarder(
    acknowledgeInitially: Boolean = true,
    scenario: suspend DefaultWebSocketServerSession.(ProviderState, Int) -> Unit,
    verify: suspend (ProviderState, ForwarderApp) -> Unit,
  ) {
    val state = ProviderState()
    val server =
      embeddedServer(CIO, port = 0) {
        install(WebSockets)
        routing {
          get("/v2/stocks/{channel}/latest") {
            state.latestRequests.incrementAndGet()
            call.respondText("{}", ContentType.Application.Json)
          }
          webSocket("/v2/iex") {
            val connection = state.connections.incrementAndGet()
            try {
              val auth = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
              assertEquals(JsonPrimitive("auth"), auth["action"])
              sendBatch(
                listOf(
                  buildJsonObject {
                    put("T", "success")
                    put("msg", "authenticated")
                  },
                ),
              )
              assertMembership(request(state), "subscribe", admitted)
              if (acknowledgeInitially) sendBatch(listOf(ack(admitted)))
              scenario(state, connection)
              for (frame in incoming) {
                if (frame is Frame.Text) state.requests += Json.parseToJsonElement(frame.readText()).jsonObject
              }
            } catch (failure: CancellationException) {
              throw failure
            } catch (_: ClosedReceiveChannelException) {
            } catch (failure: Throwable) {
              state.failure.complete(failure)
              throw failure
            }
          }
        }
      }.start(wait = false)
    val port = server.resolvedConnectors().single().port
    val producer = mockk<KafkaProducer<String, String>>(relaxed = true)
    val metadata = mockk<RecordMetadata>()
    every { producer.send(any<ProducerRecord<String, String>>(), any<Callback>()) } answers {
      state.records += firstArg<ProducerRecord<String, String>>()
      secondArg<Callback>().onCompletion(metadata, null)
      CompletableFuture.completedFuture(metadata)
    }
    val config =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "local-test-key",
          "ALPACA_SECRET_KEY" to "local-test-secret",
          "ALPACA_STREAM_URL" to "ws://127.0.0.1:$port",
          "ALPACA_BASE_URL" to "http://127.0.0.1:$port",
          "ALPACA_MARKET_DATA_CHANNELS" to "trades,quotes,bars",
          "SYMBOLS" to all.joinToString(","),
          "SYMBOLS_ALLOWLIST" to all.joinToString(","),
          "RECONNECT_BASE_MS" to "20",
          "RECONNECT_MAX_MS" to "40",
        ),
      )
    val client = HttpClient(ClientCIO) { install(ClientWebSockets) }
    val app = ForwarderApp(config, producerFactory = { producer }, nowMs = state.clock::get, httpClient = client)
    val job = app.start()
    try {
      verify(state, app)
    } finally {
      app.stop()
      try {
        withTimeout(5000) { job.join() }
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }
  }
}
