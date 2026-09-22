package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.apache.kafka.clients.producer.Callback
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import java.io.File
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForwarderLatestMarketDataTest {
  private val fixture = Json.parseToJsonElement(File("../fixtures/alpaca-latest-v1.json").readText()).jsonObject
  private val observedAt = Instant.parse(fixture.getValue("observedAt").jsonPrimitive.content).toEpochMilli()
  private val config =
    ForwarderConfig.fromEnv(
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
        "SYMBOLS" to "AAPL,AMD,SPY",
        "ALPACA_MARKET_DATA_QUOTES_SYMBOLS" to "SPY",
        "ALPACA_MARKET_DATA_TRADES_SYMBOLS" to "SPY",
        "ALPACA_LATEST_SYMBOLS" to "AAPL,AMD",
      ),
    )

  private fun producer(records: ConcurrentLinkedQueue<ProducerRecord<String, String>>): KafkaProducer<String, String> {
    val producer = mockk<KafkaProducer<String, String>>(relaxed = true)
    val metadata = mockk<RecordMetadata>()
    every { producer.send(any<ProducerRecord<String, String>>(), any<Callback>()) } answers {
      records += firstArg<ProducerRecord<String, String>>()
      secondArg<Callback>().onCompletion(metadata, null)
      CompletableFuture.completedFuture(metadata)
    }
    return producer
  }

  @Test
  fun `native Kafka records match the Bayn fixture without satisfying websocket readiness`() =
    runBlocking {
      val client =
        HttpClient(
          MockEngine { request ->
            respond(fixture.getValue("${request.url.encodedPath.split('/')[3]}Response").toString())
          },
        )
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      val app = ForwarderApp(config, nowMs = { observedAt }, httpClient = client)
      try {
        val producer = producer(records)
        app.pollLatestMarketData(producer)
        app.pollLatestMarketData(producer)
        assertEquals(fixture.getValue("envelopes"), JsonArray(records.map { Json.parseToJsonElement(it.value()) }))
        assertEquals(
          listOf(config.topics.quotes, config.topics.quotes, config.topics.trades, config.topics.trades),
          records.map { it.topic() },
        )
        assertTrue(requireNotNull(app.readinessInfo().latestRestObservations).unavailableSymbols.values.all { it.isEmpty() })
        assertFalse(app.readinessInfo().gates.alpacaWs)
        assertEquals(0, app.readinessInfo().alpacaMarketDataWs.subscribedSymbolCount)
      } finally {
        app.stop()
        client.close()
      }
    }

  @Test
  fun `polling starts without a websocket and application shutdown cancels its HTTP request`() =
    runBlocking {
      val entered = CompletableDeferred<Unit>()
      val canceled = CompletableDeferred<Unit>()
      val client =
        HttpClient(
          MockEngine { request ->
            if (request.url.encodedPath.endsWith("/latest")) {
              entered.complete(Unit)
              try {
                awaitCancellation()
              } finally {
                canceled.complete(Unit)
              }
            } else {
              error("no websocket connection")
            }
          },
        )
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      val app = ForwarderApp(config, producerFactory = { producer(records) }, nowMs = { observedAt }, httpClient = client)
      val job = app.start()
      try {
        withTimeout(5000) { entered.await() }
      } finally {
        app.stop()
        withTimeout(5000) {
          job.join()
          canceled.await()
        }
        client.close()
      }
      assertTrue(job.isCompleted)
      assertTrue(records.none { it.topic() == config.topics.quotes || it.topic() == config.topics.trades })
    }
}
