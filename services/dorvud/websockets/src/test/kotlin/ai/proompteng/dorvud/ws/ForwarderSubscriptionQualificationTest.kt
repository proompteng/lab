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

class ForwarderSubscriptionQualificationTest {
  private val all =
    listOf("AAPL", "AMD", "AMZN", "AVGO", "COHR", "CRDO", "IWM", "LITE", "MRVL", "MU", "NVDA", "QQQ", "SMH", "SNDK", "SPY", "WDC")
  private val baseline = listOf("AAPL", "AMZN", "IWM", "NVDA", "QQQ", "SMH", "SPY")
  private val candidates = all.filterNot { it in baseline }
  private val admitted = mapOf("trades" to baseline, "quotes" to baseline, "bars" to all)
  private val target = mapOf("trades" to all, "quotes" to all, "bars" to all)
  private val additions = mapOf("trades" to candidates, "quotes" to candidates)

  @Test
  fun `one connection accepts full ACK while text and binary candidate frames never enter Kafka`() =
    runBlocking {
      val rolledBack = CompletableDeferred<Unit>()
      withForwarder(scenario = { state, connection ->
        assertEquals(1, connection)
        assertMembership(request(state), "subscribe", additions)
        sendBatch(
          listOf(
            quote("AMD", state.clock.get()),
            quote("XYZ", state.clock.get()),
            JsonObject(bar("AAPL", state.clock.get()) + ("T" to JsonPrimitive("u"))),
          ),
        )
        sendBatch(listOf(ack(target)), binary = true)
        repeat(27) { step ->
          val receivedAt = state.clock.get()
          val marker = receivedAt + 1000 + all.indexOf("SPY")
          val events =
            all.flatMap { listOf(quote(it, receivedAt), trade(it, receivedAt), bar(it, receivedAt)) } + trade("SPY", receivedAt, 1000)
          sendBatch(events.take(21))
          sendBatch(events.drop(21), binary = true)
          state.await {
            state.envelopes().any {
              it.string(
                "source",
              ) == "ws" && it["payload"]?.jsonObject?.get("i") == JsonPrimitive(marker)
            }
          }
          if (step < 26) state.clock.addAndGet(5000)
        }
        state.clock.incrementAndGet()
        sendBatch(listOf(quote("AAPL", state.clock.get())))
        assertMembership(request(state), "unsubscribe", additions)
        sendBatch(listOf(ack(admitted)))
        sendBatch(listOf(quote("AMD", state.clock.get()), trade("WDC", state.clock.get()), quote("SPY", state.clock.get())))
        rolledBack.complete(Unit)
      }) { state, app ->
        state.await {
          rolledBack.isCompleted && app.readinessInfo().subscriptionQualification?.phase == "finished" &&
            state.envelopes().any {
              it.string(
                "source",
              ) == "rest_latest" && it.string("symbol") == "AMD"
            }
        }
        assertEquals(1, state.connections.get())
        assertEquals(3, state.requests.size)
        assertAdmittedReadiness(app)
        assertDiagnosticAdmission(state)
        val ws = app.readinessInfo().alpacaMarketDataWs
        assertTrue(ws.authOk)
        assertTrue(ws.subscriptionOk)
        assertEquals(admitted, ws.subscribedSymbolsByChannel)
        val qualification = assertNotNull(app.readinessInfo().subscriptionQualification)
        assertTrue(
          qualification.qualified,
          "${qualification.phase}: ${qualification.outcome}; incomplete=${qualification.incompleteSymbolsByChannel}",
        )
        assertTrue(
          state.envelopes().any {
            it.string("source") == "ws" && it.string("channel") == "bars" && it.string("symbol") == "AMD"
          },
        )
      }
    }

