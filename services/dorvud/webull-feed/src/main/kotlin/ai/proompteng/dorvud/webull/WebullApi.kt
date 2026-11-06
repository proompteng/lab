package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.MAX_WEBULL_PAYLOAD_BYTES
import ai.proompteng.dorvud.platform.WEBULL_BARS_PATH
import ai.proompteng.dorvud.platform.WEBULL_INSTRUMENTS_PATH
import ai.proompteng.dorvud.platform.WEBULL_QUOTES_PATH
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.webullSha256
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.future.await
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets.UTF_8
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class WebullCredentials(
  val appKey: String,
  val appSecret: String,
) {
  init {
    require(appKey.isNotBlank() && appSecret.isNotBlank()) { "Webull application credentials are required" }
    require(appKey.all { it.code in 33..126 }) { "invalid Webull credential header" }
  }

  override fun toString(): String = "WebullCredentials(<redacted>)"
}

data class WebullApiFailure(
  val status: Int,
  val code: String,
  val retryAfter: Duration?,
) : Exception("Webull HTTP $status ($code)")

internal fun webullRetryAfter(
  value: String?,
  receivedAt: Instant,
): Duration? {
  if (value == null) return null
  val seconds = value.toLongOrNull()?.takeIf { it >= 0 }
  val duration =
    seconds?.let(Duration::ofSeconds) ?: runCatching {
      Duration.between(receivedAt, ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant())
    }.getOrNull() ?: return null
  return maxOf(duration, Duration.ofSeconds(1))
}

internal fun webullPercentEncode(value: String): String =
  URLEncoder
    .encode(value, UTF_8)
    .replace("+", "%20")
    .replace("*", "%2A")
    .replace("%7E", "~")

internal fun webullSignedHeaders(
  credentials: WebullCredentials,
  host: String,
  path: String,
  query: Map<String, String>,
  body: String?,
  timestamp: String,
  nonce: String,
): Map<String, String> {
  val headers =
    sortedMapOf(
      "x-app-key" to credentials.appKey,
      "x-timestamp" to timestamp,
      "x-signature-version" to "1.0",
      "x-signature-algorithm" to "HMAC-SHA256",
      "x-signature-nonce" to nonce,
    )
  val parameters = (headers + query + ("host" to host)).toSortedMap()
  val canonical =
    path + "&" + parameters.entries.joinToString("&") { "${it.key}=${it.value}" } +
      (body?.let { "&${webullSha256(it.toByteArray(UTF_8)).uppercase(Locale.ROOT)}" } ?: "")
  val mac = Mac.getInstance("HmacSHA256")
  mac.init(SecretKeySpec((credentials.appSecret + "&").toByteArray(UTF_8), "HmacSHA256"))
  headers["x-signature"] = Base64.getEncoder().encodeToString(mac.doFinal(webullPercentEncode(canonical).toByteArray(UTF_8)))
  headers["x-version"] = "v3"
  return headers
}

