package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.decodeWebullCapture
import ai.proompteng.dorvud.platform.webullCapture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.apache.kafka.clients.producer.MockProducer
import org.apache.kafka.common.serialization.StringSerializer
import kotlin.test.Test
import kotlin.test.assertEquals

class WebullShutdownTest {
  @Test
  fun `cancelling input ownership still drains every accepted capture before publisher shutdown`() =
    runBlocking {
      val ingress = Job()
      val scope = CoroutineScope(coroutineContext + ingress)
      val publisherOwner = Job()
      val producer = MockProducer<String, String>(true, null, StringSerializer(), StringSerializer())
      val input = WebullPublisher("webull-test", producer, WebullProgress())
      val captures = (0 until 10).map { webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray()) }
      val queued = CompletableDeferred<Unit>()
      val publisher =
        scope.launch(publisherOwner) {
          input.publish()
        }
      try {
        scope.launch {
          captures.forEach { input.enqueue(it) }
          queued.complete(Unit)
        }
        queued.await()
        ingress.cancel()
        withTimeout(5_000) { drainWebullPublisher(ingress, input, publisher) }
        assertEquals(captures.map { it.captureId }, producer.history().map { decodeWebullCapture(it.value()).captureId })
      } finally {
        ingress.cancelAndJoin()
        publisherOwner.cancelAndJoin()
      }
    }
}