  @Test
  fun `trial 405 preserves the admitted baseline without losing auth or reconnecting`() =
    runBlocking {
      val rejected = CompletableDeferred<Unit>()
      withForwarder(scenario = { state, connection ->
        assertEquals(1, connection)
        assertMembership(request(state), "subscribe", additions)
        sendBatch(
          listOf(
            buildJsonObject {
              put("T", "error")
              put("code", 405)
              put("msg", "symbol limit exceeded")
            },
          ),
        )
        sendBatch(listOf(quote("AMD", state.clock.get()), trade("AAPL", state.clock.get())))
        rejected.complete(Unit)
      }) { state, app ->
        state.await { rejected.isCompleted && state.envelopes().any { it.string("source") == "ws" && it.string("symbol") == "AAPL" } }
        delay(250)
        state.checkFailure()
        assertEquals(1, state.connections.get())
        assertEquals(2, state.requests.size)
        assertTrue(app.readinessInfo().alpacaMarketDataWs.authOk)
        assertTrue(app.readinessInfo().alpacaMarketDataWs.subscriptionOk)
        assertEquals(admitted, app.readinessInfo().alpacaMarketDataWs.subscribedSymbolsByChannel)
        assertAdmittedReadiness(app)
        assertDiagnosticAdmission(state)
      }
    }

  @Test
  fun `partial candidate ACK removes only added quote and trade memberships and fences buffered data`() =
    runBlocking {
      val rolledBack = CompletableDeferred<Unit>()
      withForwarder(scenario = { state, connection ->
        assertEquals(1, connection)
        assertMembership(request(state), "subscribe", additions)
        sendBatch(listOf(ack(admitted + ("quotes" to (baseline + "AMD").sorted()))))
        assertMembership(request(state), "unsubscribe", additions)
        sendBatch(listOf(quote("AMD", state.clock.get()), trade("WDC", state.clock.get())), binary = true)
        sendBatch(listOf(ack(admitted)))
        sendBatch(listOf(quote("AMD", state.clock.get()), trade("WDC", state.clock.get()), bar("AMD", state.clock.get())))
        rolledBack.complete(Unit)
      }) { state, app ->
        state.await { rolledBack.isCompleted && state.envelopes().any { it.string("source") == "ws" && it.string("channel") == "bars" } }
        delay(100)
        assertEquals(1, state.connections.get())
        assertEquals(3, state.requests.size)
        assertAdmittedReadiness(app)
        assertDiagnosticAdmission(state)
        assertEquals(admitted, app.readinessInfo().alpacaMarketDataWs.subscribedSymbolsByChannel)
      }
    }

  @Test
  fun `delayed candidate ACK after timeout closes coherently then reconnects only the baseline`() =
    runBlocking {
      val baselineRecovered = CompletableDeferred<Unit>()
      withForwarder(scenario = { state, connection ->
        if (connection == 1) {
          assertMembership(request(state), "subscribe", additions)
          state.clock.addAndGet(10_001)
          sendBatch(listOf(quote("AAPL", state.clock.get())))
          assertMembership(request(state), "unsubscribe", additions)
          sendBatch(listOf(ack(target)), binary = true)
        } else {
          assertEquals(2, connection)
          sendBatch(listOf(quote("AMD", state.clock.get()), trade("AAPL", state.clock.get())))
          baselineRecovered.complete(Unit)
        }
      }) { state, app ->
        state.await { baselineRecovered.isCompleted && app.readinessInfo().alpacaMarketDataWs.subscriptionOk }
        delay(250)
        state.checkFailure()
        assertEquals(2, state.connections.get())
        assertEquals(4, state.requests.size)
        assertEquals(1, state.requests.count { it["action"] == JsonPrimitive("subscribe") && "bars" !in it })
        assertAdmittedReadiness(app)
        assertDiagnosticAdmission(state)
        assertEquals(admitted, app.readinessInfo().alpacaMarketDataWs.subscribedSymbolsByChannel)
      }
    }