class WebullApi(
  private val credentials: WebullCredentials,
  private val client: HttpClient =
    HttpClient
      .newBuilder()
      .connectTimeout(
        Duration.ofSeconds(10),
      ).followRedirects(HttpClient.Redirect.NEVER)
      .build(),
  private val origin: URI = URI("https://api.webull.com"),
  private val clock: Clock = Clock.systemUTC(),
  private val capture: suspend (WebullSource.Http, ByteArray, Instant) -> Unit = { _, _, _ -> },
) {
  private val nextRequests = ConcurrentHashMap<String, Instant>()
  private val requestLocks = ConcurrentHashMap<String, Mutex>()

  init {
    require(origin == URI("https://api.webull.com") || origin.host in setOf("127.0.0.1", "localhost")) {
      "Webull origin must be production or local test server"
    }
  }

  suspend fun request(
    path: String,
    query: Map<String, String> = emptyMap(),
    body: JsonObject? = null,
    symbols: List<String> = emptyList(),
  ): JsonObject {
    require(
      path in
        setOf(
          WEBULL_INSTRUMENTS_PATH,
          WEBULL_BARS_PATH,
          WEBULL_QUOTES_PATH,
          "/market-data/streaming/subscribe",
          "/market-data/streaming/unsubscribe",
        ),
    ) { "unsupported Webull endpoint" }
    val interval = if (path == WEBULL_INSTRUMENTS_PATH) Duration.ofMillis(1_100) else Duration.ofMillis(250)
    repeat(4) { attempt ->
      awaitRequest(path, interval)
      val encodedBody = body?.toString()
      val suffix =
        if (query.isEmpty()) {
          ""
        } else {
          "?" +
            query.toSortedMap().entries.joinToString("&") { "${webullPercentEncode(it.key)}=${webullPercentEncode(it.value)}" }
        }
      val builder = HttpRequest.newBuilder(origin.resolve(path + suffix)).timeout(Duration.ofSeconds(20))
      webullSignedHeaders(
        credentials,
        origin.authority,
        path,
        query,
        encodedBody,
        DateTimeFormatter.ISO_INSTANT.format(clock.instant().truncatedTo(java.time.temporal.ChronoUnit.SECONDS)),
        UUID.randomUUID().toString(),
      ).forEach(builder::header)
      builder.header("Accept", "application/json")
      if (encodedBody ==
        null
      ) {
        builder.GET()
      } else {
        builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(encodedBody))
      }
      val response = client.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofInputStream()).await()
      val responseAt = clock.instant()
      val retry = webullRetryAfter(response.headers().firstValue("Retry-After").orElse(null), responseAt)
      val readOnly = path in setOf(WEBULL_INSTRUMENTS_PATH, WEBULL_BARS_PATH, WEBULL_QUOTES_PATH)
      val retryable = response.statusCode() == 429 || (readOnly && response.statusCode() in 500..599)
      val bytes =
        response.body().use { responseBody ->
          if (retryable) {
            val wait = retry ?: if (response.statusCode() == 429) Duration.ofSeconds(60) else Duration.ofSeconds(1L shl attempt)
            requestLocks.getValue(path).withLock {
              nextRequests[path] = maxOf(nextRequests.getValue(path), responseAt.plus(wait))
            }
          }
          withTimeout(20_000) { runInterruptible(Dispatchers.IO) { responseBody.readNBytes(MAX_WEBULL_PAYLOAD_BYTES + 1) } }
        }
      require(bytes.size <= MAX_WEBULL_PAYLOAD_BYTES) { "Webull HTTP response exceeds capture bound" }
      val receivedAt = clock.instant()
      if (response.statusCode() in 200..299) {
        if (path in setOf(WEBULL_INSTRUMENTS_PATH, WEBULL_BARS_PATH, WEBULL_QUOTES_PATH)) {
          capture(WebullSource.Http(path, symbols, query, encodedBody), bytes, receivedAt)
        }
        val result =
          if (bytes.isEmpty()) {
            buildJsonObject {}
          } else {
            Json.parseToJsonElement(bytes.decodeToString(throwOnInvalidSequence = true)) as? JsonObject
              ?: error("Webull response must be an object")
          }
        return result
      }
      val code =
        runCatching {
          ((Json.parseToJsonElement(bytes.toString(UTF_8)) as? JsonObject)?.get("error_code") as? JsonPrimitive)?.content
        }.getOrNull()?.takeIf { it.matches(Regex("[A-Za-z0-9_.-]{1,100}")) }
          ?: "HTTP_${response.statusCode()}"
      val failure = WebullApiFailure(response.statusCode(), code, retry)
      if (!retryable || attempt == 3) throw failure
    }
    error("Webull request exhausted its retry budget")
  }

  private suspend fun awaitRequest(
    path: String,
    interval: Duration,
  ) {
    val lock = requestLocks.computeIfAbsent(path) { Mutex() }
    while (true) {
      val wait =
        lock.withLock {
          val now = clock.instant()
          val due = nextRequests[path] ?: now
          if (due.isAfter(now)) {
            Duration.between(now, due)
          } else {
            nextRequests[path] = now.plus(interval)
            Duration.ZERO
          }
        }
      if (wait.isZero) return
      delay(wait.toMillis() + 1)
    }
  }
}
