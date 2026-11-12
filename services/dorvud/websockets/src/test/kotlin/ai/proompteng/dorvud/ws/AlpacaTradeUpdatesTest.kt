package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.FrameTooBigException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.client.plugins.websocket.WebSockets as ClientWebSockets

class AlpacaTradeUpdatesTest {
  @Test
  fun `establishment deadline includes the HTTP upgrade`() =
    runBlocking {
      val requested = CompletableDeferred<Unit>()
      withServer(routes = {
        get("/stream") {
          requested.complete(Unit)
          awaitCancellation()
        }
      }) { client, url ->
        val result =
          async {
            runCatching {
              client.streamAlpacaTradeUpdates(url, "key", "secret", {}, {}, establishmentTimeoutMs = 300)
            }
          }
        withTimeout(3000) {
          requested.await()
          assertIs<BrokerStreamEstablishmentTimeoutException>(result.await().exceptionOrNull())
        }
      }
    }

  @Test
  fun `missing authorization or listening acknowledgement fails for reconnect and releases the socket`() =
    runBlocking {
      for (authenticated in listOf(false, true)) {
        val waiting = CompletableDeferred<Unit>()
        val disconnected = CompletableDeferred<Unit>()
        withServer(routes = {
          webSocket("/stream") {
            try {
              incoming.receive()
              if (authenticated) {
                send(Frame.Text("""{"stream":"authorization","data":{"status":"authorized"}}"""))
                incoming.receive()
              }
              waiting.complete(Unit)
              for (frame in incoming) Unit
            } finally {
              disconnected.complete(Unit)
            }
          }
        }) { client, url ->
          val result =
            async {
              runCatching {
                client.streamAlpacaTradeUpdates(url, "key", "secret", {}, {}, establishmentTimeoutMs = 300)
              }
            }
          withTimeout(3000) {
            waiting.await()
            assertIs<BrokerStreamEstablishmentTimeoutException>(result.await().exceptionOrNull())
            disconnected.await()
          }
        }
      }
    }

  @Test
  fun `listening acknowledgement releases deadline before publication and healthy session lifetime`() =
    runBlocking {
      val publishing = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      val update = CompletableDeferred<AlpacaTradeUpdate>()
      val source = """{"stream":"trade_updates","data":{"event":"fill","price":"123.450000"}}"""
      withServer(routes = {
        webSocket("/stream") {
          acknowledge()
          send(Frame.Binary(true, source.toByteArray()))
          for (frame in incoming) Unit
        }
      }) { client, url ->
        val collection =
          async {
            client.streamAlpacaTradeUpdates(url, "key", "secret", onReady = {
              publishing.complete(Unit)
              release.await()
            }, onUpdate = { update.complete(it) }, establishmentTimeoutMs = 300)
          }
        try {
          withTimeout(3000) {
            publishing.await()
            delay(600)
            assertTrue(collection.isActive)
            release.complete(Unit)
            assertEquals(source, update.await().frameJson)
          }
        } finally {
          collection.cancelAndJoin()
        }
      }
    }

  @Test
  fun `caller cancellation during establishment is not converted to reconnect failure`() =
    runBlocking {
      val disconnected = CompletableDeferred<Unit>()
      withServer(routes = {
        webSocket("/stream") {
          try {
            incoming.receive()
            for (frame in incoming) Unit
          } finally {
            disconnected.complete(Unit)
          }
        }
      }) { client, url ->
        val result =
          withTimeoutOrNull(300) {
            client.streamAlpacaTradeUpdates(url, "key", "secret", {}, {}, establishmentTimeoutMs = 10_000)
          }
        assertNull(result)
        withTimeout(3000) { disconnected.await() }
      }
    }

  @Test
  fun `byte limit rejects a UTF8 frame below the old character limit before decoding`() =
    runBlocking {
      val oversized = """{"stream":"trade_updates","data":{"note":"${"é".repeat(150_000)}"}}"""
      assertTrue(oversized.length < ALPACA_TRADE_UPDATE_MAX_FRAME_BYTES)
      assertTrue(oversized.toByteArray().size > ALPACA_TRADE_UPDATE_MAX_FRAME_BYTES)
      withServer(routes = {
        webSocket("/stream") {
          acknowledge()
          send(Frame.Binary(true, oversized.toByteArray()))
          for (frame in incoming) Unit
        }
      }) { client, url ->
        val result =
          runCatching {
            withTimeout(3000) {
              client.streamAlpacaTradeUpdates(url, "key", "secret", {}, { error("oversized frame reached consumer") })
            }
          }
        val failure = result.exceptionOrNull()
        assertTrue(
          failure is FrameTooBigException ||
            (failure is IllegalArgumentException && failure.message == "broker frame exceeds the source limit"),
          "Expected the transport or pre-decode byte guard to reject the frame; received $failure",
        )
      }
    }

  private suspend fun io.ktor.server.websocket.DefaultWebSocketServerSession.acknowledge() {
    incoming.receive()
    send(Frame.Text("""{"stream":"authorization","data":{"status":"authorized"}}"""))
    incoming.receive()
    send(Frame.Text("""{"stream":"listening","data":{"streams":["trade_updates"]}}"""))
  }

  private suspend fun withServer(
    routes: Route.() -> Unit,
    test: suspend (HttpClient, String) -> Unit,
  ) {
    val server =
      embeddedServer(CIO, port = 0) {
        install(WebSockets)
        routing(routes)
      }.start(wait = false)
    val client = HttpClient(ClientCIO) { install(ClientWebSockets) }
    try {
      test(client, "ws://127.0.0.1:${server.resolvedConnectors().single().port}/stream")
    } finally {
      client.close()
      server.stop(0, 1000)
    }
  }
}
