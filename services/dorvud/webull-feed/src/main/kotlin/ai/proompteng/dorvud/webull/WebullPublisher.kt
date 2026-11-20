package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.WebullCapture
import ai.proompteng.dorvud.platform.WebullPayload
import ai.proompteng.dorvud.platform.encodeWebullCapture
import ai.proompteng.dorvud.platform.inspectWebullCapture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withTimeoutOrNull
import org.apache.kafka.clients.producer.Producer
import org.apache.kafka.clients.producer.ProducerRecord
import java.time.Duration
import java.util.concurrent.TimeoutException

internal class WebullPublisher(
  private val topic: String,
  private val producer: Producer<String, String>,
  private val progress: WebullProgress,
) {
  // The preceding publisher retained 16 queued captures and one waiting for Kafka.
  private val accepted = Semaphore(17)
  private val input =
    Channel<WebullCapture>(16, onUndeliveredElement = {
      progress.received.decrementAndGet()
      accepted.release()
    })

  suspend fun enqueue(capture: WebullCapture) {
    accepted.acquire()
    progress.received.incrementAndGet()
    input.send(capture)
  }

  fun close() {
    input.close()
  }

  private data class Publication(
    val capture: WebullCapture,
    val payload: WebullPayload?,
    val record: ProducerRecord<String, String>,
    val firstAttempt: CompletableDeferred<Result<Unit>>,
  )

  private suspend fun send(record: ProducerRecord<String, String>): CompletableDeferred<Result<Unit>> {
    val delivered = CompletableDeferred<Result<Unit>>()
    val started = System.nanoTime()
    try {
      runInterruptible(Dispatchers.IO) {
        producer.send(record) { _, failure ->
          Metrics.registry
            .timer("webull_kafka_ack_seconds", "outcome", if (failure == null) "success" else "failure")
            .record(Duration.ofNanos(System.nanoTime() - started))
          delivered.complete(if (failure == null) Result.success(Unit) else Result.failure(failure))
        }
      }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (failure: Exception) {
      delivered.complete(Result.failure(failure))
    }
    return delivered
  }

  suspend fun publish(): Unit =
    coroutineScope {
      for (capture in input) {
        val parsed = runCatching { inspectWebullCapture(capture) }.getOrNull()
        val key = parsed?.observations?.firstOrNull()?.symbol ?: "control"
        val record = ProducerRecord(topic, key, encodeWebullCapture(capture))
        val publication = Publication(capture, parsed, record, send(record))
        launch { acknowledge(publication) }
      }
    }

  private suspend fun acknowledge(publication: Publication) {
    var attempt = publication.firstAttempt
    while (true) {
      try {
        val result = withTimeoutOrNull(70_000) { attempt.await() } ?: throw TimeoutException("Webull Kafka acknowledgement expired")
        result.getOrThrow()
        progress.record(publication.capture, publication.payload)
        Metrics.registry.counter("webull_captures_total", "channel", publication.payload?.channel ?: "malformed").increment()
        accepted.release()
        return
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (failure: Exception) {
        progress.kafkaFailures.incrementAndGet()
        logEvent(
          "webull.kafka.retry",
          mapOf("errorClass" to failure.javaClass.simpleName, "captureId" to publication.capture.captureId),
        )
        delay(5_000)
        attempt = send(publication.record)
      }
    }
  }
}
