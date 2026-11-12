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
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.client.plugins.websocket.WebSockets as ClientWebSockets

class VerifiedBrokerFeedTest {
  private val accountId = "00000000-0000-4000-8000-000000000001"
  private val frame =
    """
    {"stream":"trade_updates","data":{
      "event":"partial_fill","timestamp":"2026-11-11T17:37:18.784802123Z",
      "price":"123.450000","order":{"id":"order-one"}
    }}
    """.trimIndent()

  @Test
  fun `shared golden notification matches TypeScript identity and exact-byte signature`() {
    val fixture = Json.parseToJsonElement(File("../fixtures/bayn-broker-notification-v1.json").readText()).jsonObject
    val signed = fixture.getValue("notification").jsonObject
    val message = signed.getValue("message").jsonPrimitive.content
    val protocolJson = Json { classDiscriminator = "_tag" }
    val notification = protocolJson.decodeFromString<BrokerFeedNotification>(message)
    assertEquals(fixture.getValue("key").jsonPrimitive.content, brokerFeedIdentityHash(accountId))
    val result = signBrokerNotification(notification, fixture.getValue("secret").jsonPrimitive.content)
    assertEquals(message, result.message)
    assertEquals(signed.getValue("signature").jsonPrimitive.content, result.signature)
    // Exercise the producer's default JSON serializer, including the required outer version.
    assertEquals(signed, Json.parseToJsonElement(Json.encodeToString(result)))
  }

  @Test
  fun `verified subscription precedes signed publication and raw binary update is retained`() =
    runBlocking {
      val requests = ConcurrentLinkedQueue<String>()
      val records = ConcurrentLinkedQueue<Pair<String, SignedBrokerNotification>>()
      val complete = CompletableDeferred<Unit>()
      val server =
        embeddedServer(CIO, port = 0) {
          install(WebSockets)
          routing {
            get("/v2/account") {
              requests += "${call.request.headers["APCA-API-KEY-ID"]}:${call.request.headers["APCA-API-SECRET-KEY"]}"
              call.respondText("""{"id":"$accountId"}""", ContentType.Application.Json)
            }
            webSocket("/stream") {
              val auth = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
              requests += "${auth.getValue("key").jsonPrimitive.content}:${auth.getValue("secret").jsonPrimitive.content}"
              send(Frame.Text("""{"stream":"authorization","data":{"status":"authorized"}}"""))
              val listen = Json.parseToJsonElement((incoming.receive() as Frame.Text).readText()).jsonObject
              assertEquals("listen", listen.getValue("action").jsonPrimitive.content)
              assertEquals(0, records.size)
              send(Frame.Text("""{"stream":"listening","data":{"streams":["trade_updates"]}}"""))
              send(Frame.Binary(true, frame.toByteArray()))
              awaitCancellation()
            }
          }
        }.start(wait = false)
      val port = server.resolvedConnectors().single().port
      val client = HttpClient(ClientCIO) { install(ClientWebSockets) }
      val feed =
        VerifiedBrokerFeed(
          connection(port),
          client,
          publish = { key, notification ->
            records += key to notification
            if (records.size == 2) complete.complete(Unit)
          },
          now = { Instant.parse("2026-11-11T17:37:19Z") },
          newSessionId = { "session-one" },
        )
      val job = launch { feed.collect() }
      try {
        withTimeout(5000) { complete.await() }
        assertEquals(listOf("test-key:test-secret", "test-key:test-secret"), requests.toList())
        assertTrue(records.all { it.first == brokerFeedIdentityHash(accountId) })
        val notifications = records.map { Json.parseToJsonElement(it.second.message).jsonObject }
        assertEquals(listOf("SessionReady", "TradeUpdate"), notifications.map { it.getValue("_tag").jsonPrimitive.content })
        assertEquals(
          frame,
          notifications
            .last()
            .getValue("frameJson")
            .jsonPrimitive.content,
        )
        val session = notifications.last().getValue("session").jsonObject
        assertEquals(accountId, session.getValue("accountId").jsonPrimitive.content)
        assertEquals("2026-11-11T17:37:19.000Z", session.getValue("verifiedAt").jsonPrimitive.content)
        assertEquals(brokerFeedSha256("test-key"), session.getValue("credentialHash").jsonPrimitive.content)
        assertTrue(records.all { it.second.signature.matches(Regex("[a-f0-9]{64}")) })
        assertNotEquals(records.first().second.signature, records.last().second.signature)
      } finally {
        job.cancelAndJoin()
        client.close()
        server.stop(0, 1000)
      }
    }

