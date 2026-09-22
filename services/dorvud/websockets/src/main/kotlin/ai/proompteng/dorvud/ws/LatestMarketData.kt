package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.LATEST_REST_SOURCE
import io.ktor.client.plugins.ResponseException
import io.ktor.client.request.parameter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

data class LatestMarketDataConfig(
  val symbols: List<String>,
  val pollIntervalMs: Long,
  val maximumAgeMs: Long,
)

internal enum class LatestMarketDataChannel(
  val id: String,
  val type: String,
) {
  Quotes("quotes", "q"),
  Trades("trades", "t"),
}

@Serializable
data class LatestMarketDataCoverage(
  val symbols: List<String>,
  val maximumAgeMs: Long,
  val acknowledgedEventAtMs: Map<String, Map<String, Long>>,
  val unavailableSymbols: Map<String, List<String>>,
  val lastAttemptAtMs: Long?,
  val errors: Map<String, String>,
)

internal fun decodeLatestMarketData(
  body: String,
  channel: LatestMarketDataChannel,
  symbols: Set<String>,
  observedAt: Instant,
  maximumAgeMs: Long,
): List<AlpacaMessage> {
  val json = Json { ignoreUnknownKeys = true }
  val root = json.parseToJsonElement(body) as? JsonObject ?: error("latest response must be an object")
  val values = root[channel.id] as? JsonObject ?: error("latest response lacks ${channel.id}")
  require(values.keys.all { it in symbols }) { "latest response contains an unrequested symbol" }
  return values.mapNotNull { (symbol, value) ->
    val payload = value as? JsonObject ?: error("latest response has an invalid observation")
    require(payload["S"] == null || payload["S"] == JsonPrimitive(symbol)) { "latest response symbol mismatch" }
    require(payload["T"] == null || payload["T"] == JsonPrimitive(channel.type)) { "latest response channel mismatch" }
    val normalized = JsonObject(payload + mapOf("S" to JsonPrimitive(symbol), "T" to JsonPrimitive(channel.type)))
    val message: AlpacaMessage
    val timestamp: String
    when (channel) {
      LatestMarketDataChannel.Quotes -> {
        val quote = json.decodeFromJsonElement(AlpacaQuote.serializer(), normalized)
        require(listOf(quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize).all { it.isFinite() && it >= 0 }) {
          "latest response has invalid quote prices or sizes"
        }
        require(quote.bidPrice <= quote.askPrice) { "latest response has a crossed quote" }
        require(quote.bidPrice > 0 && quote.askPrice > 0) { "latest response has a zero quote price" }
        message = quote
        timestamp = quote.timestamp
      }
      LatestMarketDataChannel.Trades -> {
        val trade = json.decodeFromJsonElement(AlpacaTrade.serializer(), normalized)
        require(trade.price.isFinite() && trade.price > 0 && trade.size.isFinite() && trade.size > 0) {
          "latest response has an invalid trade"
        }
        message = trade
        timestamp = trade.timestamp
      }
    }
    require(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$").matches(timestamp)) {
      "latest timestamp must be a UTC instant"
    }
    val eventAt = Instant.parse(timestamp)
    if (eventAt.isAfter(observedAt) || Duration.between(eventAt, observedAt) > Duration.ofMillis(maximumAgeMs)) null else message
  }
}

internal class LatestMarketDataPoller(
  private val config: LatestMarketDataConfig,
  private val baseUrl: String,
  private val rest: AlpacaRestClient,
  private val nowMs: () -> Long,
) {
  private val acknowledged = mutableMapOf<Pair<String, String>, Envelope<JsonElement>>()
  private val status =
    AtomicReference(
      LatestMarketDataCoverage(config.symbols, config.maximumAgeMs, emptyMap(), emptyMap(), null, emptyMap()),
    )

  fun coverage(): LatestMarketDataCoverage {
    val snapshot = status.get()
    val now = nowMs()
    return snapshot.copy(
      unavailableSymbols =
        LatestMarketDataChannel.entries.associate { channel ->
          channel.id to
            config.symbols.filter { symbol ->
              val eventAt = snapshot.acknowledgedEventAtMs[channel.id]?.get(symbol)
              eventAt == null || now < eventAt || now - eventAt > config.maximumAgeMs
            }
        },
    )
  }

  suspend fun poll(
    sequence: (String) -> Long,
    publish: suspend (Envelope<JsonElement>) -> Unit,
  ) {
    val errors = mutableMapOf<String, String>()
    for (channel in LatestMarketDataChannel.entries) {
      try {
        val completed =
          withTimeoutOrNull(5_000) {
            val body =
              rest.get("${baseUrl.trimEnd('/')}/v2/stocks/${channel.id}/latest") {
                parameter("feed", "iex")
                parameter("symbols", config.symbols.joinToString(","))
              }
            val observedAt = Instant.ofEpochMilli(nowMs())
            val messages = decodeLatestMarketData(body, channel, config.symbols.toSet(), observedAt, config.maximumAgeMs)
            for (message in messages) {
              val envelope =
                requireNotNull(AlpacaMapper.toEnvelope(message, AlpacaMarketType.EQUITY, "iex", EquityFeed.Iex, sequence))
                  .copy(ingestTs = observedAt, source = LATEST_REST_SOURCE)
              val key = channel.id to envelope.symbol
              val previous = acknowledged[key]
              if (previous != null && (envelope.eventTs.isBefore(previous.eventTs) || envelope.payload == previous.payload)) continue
              publish(envelope)
              acknowledged[key] = envelope
            }
            true
          }
        if (completed == null) errors[channel.id] = "timeout"
      } catch (error: CancellationException) {
        throw error
      } catch (error: ResponseException) {
        errors[channel.id] = "http_${error.response.status.value}"
      } catch (error: Exception) {
        errors[channel.id] = error.javaClass.simpleName
      }
      status.set(
        LatestMarketDataCoverage(
          config.symbols,
          config.maximumAgeMs,
          acknowledged.entries.groupBy { it.key.first }.mapValues { (_, rows) ->
            rows.associate {
              it.key.second to
                it.value.eventTs.toEpochMilli()
            }
          },
          emptyMap(),
          nowMs(),
          errors.toMap(),
        ),
      )
    }
  }
}
