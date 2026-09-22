package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.ClientRequestException
import io.ktor.client.plugins.ServerResponseException
import io.ktor.client.plugins.expectSuccess
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeoutException

internal class AlpacaRestClient(
  private val config: ForwarderConfig,
  private val client: HttpClient,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private val requests = Mutex()
  private var nextRequestAtMs = 0L

  suspend fun get(
    url: String,
    configure: HttpRequestBuilder.() -> Unit,
  ): String =
    requests.withLock {
      while (nowMs() < nextRequestAtMs) delay(nextRequestAtMs - nowMs())
      try {
        withTimeoutOrNull(10_000) {
          val response =
            client.get(url) {
              configure()
              expectSuccess = false
              header("APCA-API-KEY-ID", config.alpacaKeyId)
              header("APCA-API-SECRET-KEY", config.alpacaSecretKey)
            }
          alpacaRestResumeAtMs(response.status.value, response.headers, nowMs())?.let { resumeAt ->
            nextRequestAtMs = maxOf(nextRequestAtMs, resumeAt)
          }
          val body = response.bodyAsText()
          when (response.status.value) {
            in 200..299 -> body
            in 500..599 -> throw ServerResponseException(response, body)
            else -> throw ClientRequestException(response, body)
          }
        } ?: throw TimeoutException("Alpaca REST request timed out")
      } finally {
        // Space completed requests so HTTP dispatch latency cannot compress the provider budget.
        nextRequestAtMs = maxOf(nextRequestAtMs, nowMs() + 500)
      }
    }
}

internal fun alpacaRestResumeAtMs(
  status: Int,
  headers: Headers,
  now: Long,
): Long? {
  val retry = headers[HttpHeaders.RetryAfter]
  val exhausted = headers["X-RateLimit-Remaining"]?.toLongOrNull()?.let { it <= 0 } == true
  if (status != 429 && !exhausted && !(status >= 400 && retry != null)) return null
  val retryAt =
    retry?.toLongOrNull()?.takeIf { it >= 0 && it <= (Long.MAX_VALUE - now) / 1000 }?.let { now + it * 1000 }
      ?: retry?.let { runCatching { ZonedDateTime.parse(it, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull() }
  val resetAt = headers["X-RateLimit-Reset"]?.toLongOrNull()?.takeIf { it in 0..(Long.MAX_VALUE / 1000 - 1) }?.let { (it + 1) * 1000 }
  return listOfNotNull(retryAt, resetAt).filter { it >= now }.maxOrNull() ?: (now + 60_000)
}
