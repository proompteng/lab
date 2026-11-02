package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WEBULL_QUOTES_PATH
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import java.net.URI
import java.nio.charset.StandardCharsets.UTF_8
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WebullApiTest {
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
  fun `HTTP capture retains exact response bytes and rejects credential redirects`() =
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
