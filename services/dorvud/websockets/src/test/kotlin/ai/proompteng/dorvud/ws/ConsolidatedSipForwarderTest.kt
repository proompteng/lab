package ai.proompteng.dorvud.ws

import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSocketServerSession
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.apache.kafka.clients.producer.Callback
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConsolidatedSipForwarderTest {
  @Test
  fun `publishes only admitted SIP events with universe provenance and the same feed for REST recovery`() =
    runBlocking {
      val recoveryFeeds = ConcurrentLinkedQueue<Pair<String, String?>>()
      val server =
        embeddedServer(CIO, port = 0) {
          install(WebSockets)
          routing {
            get("/v2/stocks/bars") {
              recoveryFeeds += "bars" to call.request.queryParameters["feed"]
              call.respondText("""{"bars":{"SPY":[{"t":"2026-11-12T14:29:00Z","o":100,"h":101,"l":100,"c":101,"v":50}]}}""")
            }
            get("/v2/stocks/trades") {
              recoveryFeeds += "trades" to call.request.queryParameters["feed"]
              call.respondText("""{"trades":{"SPY":[{"t":"2026-11-12T14:29:59Z","p":100,"s":1,"i":1}]}}""")
            }
            webSocket("/v2/sip") {
              val request = authenticateAndSubscribe()
              assertEquals(setOf("action", "bars", "quotes", "trades"), request.keys)
              for (channel in listOf("bars", "quotes", "trades")) {
                assertEquals(sip73Symbols, request.getValue(channel).jsonArray.map { it.jsonPrimitive.content })
              }
              // An early trade with the same ID as the later valid trade must not consume its sequence or dedup entry.
              send(Frame.Text("[$liveTrade]"))
              acknowledge(request)
              send(Frame.Text("""[{"T":"t","S":"NOT_IN_ROSTER","t":"$liveTimestamp","p":101,"s":1,"i":3}]"""))
              send(Frame.Text("[{\"T\":\"u\",$liveBar}]"))
              send(
                Frame.Text(
                  """[{"T":"b",$liveBar},{"T":"q","S":"SPY","t":"$liveTimestamp","bp":100,"bs":100,"ap":101,"as":100},$liveTrade]""",
                ),
              )
              for (frame in incoming) Unit
            }
          }
        }.start(wait = false)
      val records = Channel<ProducerRecord<String, String>>(Channel.UNLIMITED)
      val port = server.resolvedConnectors().single().port
      val config =
        ForwarderConfig.fromEnv(
          sipTestEnv(hash = SIP_73_SYMBOL_HASH) +
            mapOf(
              "ALPACA_MAX_SYMBOL_CHANNELS" to "219",
              "ALPACA_STREAM_URL" to "ws://127.0.0.1:$port",
              "ALPACA_BASE_URL" to "http://127.0.0.1:$port",
              "ENABLE_BARS_BACKFILL" to "true",
              "ENABLE_TRADES_BACKFILL" to "true",
            ),
        )
      val now = Instant.parse("2026-11-12T14:32:00Z").toEpochMilli()
      val app = ForwarderApp(config, { producer(records) }, nowMs = { now })
      val job = app.start()
      try {
        val read = withTimeout(10000) { List(5) { records.receive() } }
        val emitted =
          read.map { record ->
            val wire = Json.parseToJsonElement(record.value()).jsonObject
            assertEquals(JsonPrimitive("real_time_consolidated"), wire["delay_class"])
            assertFalse("delayClass" in wire)
            assertEquals(JsonPrimitive("sip"), wire["feed"])
            assertEquals(JsonPrimitive(config.universeContract?.id), wire["universe_id"])
            assertEquals(JsonPrimitive(SIP_73_SYMBOL_HASH), wire["universe_symbol_hash"])
            assertEquals(JsonPrimitive("SPY"), wire["symbol"])
            assertEquals("SPY", record.key())
            val channel = wire.getValue("channel").jsonPrimitive.content
            val suffix = if (channel == "bars") "bars.1m" else channel
            assertEquals("bayn.market-data.sip.$suffix.v1", record.topic())
            wire.getValue("source").jsonPrimitive.content to channel
          }
        assertEquals(setOf("ws" to "bars", "ws" to "quotes", "ws" to "trades", "rest" to "bars", "rest" to "trades"), emitted.toSet())
        assertEquals(setOf("bars" to "sip", "trades" to "sip"), recoveryFeeds.toSet())
        val readiness = app.readinessInfo()
        assertTrue(readiness.alpacaMarketDataWs.subscriptionOk)
        assertEquals(73, readiness.alpacaMarketDataWs.subscribedSymbolCount)
        assertEquals(SIP_73_SYMBOL_HASH, readiness.marketDataUniverse?.symbolHash)
        assertTrue(records.tryReceive().isFailure)
      } finally {
        app.stop()
        withTimeout(5000) { job.join() }
        server.stop(0, 1000)
      }
    }

  @Test
  fun `fails closed on provider admission errors before auth or after subscribe`() =
    runBlocking {
      for ((code, errorClass) in listOf(
        405 to ReadinessErrorClass.Alpaca405SymbolLimit,
        406 to ReadinessErrorClass.Alpaca406SecondConnection,
        409 to ReadinessErrorClass.Alpaca409InsufficientSubscription,
      )) {
        val connections = AtomicInteger()
        val server =
          embeddedServer(CIO, port = 0) {
            install(WebSockets)
            routing {
              webSocket("/v2/sip") {
                connections.incrementAndGet()
                val error = """{"T":"error","code":$code,"msg":"admission rejected"}"""
                if (code == 405) {
                  val request = authenticateAndSubscribe()
                  // Discard the whole frame even if it contains a complete ack and usable data before the error.
                  val ack = subscriptionAck(request)
                  send(Frame.Text("[$ack,$liveTrade,$error]"))
                } else {
                  if (code != 406) incoming.receive()
                  send(Frame.Text("[$error]"))
                }
                for (frame in incoming) Unit
              }
            }
          }.start(wait = false)
        val records = Channel<ProducerRecord<String, String>>(Channel.UNLIMITED)
        val port = server.resolvedConnectors().single().port
        val config =
          ForwarderConfig.fromEnv(
            sipTestEnv(listOf("SPY")) +
              mapOf(
                "ALPACA_STREAM_URL" to "ws://127.0.0.1:$port",
                "RECONNECT_BASE_MS" to "20",
                "RECONNECT_MAX_MS" to "40",
              ),
          )
        val app = ForwarderApp(config, { producer(records) })
        val job = app.start()
        try {
          withTimeout(5000) { job.join() }
          assertEquals(1, connections.get())
          assertTrue(records.tryReceive().isFailure)
          val readiness = app.readinessInfo()
          assertFalse(readiness.ready)
          assertFalse(readiness.alpacaMarketDataWs.authOk)
          assertFalse(readiness.alpacaMarketDataWs.subscriptionOk)
          assertEquals(errorClass.id, readiness.errorClass)
          assertEquals(errorClass.id, readiness.alpacaMarketDataWs.errorClass)
        } finally {
          app.stop()
          withTimeout(5000) { job.join() }
          server.stop(0, 1000)
        }
      }
    }

  private fun producer(records: Channel<ProducerRecord<String, String>>): KafkaProducer<String, String> {
    val producer = mockk<KafkaProducer<String, String>>(relaxed = true)
    val metadata = mockk<RecordMetadata>()
    every { producer.send(any<ProducerRecord<String, String>>(), any<Callback>()) } answers {
      check(records.trySend(firstArg<ProducerRecord<String, String>>()).isSuccess)
      secondArg<Callback>().onCompletion(metadata, null)
      CompletableFuture.completedFuture(metadata)
    }
    return producer
  }

  private suspend fun WebSocketServerSession.authenticateAndSubscribe(): JsonObject {
    val auth = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
    assertEquals(JsonPrimitive("auth"), auth["action"])
    send(Frame.Text("""[{"T":"success","msg":"authenticated"}]"""))
    val request = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
    assertEquals(JsonPrimitive("subscribe"), request["action"])
    return request
  }

  private fun subscriptionAck(request: JsonObject): JsonObject = JsonObject(request - "action" + ("T" to JsonPrimitive("subscription")))

  private suspend fun WebSocketServerSession.acknowledge(request: JsonObject) {
    send(Frame.Text(JsonArray(listOf(subscriptionAck(request))).toString()))
  }

  private val liveTimestamp = "2026-11-12T14:30:00Z"
  private val liveTrade = """{"T":"t","S":"SPY","t":"$liveTimestamp","p":101,"s":1,"i":2}"""
  private val liveBar = """"S":"SPY","t":"$liveTimestamp","o":100,"h":101,"l":100,"c":101,"v":50"""
}
