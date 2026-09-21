package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.SeqTracker
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.ServerResponseException
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.apache.kafka.clients.producer.Callback
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ForwarderBarRecoveryTest {
  private val config =
    ForwarderConfig.fromEnv(
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
        "ALPACA_FEED" to "iex",
        "SYMBOLS" to "SPY",
        "ENABLE_BARS_BACKFILL" to "true",
        "TOPIC_BARS_1M" to "bars",
      ),
    )

  private fun response(
    minutes: List<String>,
    pageToken: String? = null,
  ): String {
    val bars =
      minutes.joinToString(",") { minute ->
        """{"t":"2026-09-18T$minute:00Z","o":100,"h":101,"l":99,"c":100.5,"v":10,"n":2,"vw":100.2}"""
      }
    val token = pageToken?.let { "\"$it\"" } ?: "null"
    return """{"bars":{"SPY":[$bars]},"next_page_token":$token}"""
  }

  private fun producer(
    records: ConcurrentLinkedQueue<ProducerRecord<String, String>>,
    completion: () -> Exception? = { null },
  ): KafkaProducer<String, String> {
    val producer = mockk<KafkaProducer<String, String>>(relaxed = true)
    val metadata = mockk<RecordMetadata>()
    every { producer.send(any<ProducerRecord<String, String>>(), any<Callback>()) } answers {
      records += firstArg<ProducerRecord<String, String>>()
      secondArg<Callback>().onCompletion(metadata, completion())
      CompletableFuture.completedFuture(metadata)
    }
    return producer
  }

  @Test
  fun `retries a failed Kafka acknowledgement and skips the bar once acknowledged`() =
    runBlocking {
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      var failing = true
      val producer = producer(records) { if (failing) IllegalStateException("Kafka send failed") else null }
      val client = HttpClient(MockEngine { respond(response(listOf("19:59"))) })
      val app = ForwarderApp(config, nowMs = { Instant.parse("2026-09-18T20:01:00Z").toEpochMilli() }, httpClient = client)
      try {
        assertFailsWith<IllegalStateException> { app.reconcileBars(producer, SeqTracker(), listOf("SPY")) }
        failing = false
        app.reconcileBars(producer, SeqTracker(), listOf("SPY"))
        app.reconcileBars(producer, SeqTracker(), listOf("SPY"))
        assertEquals(2, records.size)
        assertEquals(1, records.map { Json.decodeFromString<Envelope<JsonElement>>(it.value()).eventTs }.toSet().size)
      } finally {
        app.stop()
        client.close()
      }
    }

  @Test
  fun `holds the requested cutoff across pages and excludes the unfinished minute`() =
    runBlocking {
      var now = Instant.parse("2026-09-18T20:01:00Z")
      val ends = mutableListOf<String>()
      val client =
        HttpClient(
          MockEngine { request ->
            ends += requireNotNull(request.url.parameters["end"])
            now = now.plusSeconds(60)
            val body =
              if (request.url.parameters["page_token"] == null) {
                response(listOf("19:58"), "second")
              } else {
                response(listOf("19:59", "20:01"))
              }
            respond(body)
          },
        )
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      val app = ForwarderApp(config, nowMs = { now.toEpochMilli() }, httpClient = client)
      try {
        app.reconcileBars(producer(records), SeqTracker(), listOf("SPY"))
        assertEquals(listOf("2026-09-18T20:01:00Z", "2026-09-18T20:01:00Z"), ends)
        assertEquals(
          listOf("2026-09-18T19:58:00Z", "2026-09-18T19:59:00Z"),
          records.map {
            Json.decodeFromString<Envelope<JsonElement>>(it.value()).eventTs.toString()
          },
        )
      } finally {
        app.stop()
        client.close()
      }
    }

  @Test
  fun `provider failures malformed bars and repeated cursors leave recovery retryable`() =
    runBlocking {
      for (failure in listOf("http", "malformed", "cursor")) {
        var failing = true
        val client =
          HttpClient(
            MockEngine {
              when {
                !failing -> respond(response(listOf("19:59")))
                failure == "http" -> respond("unavailable", HttpStatusCode.ServiceUnavailable)
                failure == "malformed" -> respond("""{"bars":{"SPY":[{}]}}""")
                else -> respond(response(listOf("19:59"), "repeated"))
              }
            },
          )
        val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
        val producer = producer(records)
        val app = ForwarderApp(config, nowMs = { Instant.parse("2026-09-18T20:01:00Z").toEpochMilli() }, httpClient = client)
        try {
          val error = assertFailsWith<Exception> { withTimeout(1_000) { app.reconcileBars(producer, SeqTracker(), listOf("SPY")) } }
          when (failure) {
            "http" -> assertIs<ServerResponseException>(error)
            "malformed" -> assertIs<SerializationException>(error)
            "cursor" -> assertIs<IllegalArgumentException>(error)
          }
          assertTrue(records.isEmpty())
          failing = false
          app.reconcileBars(producer, SeqTracker(), listOf("SPY"))
          assertEquals(1, records.size)
        } finally {
          app.stop()
          client.close()
        }
      }
    }

  @Test
  fun `recovery runs without a websocket connection and stops with the application`() =
    runBlocking {
      val published = CompletableDeferred<Unit>()
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      val producer =
        producer(records) {
          published.complete(Unit)
          null
        }
      val client = HttpClient(MockEngine { respond(response(listOf("19:59"))) })
      val app =
        ForwarderApp(
          config,
          producerFactory = { producer },
          nowMs = { Instant.parse("2026-09-18T20:01:00Z").toEpochMilli() },
          httpClient = client,
        )
      val job = app.start()
      try {
        withTimeout(5_000) { published.await() }
      } finally {
        app.stop()
        withTimeout(5_000) { job.join() }
        client.close()
      }
      assertEquals(1, records.size)
      assertTrue(job.isCompleted)
    }

  @Test
  fun `recovery refreshes requested symbols while the websocket is disconnected`() =
    runBlocking {
      val published = CompletableDeferred<Unit>()
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      val producer =
        producer(records) {
          published.complete(Unit)
          null
        }
      val client =
        HttpClient(
          MockEngine { request ->
            if (request.url.encodedPath == "/symbols") {
              respond("""{"symbols":["AMZN"]}""")
            } else {
              respond(response(listOf("19:59")).replace("SPY", requireNotNull(request.url.parameters["symbols"])))
            }
          },
        )
      val app =
        ForwarderApp(
          config.copy(jangarSymbolsUrl = "https://symbols.test/symbols"),
          producerFactory = { producer },
          nowMs = { Instant.parse("2026-09-18T20:01:00Z").toEpochMilli() },
          httpClient = client,
        )
      val job = app.start()
      try {
        withTimeout(5_000) { published.await() }
        assertEquals(listOf("AMZN"), records.map { Json.decodeFromString<Envelope<JsonElement>>(it.value()).symbol })
      } finally {
        app.stop()
        withTimeout(5_000) { job.join() }
        client.close()
      }
    }

  @Test
  fun `recovers a closing bar after startup backfill without republishing acknowledged bars`() =
    runBlocking {
      var now = Instant.parse("2026-09-18T19:59:30Z")
      var requests = 0
      val client =
        HttpClient(
          MockEngine { request ->
            requests += 1
            assertEquals("iex", request.url.parameters["feed"])
            val minutes = if (requests == 1) listOf("19:58") else listOf("19:58", "19:59")
            val bars =
              minutes.joinToString(",") { minute ->
                """{"t":"2026-09-18T$minute:00Z","o":100,"h":101,"l":99,"c":100.5,"v":10,"n":2,"vw":100.2}"""
              }
            respond("""{"bars":{"SPY":[$bars]},"next_page_token":null}""", headers = headersOf(HttpHeaders.ContentType, "application/json"))
          },
        )
      val records = ConcurrentLinkedQueue<ProducerRecord<String, String>>()
      val producer = mockk<KafkaProducer<String, String>>()
      val metadata = mockk<RecordMetadata>()
      every { producer.send(any<ProducerRecord<String, String>>(), any<Callback>()) } answers {
        records += firstArg<ProducerRecord<String, String>>()
        secondArg<Callback>().onCompletion(metadata, null)
        CompletableFuture.completedFuture(metadata)
      }
      val config =
        ForwarderConfig.fromEnv(
          mapOf(
            "ALPACA_KEY_ID" to "key",
            "ALPACA_SECRET_KEY" to "secret",
            "ALPACA_FEED" to "iex",
            "SYMBOLS" to "SPY",
            "ENABLE_BARS_BACKFILL" to "true",
            "TOPIC_BARS_1M" to "bars",
          ),
        )
      val app = ForwarderApp(config, nowMs = { now.toEpochMilli() }, httpClient = client)
      val sequence = SeqTracker()
      try {
        app.reconcileBars(producer, sequence, listOf("SPY"))
        now = Instant.parse("2026-09-18T20:01:00Z")
        app.reconcileBars(producer, sequence, listOf("SPY"))
        val envelopes = records.map { Json.decodeFromString<Envelope<JsonElement>>(it.value()) }
        assertEquals(listOf("2026-09-18T19:58:00Z", "2026-09-18T19:59:00Z"), envelopes.map { it.eventTs.toString() })
        assertEquals(now, envelopes.last().ingestTs)
        assertEquals("rest", envelopes.last().source)
        assertEquals("iex", envelopes.last().feed)
        assertEquals("regular", envelopes.last().marketSession)
        assertEquals(2, requests)
      } finally {
        app.stop()
        client.close()
      }
    }
}