  @Test
  fun `disconnect before candidate ACK and slow client error never repeat the trial after reconnect`() =
    runBlocking {
      for (providerError in listOf<Int?>(null, 407)) {
        val baselineRecovered = CompletableDeferred<Unit>()
        withForwarder(scenario = { state, connection ->
          if (connection == 1) {
            assertMembership(request(state), "subscribe", additions)
            if (providerError == null) {
              close(CloseReason(CloseReason.Codes.GOING_AWAY, "test disconnect"))
            } else {
              sendBatch(
                listOf(
                  buildJsonObject {
                    put("T", "error")
                    put("code", providerError)
                    put("msg", "slow client")
                  },
                ),
              )
            }
          } else {
            assertEquals(2, connection)
            sendBatch(listOf(quote("AMD", state.clock.get()), trade("AAPL", state.clock.get())))
            baselineRecovered.complete(Unit)
          }
        }) { state, app ->
          state.await { baselineRecovered.isCompleted && app.readinessInfo().alpacaMarketDataWs.subscriptionOk }
          delay(250)
          state.checkFailure()
          assertEquals(2, state.connections.get())
          assertEquals(3, state.requests.size)
          assertEquals(1, state.requests.count { it["action"] == JsonPrimitive("subscribe") && "bars" !in it })
          assertAdmittedReadiness(app)
          assertDiagnosticAdmission(state)
        }
      }
    }

  private fun assertAdmittedReadiness(app: ForwarderApp) {
    val channels = app.readinessInfo().marketDataChannels.filter { it.channel in listOf("quotes", "trades") }
    assertEquals(setOf("quotes", "trades"), channels.map { it.channel }.toSet())
    for (channel in channels) {
      assertEquals(baseline.toSet(), channel.subscribedSymbols.toSet())
      assertTrue(channel.observedSymbols.all { it in baseline })
      assertTrue(channel.freshSymbols.all { it in baseline })
    }
  }

  private fun assertDiagnosticAdmission(state: ProviderState) {
    val published = state.envelopes()
    assertTrue(
      published.filter { it.string("source") == "ws" && it.string("channel") in listOf("quotes", "trades") }.all {
        it.string("symbol") in
          baseline
      },
    )
    assertFalse(
      published.any {
        it.string("source") == "ws" && it.string("channel") in listOf("quotes", "trades") &&
          it.string("symbol") in candidates
      },
    )
    assertFalse(published.any { it.string("source") == "ws" && it.string("symbol") == "XYZ" })
    assertFalse(published.any { it.string("source") == "ws" && it.string("channel") == "updatedBars" })
    assertFalse(published.any { it.string("source") == "ws" && it["payload"]?.jsonObject?.get("T") == JsonPrimitive("u") })
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
    scenario: suspend DefaultWebSocketServerSession.(ProviderState, Int) -> Unit,
    verify: suspend (ProviderState, ForwarderApp) -> Unit,
  ) {
    val state = ProviderState()
    val server =
      embeddedServer(CIO, port = 0) {
        install(WebSockets)
        routing {
          get("/v2/stocks/{channel}/latest") {
            val channel = call.parameters["channel"]
            val values =
              candidates.associateWith {
                if (channel ==
                  "quotes"
                ) {
                  quote(it, state.clock.get())
                } else {
                  trade(it, state.clock.get())
                }
              }
            call.respondText(JsonObject(mapOf(requireNotNull(channel) to JsonObject(values))).toString(), ContentType.Application.Json)
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
              sendBatch(listOf(ack(admitted)))
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
          "ALPACA_MARKET_DATA_TRADES_SYMBOLS" to baseline.joinToString(","),
          "ALPACA_MARKET_DATA_QUOTES_SYMBOLS" to baseline.joinToString(","),
          "ALPACA_LATEST_SYMBOLS" to candidates.joinToString(","),
          "ALPACA_LATEST_POLL_INTERVAL_MS" to "60000",
          "ALPACA_IEX_SUBSCRIPTION_QUALIFICATION" to "true",
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
