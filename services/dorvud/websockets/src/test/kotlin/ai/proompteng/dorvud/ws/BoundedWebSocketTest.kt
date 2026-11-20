package ai.proompteng.dorvud.ws

import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketExtension
import io.ktor.websocket.WebSocketSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class, DelicateCoroutinesApi::class)
class BoundedWebSocketTest {
  @Test
  fun `blocked close enqueue is bounded and cancels only the session`() =
    runBlocking {
      val session = Session(outgoingCapacity = Channel.RENDEZVOUS)
      val caller = currentCoroutineContext().job
      withTimeout(2000) { session.closeWithinDeadline(30) }
      assertTrue(caller.isActive)
      session.assertClosed()
    }

  @Test
  fun `blocked close flush remains bounded when Ktor swallows timeout cancellation`() =
    runBlocking {
      val session = Session(stallFlush = true)
      val caller = currentCoroutineContext().job
      withTimeout(2000) { session.closeWithinDeadline(30) }
      assertTrue(session.flushStarted.isCompleted)
      assertTrue(caller.isActive)
      session.assertClosed()
    }

  @Test
  fun `successful graceful close still releases the session and both channels`() =
    runBlocking {
      val session = Session()
      withTimeout(2000) { session.closeWithinDeadline(1000) }
      assertTrue(session.flushStarted.isCompleted)
      session.assertClosed()
    }

  @Test
  fun `parent cancellation is propagated unchanged and releases the session immediately`() =
    runBlocking {
      val session = Session(stallFlush = true)
      val seen = CompletableDeferred<CancellationException>()
      val cancellation = CancellationException("parent stopped")
      val caller =
        launch {
          try {
            session.closeWithinDeadline(10_000)
          } catch (error: CancellationException) {
            seen.complete(error)
            throw error
          }
        }
      withTimeout(2000) { session.flushStarted.await() }
      caller.cancel(cancellation)
      withTimeout(2000) { caller.join() }
      assertOriginalFailure(cancellation, withTimeout(2000) { seen.await() })
      session.assertClosed()
    }

  @Test
  fun `bounded cleanup preserves the original session failure`() =
    runBlocking {
      val session = Session(stallFlush = true)
      val failure = IOException("session disconnected")
      val seen =
        assertFailsWith<IOException> {
          withTimeout(2000) {
            try {
              throw failure
            } finally {
              session.closeWithinDeadline(30)
            }
          }
        }
      assertOriginalFailure(failure, seen)
      session.assertClosed()
    }

  private fun assertOriginalFailure(
    expected: Throwable,
    actual: Throwable,
  ) {
    assertEquals(expected::class, actual::class)
    assertEquals(expected.message, actual.message)
    // Coroutine stack recovery may copy an exception, retaining the original cause.
    assertTrue(generateSequence(actual) { it.cause }.any { it === expected })
  }

  private class Session(
    outgoingCapacity: Int = Channel.UNLIMITED,
    private val stallFlush: Boolean = false,
  ) : WebSocketSession {
    val lifecycle = Job()
    val flushStarted = CompletableDeferred<Unit>()
    override val coroutineContext = lifecycle
    override var masking = true
    override var maxFrameSize = Long.MAX_VALUE
    override val incoming = Channel<Frame>(Channel.UNLIMITED)
    override val outgoing = Channel<Frame>(outgoingCapacity)
    override val extensions = emptyList<WebSocketExtension<*>>()

    override suspend fun flush() {
      flushStarted.complete(Unit)
      if (stallFlush) awaitCancellation()
    }

    @Deprecated("Use cancel()")
    override fun terminate() {
      lifecycle.cancel()
    }

    fun assertClosed() {
      assertTrue(lifecycle.isCancelled)
      assertTrue(incoming.isClosedForReceive)
      assertTrue(outgoing.isClosedForSend)
    }
  }
}
