package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.webullCapture
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.apache.kafka.clients.producer.Callback
import org.apache.kafka.clients.producer.MockProducer
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import org.apache.kafka.common.serialization.StringSerializer
import java.util.Collections
import java.util.concurrent.Future
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class WebullPublisherTest {
  @Test
  fun `the eighteenth capture waits for acknowledgement instead of enlarging the buffer`() =
    runBlocking {
      val producer = MockProducer<String, String>(false, null, StringSerializer(), StringSerializer())
      val progress = WebullProgress()
      val input = WebullPublisher("webull-test", producer, progress)
      val publisher = launch { input.publish() }
      try {
        repeat(17) { input.enqueue(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray())) }
        withTimeout(5_000) { while (producer.history().size < 17) delay(10) }
        val eighteenth = async { input.enqueue(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray())) }
        delay(50)
        assertFalse(eighteenth.isCompleted)
        assertEquals(17L, progress.received.get())
        producer.completeNext()
        withTimeout(5_000) { eighteenth.await() }
        withTimeout(5_000) { while (producer.history().size < 18) delay(10) }
        repeat(17) { producer.completeNext() }
        input.close()
        withTimeout(5_000) { publisher.join() }
        assertEquals(18L, progress.acknowledged.get())
      } finally {
        input.close()
        publisher.cancelAndJoin()
        producer.close()
      }
    }

  @Test
  fun `an independent acknowledged capture advances while another partition waits`() =
    runBlocking {
      val callbacks = Collections.synchronizedList(mutableListOf<Callback>())
      val producer =
        object : MockProducer<String, String>(false, null, StringSerializer(), StringSerializer()) {
          override fun send(
            record: ProducerRecord<String, String>,
            callback: Callback,
          ): Future<RecordMetadata> {
            callbacks += callback
            return super.send(record, callback)
          }
        }
      val progress = WebullProgress()
      val input = WebullPublisher("webull-test", producer, progress)
      val publisher = launch { input.publish() }
      try {
        repeat(2) { input.enqueue(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray())) }
        withTimeout(5_000) { while (callbacks.size < 2) delay(10) }
        callbacks[1].onCompletion(null, null)
        withTimeout(5_000) { while (progress.acknowledged.get() != 1L) delay(10) }
        callbacks[0].onCompletion(null, null)
        input.close()
        withTimeout(5_000) { publisher.join() }
        assertEquals(2L, progress.acknowledged.get())
      } finally {
        input.close()
        publisher.cancelAndJoin()
        producer.close()
      }
    }

  @Test
  fun `cancelled enqueue returns its capacity and does not count an undelivered capture`() =
    runBlocking {
      val producer = MockProducer<String, String>(true, null, StringSerializer(), StringSerializer())
      val progress = WebullProgress()
      val input = WebullPublisher("webull-test", producer, progress)
      repeat(16) { input.enqueue(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray())) }
      assertNull(withTimeoutOrNull(50) { input.enqueue(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray())) })
      assertEquals(16L, progress.received.get())
      val publisher = launch { input.publish() }
      try {
        input.enqueue(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray()))
        input.close()
        withTimeout(5_000) { publisher.join() }
        assertEquals(17L, progress.acknowledged.get())
      } finally {
        input.close()
        publisher.cancelAndJoin()
        producer.close()
      }
    }

  @Test
  fun `failed acknowledgement retries the identical capture and only counts success once`() =
    runBlocking {
      val producer = MockProducer<String, String>(false, null, StringSerializer(), StringSerializer())
      val progress = WebullProgress()
      val input = WebullPublisher("webull-test", producer, progress)
      val publisher = launch { input.publish() }
      try {
        input.enqueue(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray()))
        withTimeout(5_000) { while (producer.history().size < 1) delay(10) }
        producer.errorNext(IllegalStateException("broker rejected the attempt"))
        withTimeout(7_000) { while (producer.history().size < 2) delay(10) }
        assertEquals(producer.history()[0].value(), producer.history()[1].value())
        assertEquals(0L, progress.acknowledged.get())
        producer.completeNext()
        input.close()
        withTimeout(5_000) { publisher.join() }
        assertEquals(1L, progress.acknowledged.get())
        assertEquals(1L, progress.kafkaFailures.get())
      } finally {
        input.close()
        publisher.cancelAndJoin()
        producer.close()
      }
    }

  @Test
  fun `all bounded captures reach Kafka before delayed broker acknowledgements`() =
    runBlocking {
      val producer = MockProducer<String, String>(false, null, StringSerializer(), StringSerializer())
      val progress = WebullProgress()
      val input = WebullPublisher("webull-test", producer, progress)
      val captures = (0 until 17).map { webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray()) }
      val publisher = launch { input.publish() }
      try {
        captures.forEach { input.enqueue(it) }
        withTimeout(5_000) {
          while (producer.history().size < 17) delay(10)
        }
        assertEquals(17, producer.history().size, "one slow acknowledgement must not serialize every following send")
        assertEquals(0L, progress.acknowledged.get())
        repeat(17) { producer.completeNext() }
        input.close()
        withTimeout(5_000) { publisher.join() }
        assertEquals(17L, progress.acknowledged.get())
      } finally {
        input.close()
        publisher.cancelAndJoin()
        producer.close()
      }
    }
}
