package ai.proompteng.dorvud.platform

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.UUID

@Serializable
sealed interface WebullSource {
  @Serializable
  @SerialName("mqtt")
  data class Mqtt(
    val sessionId: String,
    val topic: String,
  ) : WebullSource

  @Serializable
  @SerialName("http")
  data class Http(
    val endpoint: String,
    val requestedSymbols: List<String>,
    val query: Map<String, String> = emptyMap(),
    val requestBody: String? = null,
  ) : WebullSource

  @Serializable
  @SerialName("collector")
  data class Collector(
    val operation: String,
  ) : WebullSource
}

@Serializable
data class WebullCapture(
  val version: Int = 1,
  val provider: String = "webull",
  val feed: String = "nasdaq_basic",
  val captureId: String,
  val receivedAt: String,
  val source: WebullSource,
  val payloadBase64: String,
  val payloadSha256: String,
) {
  fun bytes(): ByteArray = Base64.getDecoder().decode(payloadBase64)

  fun validate(): WebullCapture {
    require(version == 1 && provider == "webull" && feed == "nasdaq_basic") { "invalid Webull capture identity" }
    UUID.fromString(captureId)
    Instant.parse(receivedAt)
    val bytes = bytes()
    require(bytes.size <= MAX_WEBULL_PAYLOAD_BYTES) { "Webull payload exceeds capture bound" }
    require(payloadSha256 == webullSha256(bytes)) { "Webull payload content hash mismatch" }
    when (val origin = source) {
      is WebullSource.Mqtt -> {
        UUID.fromString(origin.sessionId)
        require(origin.topic in setOf("quote", "tick", "notice")) { "unsupported Webull MQTT topic" }
      }
      is WebullSource.Http -> {
        require(origin.endpoint in WEBULL_CAPTURE_ENDPOINTS) { "unsupported Webull HTTP capture endpoint" }
        require(origin.requestedSymbols.distinct().size == origin.requestedSymbols.size) { "duplicate requested symbols" }
      }
      is WebullSource.Collector ->
        require(origin.operation in setOf("catalog", "subscriptions", "coverage", "gap")) {
          "invalid collector operation"
        }
    }
    return this
  }
}

const val MAX_WEBULL_PAYLOAD_BYTES = 4 * 1024 * 1024
const val WEBULL_INSTRUMENTS_PATH = "/trading/instruments/stocks/profiles/list"
const val WEBULL_BARS_PATH = "/market-data/stocks/bars/list"
const val WEBULL_QUOTES_PATH = "/market-data/stocks/depths/list"
val WEBULL_CAPTURE_ENDPOINTS = setOf(WEBULL_INSTRUMENTS_PATH, WEBULL_BARS_PATH, WEBULL_QUOTES_PATH)

fun webullSha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

fun webullCapture(
  source: WebullSource,
  body: ByteArray,
  receivedAt: Instant = Instant.now(),
): WebullCapture =
  WebullCapture(
    captureId = UUID.randomUUID().toString(),
    receivedAt = receivedAt.toString(),
    source = source,
    payloadBase64 = Base64.getEncoder().encodeToString(body),
    payloadSha256 = webullSha256(body),
  ).validate()

private val webullCaptureJson = Json { encodeDefaults = true }

fun encodeWebullCapture(capture: WebullCapture): String = webullCaptureJson.encodeToString(WebullCapture.serializer(), capture)

fun decodeWebullCapture(value: String): WebullCapture {
  val body = webullCaptureJson.parseToJsonElement(value).jsonObject
  require(
    body["version"]?.jsonPrimitive?.content == "1" && body["provider"]?.jsonPrimitive?.content == "webull" &&
      body["feed"]?.jsonPrimitive?.content == "nasdaq_basic",
  ) { "missing or invalid Webull wire identity" }
  return webullCaptureJson.decodeFromJsonElement(WebullCapture.serializer(), body).validate()
}
