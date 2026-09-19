package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.SeqTracker
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.headersOf
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
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

class ForwarderBarRecoveryTest {
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
