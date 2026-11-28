package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull

private const val WEBSOCKET_CLOSE_TIMEOUT_MS = 5_000L

internal suspend fun HttpClient.webSocketWithBoundedCleanup(
  request: HttpRequestBuilder.() -> Unit,
  block: suspend DefaultClientWebSocketSession.() -> Unit,
) {
  webSocket(request) {
    try {
      block()
    } finally {
      try {
        closeWithinDeadline()
      } finally {
        // HttpStatement cleanup joins the upgrade call's raw transport Job.
        // Cancel that owned call too, so a stuck raw writer cannot pin its join.
        call.cancel()
      }
    }
  }
}

internal suspend fun WebSocketSession.closeWithinDeadline(timeoutMs: Long = WEBSOCKET_CLOSE_TIMEOUT_MS) {
  require(timeoutMs > 0) { "WebSocket close timeout must be positive" }
  try {
    // Ktor 2.3.12 closes before cancelling incoming. Its close() can wait forever
    // in send/flush and swallows cancellation, preventing the caller from retrying.
    withTimeoutOrNull(timeoutMs) { close() }
  } finally {
    // Cancel this session's Job, never the application/reconnect loop's Job.
    // Closing both channels also makes Ktor's subsequent close() non-blocking.
    coroutineContext.cancel()
    incoming.cancel()
    outgoing.close()
  }
  // close() catches Throwable, including cancellation of the enclosing caller.
  currentCoroutineContext().ensureActive()
}
