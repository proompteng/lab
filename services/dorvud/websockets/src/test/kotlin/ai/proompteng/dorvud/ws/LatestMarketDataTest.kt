package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.SeqTracker
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.parameter
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.time.Instant
import java.util.concurrent.TimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class LatestMarketDataTest {
  @Test
  fun `rate-limit headers preserve retry dates reset boundaries and unknown cooldowns`() {
    val now = Instant.parse("2026-09-11T14:00:00Z").toEpochMilli()
    assertEquals(null, alpacaRestResumeAtMs(200, headersOf("X-RateLimit-Remaining", "1"), now))
    assertEquals(now, alpacaRestResumeAtMs(429, headersOf("Retry-After", "0"), now))
    assertEquals(now + 3000, alpacaRestResumeAtMs(429, headersOf("Retry-After", "Fri, 11 Sep 2026 14:00:03 GMT"), now))
    assertEquals(now + 3000, alpacaRestResumeAtMs(503, headersOf("Retry-After", "3"), now))
    assertEquals(now + 60_000, alpacaRestResumeAtMs(429, headersOf("Retry-After", "invalid"), now))
    assertEquals(now + 60_000, alpacaRestResumeAtMs(429, headersOf("Retry-After", Long.MAX_VALUE.toString()), now))
    assertEquals(
      now + 5000,
      alpacaRestResumeAtMs(
        200,
        headersOf(
          "X-RateLimit-Remaining" to listOf("0"),
          "X-RateLimit-Reset" to listOf((now / 1000 + 4).toString()),
        ),
        now,
      ),
    )
  }

  private val fixture = Json.parseToJsonElement(File("../fixtures/alpaca-latest-v1.json").readText()).jsonObject
  private val observedAt = Instant.parse(fixture.getValue("observedAt").jsonPrimitive.content)
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
  private val json = Json { encodeDefaults = true }

  @Test
  fun `provider samples match the shared Bayn contract and only acknowledged values deduplicate`() =
    runBlocking {
      val client =
        HttpClient(
          MockEngine { request ->
            assertEquals("iex", request.url.parameters["feed"])
            assertEquals("AAPL,AMD", request.url.parameters["symbols"])
            assertEquals("key", request.headers["APCA-API-KEY-ID"])
            val channel = request.url.encodedPath.split('/')[3]
            respond(fixture.getValue("${channel}Response").toString())
          },
        )
      try {
        var observationMs = observedAt.toEpochMilli()
        val now = { observationMs }
        val poller =
          LatestMarketDataPoller(requireNotNull(config.latestMarketData), config.alpacaBaseUrl, AlpacaRestClient(config, client), now)
        val delivered = mutableListOf<Envelope<JsonElement>>()
        poller.poll(SeqTracker()::next) { delivered += it }
        val expected = requireNotNull(fixture["envelopes"] as? JsonArray)
        assertEquals(expected, JsonArray(delivered.map { json.encodeToJsonElement(Envelope.serializer(JsonElement.serializer()), it) }))
        poller.poll(SeqTracker()::next) { error("duplicate sample was published") }
        assertTrue(
          poller
            .coverage()
            .unavailableSymbols.values
            .all { it.isEmpty() },
        )
        observationMs += 10_001
        assertEquals(listOf("AAPL", "AMD"), poller.coverage().unavailableSymbols["quotes"])
      } finally {
        client.close()
      }
    }

  @Test
  fun `failed delivery retries and successful channels remain independent`() =
    runBlocking {
      val client =
        HttpClient(
          MockEngine { request ->
            respond(fixture.getValue("${request.url.encodedPath.split('/')[3]}Response").toString())
          },
        )
      try {
        var observationMs = observedAt.toEpochMilli()
        val now = { observationMs }
        val poller =
          LatestMarketDataPoller(requireNotNull(config.latestMarketData), config.alpacaBaseUrl, AlpacaRestClient(config, client), now)
        val attempts = mutableListOf<Pair<String, String>>()
        var failQuote = true
        val publish: suspend (Envelope<JsonElement>) -> Unit = { envelope ->
          attempts += envelope.channel to envelope.symbol
          if (envelope.channel == "quotes" && failQuote) error("Kafka failed")
        }
        poller.poll(SeqTracker()::next, publish)
        assertEquals(listOf("AAPL", "AMD"), poller.coverage().unavailableSymbols["quotes"])
        assertEquals(emptyList(), poller.coverage().unavailableSymbols["trades"])
        failQuote = false
        poller.poll(SeqTracker()::next, publish)
        poller.poll(SeqTracker()::next, publish)
        assertEquals(listOf("quotes" to "AAPL", "trades" to "AAPL", "trades" to "AMD", "quotes" to "AAPL", "quotes" to "AMD"), attempts)
      } finally {
        client.close()
      }
    }

  @Test
  fun `HTTP failures remain unavailable and cancellation interrupts an in-flight request`() =
    runBlocking {
      var fail = true
      val entered = CompletableDeferred<Unit>()
      val canceled = CompletableDeferred<Unit>()
      val client =
        HttpClient(
          MockEngine {
            if (fail) {
              respond("unavailable", HttpStatusCode.ServiceUnavailable)
            } else {
              entered.complete(Unit)
              try {
                awaitCancellation()
              } finally {
                canceled.complete(Unit)
              }
            }
          },
        )
      try {
        var observationMs = observedAt.toEpochMilli()
        val now = { observationMs }
        val poller =
          LatestMarketDataPoller(requireNotNull(config.latestMarketData), config.alpacaBaseUrl, AlpacaRestClient(config, client), now)
        poller.poll(SeqTracker()::next) { error("must not publish") }
        assertEquals(setOf("quotes", "trades"), poller.coverage().errors.keys)
        assertTrue(poller.coverage().acknowledgedEventAtMs.isEmpty())
        fail = false
        val job = async { poller.poll(SeqTracker()::next) { error("must not publish") } }
        entered.await()
        job.cancelAndJoin()
        canceled.await()
        assertTrue(job.isCancelled)
      } finally {
        client.close()
      }
    }

  @Test
  fun `missing stale future malformed and wrong-symbol values cannot create fresh observations`() {
    val body = fixture.getValue("quotesResponse").jsonObject
    val quote =
      body
        .getValue("quotes")
        .jsonObject
        .getValue("AAPL")
        .jsonObject

    fun response(
      value: JsonElement,
      symbol: String = "AAPL",
    ) = JsonObject(mapOf("quotes" to JsonObject(mapOf(symbol to value)))).toString()

    fun decode(value: String) = decodeLatestMarketData(value, LatestMarketDataChannel.Quotes, setOf("AAPL"), observedAt, 10_000)
    assertEquals(emptyList(), decode("""{"quotes":{}}"""))
    for (at in listOf(observedAt.minusSeconds(11), observedAt.plusNanos(1))) {
      assertEquals(emptyList(), decode(response(JsonObject(quote + ("t" to JsonPrimitive(at.toString()))))))
    }
    assertEquals(1, decode(response(JsonObject(quote + ("bs" to JsonPrimitive(0))))).size)
    for (invalid in listOf(
      response(quote, "MSFT"),
      response(JsonObject(quote + ("S" to JsonPrimitive("MSFT")))),
      response(JsonObject(quote + ("T" to JsonPrimitive("t")))),
      response(JsonObject(quote + ("t" to JsonPrimitive("invalid")))),
      response(JsonObject(quote + ("bp" to JsonPrimitive(0)))),
      response(JsonObject(quote + ("bs" to JsonPrimitive(-1)))),
      response(JsonObject(quote - "t")),
      response(JsonObject(quote + ("bp" to JsonPrimitive(999)))),
      """{"quotes":null}""",
      response(JsonPrimitive("invalid")),
    )) {
      assertFailsWith<Exception> { decode(invalid) }
    }
  }

  @Test
  fun `an HTTP deadline remains retryable without canceling its recovery caller`() =
    runBlocking {
      val canceled = CompletableDeferred<Unit>()
      var requests = 0
      val client =
        HttpClient(
          MockEngine {
            requests++
            if (requests == 1) {
              try {
                awaitCancellation()
              } finally {
                canceled.complete(Unit)
              }
            } else {
              respond("{}")
            }
          },
        )
      try {
        val rest = AlpacaRestClient(config, client)
        assertFailsWith<TimeoutException> { rest.get("https://data.alpaca.markets/v2/stocks/bars") {} }
        canceled.await()
        assertTrue(isActive)
        assertEquals("{}", rest.get("https://data.alpaca.markets/v2/stocks/bars") {})
        assertEquals(2, requests)
      } finally {
        client.close()
      }
    }

  @Test
  fun `latest requests and historical pages share pacing and provider backoff`() =
    runBlocking {
      val requests = mutableListOf<Long>()
      val client =
        HttpClient(
          MockEngine {
            if (requests.isEmpty()) delay(200)
            requests += System.currentTimeMillis()
            if (requests.size ==
              2
            ) {
              respond("rate limited", HttpStatusCode.TooManyRequests, headersOf("Retry-After", "3"))
            } else {
              respond("{}")
            }
          },
        )
      try {
        val rest = AlpacaRestClient(config, client)
        rest.get("https://data.alpaca.markets/v2/stocks/quotes/latest") { parameter("feed", "iex") }
        assertFailsWith<io.ktor.client.plugins.ClientRequestException> { rest.get("https://data.alpaca.markets/v2/stocks/bars") {} }
        rest.get("https://data.alpaca.markets/v2/stocks/trades/latest") {}
        assertEquals(3, requests.size)
        assertTrue(requests[1] - requests[0] >= 500, "provider request spacing was ${requests[1] - requests[0]} ms")
        assertTrue(requests[2] - requests[1] >= 3000, "provider backoff was ${requests[2] - requests[1]} ms")
      } finally {
        client.close()
      }
    }
}
