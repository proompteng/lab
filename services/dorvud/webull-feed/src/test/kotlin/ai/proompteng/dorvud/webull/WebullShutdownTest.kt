package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullCapture
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.webullCapture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals

class WebullShutdownTest {
  @Test
  fun `cancelling input ownership still drains every accepted capture before publisher shutdown`() =
    runBlocking {
      val ingress = Job()
      val scope = CoroutineScope(coroutineContext + ingress)
      val publisherOwner = Job()
      val queue = Channel<WebullCapture>(16)
      val captures = (0 until 10).map { webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray()) }
      val delivered = mutableListOf<String>()
      val queued = CompletableDeferred<Unit>()
      val publisher =
        scope.launch(publisherOwner) {
          for (capture in queue) {
            delay(10)
            delivered += capture.captureId
          }
        }
      try {
        scope.launch {
          captures.forEach { queue.send(it) }
          queued.complete(Unit)
        }
        queued.await()
        ingress.cancel()
        withTimeout(5_000) { drainWebullPublisher(ingress, queue, publisher) }
        assertEquals(captures.map { it.captureId }, delivered)
      } finally {
        ingress.cancelAndJoin()
        publisherOwner.cancelAndJoin()
      }
    }
}
