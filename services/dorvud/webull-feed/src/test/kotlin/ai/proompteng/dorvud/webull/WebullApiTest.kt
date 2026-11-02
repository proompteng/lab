package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WEBULL_QUOTES_PATH
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import java.net.URI
import java.nio.charset.StandardCharsets.UTF_8
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WebullApiTest {
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