  @Test
  fun `wrong provider account prevents opening the websocket or publishing`() =
    runBlocking {
      val opened = AtomicInteger()
      val published = AtomicInteger()
      val server =
        embeddedServer(CIO, port = 0) {
          install(WebSockets)
          routing {
            get("/v2/account") { call.respondText("""{"id":"another-account"}""") }
            webSocket("/stream") { opened.incrementAndGet() }
          }
        }.start(wait = false)
      val client = HttpClient(ClientCIO) { install(ClientWebSockets) }
      try {
        val feed =
          VerifiedBrokerFeed(
            connection(server.resolvedConnectors().single().port),
            client,
            { _, _ -> published.incrementAndGet() },
          )
        withTimeout(5000) { assertFailsWith<IllegalStateException> { feed.collect() } }
        assertEquals(0, opened.get())
        assertEquals(0, published.get())
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }

  @Test
  fun `subscription acknowledgement must include trade updates`() =
    runBlocking {
      val published = AtomicInteger()
      val server =
        embeddedServer(CIO, port = 0) {
          install(WebSockets)
          routing {
            get("/v2/account") { call.respondText("""{"id":"$accountId"}""") }
            webSocket("/stream") {
              incoming.receive()
              send(Frame.Text("""{"stream":"authorization","data":{"status":"authorized"}}"""))
              incoming.receive()
              send(Frame.Text("""{"stream":"listening","data":{"streams":[]}}"""))
              awaitCancellation()
            }
          }
        }.start(wait = false)
      val client = HttpClient(ClientCIO) { install(ClientWebSockets) }
      try {
        val feed =
          VerifiedBrokerFeed(
            connection(server.resolvedConnectors().single().port),
            client,
            { _, _ -> published.incrementAndGet() },
          )
        withTimeout(5000) { assertFailsWith<IllegalStateException> { feed.collect() } }
        assertEquals(0, published.get())
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }

  @Test
  fun `failed publication ends the session and identical redelivery is published after reconnect`() =
    runBlocking {
      val updates = ConcurrentLinkedQueue<SignedBrokerNotification>()
      val ready = ConcurrentLinkedQueue<SignedBrokerNotification>()
      val sessions = AtomicInteger()
      val complete = CompletableDeferred<Unit>()
      val server =
        embeddedServer(CIO, port = 0) {
          install(WebSockets)
          routing {
            get("/v2/account") { call.respondText("""{"id":"$accountId"}""") }
            webSocket("/stream") {
              incoming.receive()
              send(Frame.Text("""{"stream":"authorization","data":{"status":"authorized"}}"""))
              incoming.receive()
              send(Frame.Text("""{"stream":"listening","data":{"streams":["trade_updates"]}}"""))
              send(Frame.Binary(true, frame.toByteArray()))
              awaitCancellation()
            }
          }
        }.start(wait = false)
      val client = HttpClient(ClientCIO) { install(ClientWebSockets) }
      val feed =
        VerifiedBrokerFeed(
          connection(server.resolvedConnectors().single().port),
          client,
          publish = { _, notification ->
            val message = Json.parseToJsonElement(notification.message).jsonObject
            if (message.getValue("_tag").jsonPrimitive.content == "SessionReady") {
              ready += notification
            } else {
              updates += notification
              if (updates.size == 1) throw IOException("test publication failure")
              complete.complete(Unit)
            }
          },
          newSessionId = { "session-${sessions.incrementAndGet()}" },
        )
      try {
        withTimeout(5000) { assertFailsWith<IOException> { feed.collect() } }
        val job = launch { feed.collect() }
        try {
          withTimeout(5000) { complete.await() }
          assertEquals(2, ready.size)
          assertEquals(2, updates.size)
          val ids =
            updates.map {
              Json
                .parseToJsonElement(it.message)
                .jsonObject
                .getValue("eventId")
                .jsonPrimitive.content
            }
          assertEquals(ids.first(), ids.last())
          assertNotEquals(ready.first().message, ready.last().message)
        } finally {
          job.cancelAndJoin()
        }
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }

  private fun connection(port: Int) =
    BrokerFeedConnection(
      accountId = accountId,
      keyId = "test-key",
      secretKey = "test-secret",
      sourceRevision = "a".repeat(40),
      accountUrl = "http://127.0.0.1:$port/v2/account",
      streamUrl = "ws://127.0.0.1:$port/stream",
    )
}
