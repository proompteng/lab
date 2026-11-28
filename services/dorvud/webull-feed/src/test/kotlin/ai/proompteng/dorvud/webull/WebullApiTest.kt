package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WEBULL_BARS_PATH
import ai.proompteng.dorvud.platform.WEBULL_QUOTES_PATH
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import java.net.InetSocketAddress
import java.net.URI
import java.nio.charset.StandardCharsets.UTF_8
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WebullApiTest {
  @Test
  fun `a stalled catalog response does not block paced priority bar requests`() =
    runBlocking {
      val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      val executor = Executors.newFixedThreadPool(3)
      val admissions = AtomicInteger()
      server.executor =
        Executor { task ->
          executor.execute {
            if (admissions.getAndIncrement() == 0) Thread.sleep(300)
            task.run()
          }
        }
      val backgroundStarted = CompletableDeferred<Unit>()
      val releaseBackground = CountDownLatch(1)
      val requestTimes = ConcurrentLinkedQueue<Long>()
      server.createContext(WEBULL_BARS_PATH) { exchange ->
        requestTimes.add(System.nanoTime())
        if (exchange.requestURI.rawQuery == "batch=catalog") {
          backgroundStarted.complete(Unit)
          releaseBackground.await(5, TimeUnit.SECONDS)
        }
        val body = "{}".toByteArray()
        exchange.sendResponseHeaders(200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
      }
      server.start()
      try {
        val api = WebullApi(WebullCredentials("key", "secret"), origin = URI("http://127.0.0.1:${server.address.port}"))
        val requestsStartedAt = System.nanoTime()
        val background = async { api.request(WEBULL_BARS_PATH, query = mapOf("batch" to "catalog")) }
        withTimeout(2_000) { backgroundStarted.await() }
        val priorityStartedAt = System.nanoTime()
        withTimeout(2_000) {
          repeat(2) { api.request(WEBULL_BARS_PATH, query = mapOf("batch" to "priority")) }
        }
        val completedAt = System.nanoTime()
        assertFalse(background.isCompleted)
        assertEquals(3, requestTimes.size)
        assertTrue(completedAt - priorityStartedAt >= 240_000_000, "Priority requests must span a reservation interval")
        assertTrue(completedAt - requestsStartedAt >= 490_000_000, "Three requests must span two reservation intervals")
        releaseBackground.countDown()
        assertEquals(Json.parseToJsonElement("{}"), background.await())
      } finally {
        releaseBackground.countDown()
        server.stop(0)
        executor.shutdownNow()
      }
    }

  @Test
  fun `rate limit responses extend the cooldown of requests already waiting for a slot`() =
    runBlocking {
      val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      val executor = Executors.newFixedThreadPool(3)
      server.executor = executor
      val firstStarted = CompletableDeferred<Unit>()
      val releaseLimit = CountDownLatch(1)
      val releaseLimitBody = CountDownLatch(1)
      val requests = AtomicInteger()
      val limitedAt = AtomicLong()
      val priorityAt = AtomicLong()
      server.createContext(WEBULL_BARS_PATH) { exchange ->
        val limited = requests.incrementAndGet() == 1
        if (limited) {
          firstStarted.complete(Unit)
          releaseLimit.await(5, TimeUnit.SECONDS)
          limitedAt.set(System.nanoTime())
          exchange.responseHeaders.add("Retry-After", "1")
        }
        if (exchange.requestURI.rawQuery == "batch=priority") priorityAt.set(System.nanoTime())
        val body = (if (limited) """{"error_code":"RATE_LIMITED"}""" else "{}").toByteArray()
        exchange.sendResponseHeaders(if (limited) 429 else 200, body.size.toLong())
        if (limited) releaseLimitBody.await(5, TimeUnit.SECONDS)
        exchange.responseBody.use { it.write(body) }
      }
      server.start()
      try {
        val api = WebullApi(WebullCredentials("key", "secret"), origin = URI("http://127.0.0.1:${server.address.port}"))
        val background = async { api.request(WEBULL_BARS_PATH, query = mapOf("batch" to "catalog")) }
        withTimeout(2_000) { firstStarted.await() }
        val priority = async(start = CoroutineStart.UNDISPATCHED) { api.request(WEBULL_BARS_PATH, query = mapOf("batch" to "priority")) }
        delay(50)
        releaseLimit.countDown()
        withTimeout(4_000) {
          priority.await()
          releaseLimitBody.countDown()
          background.await()
        }
        assertEquals(3, requests.get())
        assertTrue(priorityAt.get() - limitedAt.get() >= 1_000_000_000)
      } finally {
        releaseLimit.countDown()
        releaseLimitBody.countDown()
        server.stop(0)
        executor.shutdownNow()
      }
    }

  @Test
  fun `bar requests accept twenty symbols and reject an oversized batch before sending`() =
    runBlocking {
      val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      val requestedSizes = mutableListOf<Int>()
      server.createContext(WEBULL_BARS_PATH) { exchange ->
        val request = Json.parseToJsonElement(exchange.requestBody.readAllBytes().decodeToString()).jsonObject
        val size = (request.getValue("symbols") as JsonArray).size
        requestedSizes += size
        val body =
          if (size <= 20) {
            """{"result":[]}"""
          } else {
            """{"error_code":"ILLEGAL_PARAMETER","message":"symbols size must be between 1 and 20."}"""
          }
        val bytes = body.toByteArray()
        exchange.sendResponseHeaders(if (size <= 20) 200 else 417, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
      }
      server.start()
      try {
        val api = WebullApi(WebullCredentials("key", "secret"), origin = URI("http://127.0.0.1:${server.address.port}"))
        val cutoff = Instant.parse("2026-11-02T08:00:00Z")
        api.completedBars((1..20).map { "S$it" }, cutoff)
        assertFailsWith<IllegalArgumentException> { api.completedBars((1..21).map { "S$it" }, cutoff) }
        assertEquals(listOf(20), requestedSizes)
      } finally {
        server.stop(0)
      }
    }

  @Test
  fun `exhausted rate limit retries still delay the next batch until the final cooldown expires`() =
    runBlocking {
      val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      var requests = 0
      val finalLimitAt = AtomicLong()
      val subsequentAt = AtomicLong()
      server.createContext(WEBULL_QUOTES_PATH) { exchange ->
        requests++
        val limited = requests <= 4
        if (requests == 4) finalLimitAt.set(System.nanoTime())
        if (requests == 5) subsequentAt.set(System.nanoTime())
        val body = (if (limited) """{"error_code":"RATE_LIMITED"}""" else "{}").toByteArray()
        if (limited) exchange.responseHeaders.add("Retry-After", "0")
        exchange.sendResponseHeaders(if (limited) 429 else 200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
      }
      server.start()
      try {
        val api = WebullApi(WebullCredentials("key", "secret"), origin = URI("http://127.0.0.1:${server.address.port}"))
        assertEquals(429, assertFailsWith<WebullApiFailure> { api.request(WEBULL_QUOTES_PATH) }.status)
        api.request(WEBULL_QUOTES_PATH)
        assertTrue(subsequentAt.get() - finalLimitAt.get() >= 1_000_000_000)
      } finally {
        server.stop(0)
      }
    }

  @Test
  fun `Retry-After honors long numeric and HTTP date backoffs`() {
    val receivedAt = Instant.parse("2026-11-01T00:00:00Z")
    assertEquals(Duration.ofSeconds(600), webullRetryAfter("600", receivedAt))
    assertEquals(Duration.ofSeconds(600), webullRetryAfter("Sun, 01 Nov 2026 00:10:00 GMT", receivedAt))
    assertEquals(Duration.ofSeconds(1), webullRetryAfter("0", receivedAt))
    assertEquals(null, webullRetryAfter("invalid", receivedAt))
  }

  @Test
  fun `signature matches official SDK 3_0_4 HMAC SHA256 vector`() {
    val headers =
      webullSignedHeaders(
        WebullCredentials("test-app", "test-secret"),
        "api.webull.com",
        WEBULL_QUOTES_PATH,
        mapOf("category" to "US_STOCK", "symbols" to "AAPL,SPY"),
        null,
        "2026-11-01T00:00:00Z",
        "test-nonce",
      )
    assertEquals("madXWdT+EtiLfdvBLB6kwuCdBzcuBOJoQZQSW25K7BA=", headers["x-signature"])
    assertFalse(WebullCredentials("test-app", "test-secret").toString().contains("test-secret"))
  }

  @Test
  fun `HTTP capture retains exact response bytes and rejects credential redirects`(): Unit =
    runBlocking {
      val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      val body = "{\"price\":\"0.123456789123456789\"}".toByteArray(UTF_8)
      var received: ByteArray? = null
      var redirected = false
      var throttle = true
      var requestCount = 0
      server.createContext(WEBULL_QUOTES_PATH) { exchange ->
        requestCount++
        when {
          requestCount == 1 -> {
            exchange.responseHeaders.add("Retry-After", "1")
            exchange.sendResponseHeaders(429, -1)
            exchange.close()
          }
          throttle -> {
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
          }
          else -> {
            exchange.responseHeaders.add("Location", "http://127.0.0.1:${server.address.port}/credential-leak")
            exchange.sendResponseHeaders(302, -1)
            exchange.close()
          }
        }
      }
      server.createContext("/credential-leak") { exchange ->
        redirected = true
        exchange.sendResponseHeaders(200, -1)
        exchange.close()
      }
      server.start()
      try {
        val api =
          WebullApi(WebullCredentials("key", "secret"), origin = URI("http://127.0.0.1:${server.address.port}"), capture = { _, bytes, _ ->
            received =
              bytes
          })
        val started = System.nanoTime()
        api.request(WEBULL_QUOTES_PATH)
        assertEquals(body.toList(), received?.toList())
        assertTrue(System.nanoTime() - started >= 1_000_000_000)
        assertEquals(2, requestCount)
        throttle = false
        val failure = assertFailsWith<WebullApiFailure> { api.request(WEBULL_QUOTES_PATH) }
        assertEquals(302, failure.status)
        assertFalse(redirected)
        assertFailsWith<IllegalArgumentException> { WebullApi(WebullCredentials("key", "secret"), origin = URI("https://example.com")) }
      } finally {
        server.stop(0)
      }
    }
}
