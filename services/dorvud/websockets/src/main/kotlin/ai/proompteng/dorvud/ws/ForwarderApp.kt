package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.DedupCache
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.platform.buildProducer
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.system.exitProcess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.JsonPrimitive
import mu.KotlinLogging
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.serialization.kotlinx.json.json
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.readBytes
import io.ktor.websocket.WebSocketSession
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.SerializationException

private val logger = KotlinLogging.logger {}

class ForwarderApp(
  private val config: ForwarderConfig,
  private val producerFactory: (ForwarderConfig) -> KafkaProducer<String, String> = { cfg -> buildProducer(cfg.kafka) },
  private val json: Json = Json { encodeDefaults = true; ignoreUnknownKeys = true },
) {
  private val scope = CoroutineScope(Dispatchers.Default)
  private val ready = AtomicBoolean(false)
  private val httpClient = HttpClient(CIO) {
    install(WebSockets)
    install(ContentNegotiation) { json() }
  }

  fun start(): Job {
    val job = scope.launch {
      logger.info { "dorvud-ws starting with symbols=${config.symbols}" }
      val producer = producerFactory(config)
      val seq = SeqTracker()

      val tradesDedup = DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
      val quotesDedup = DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
      val barsDedup = DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)

      ready.set(true)
      streamAlpaca(producer, seq, tradesDedup, quotesDedup, barsDedup)
    }
    return job
  }

  fun stop() {
    ready.set(false)
    scope.cancel()
  }

  fun isReady(): Boolean = ready.get()

  fun isAlive(): Boolean = scope.coroutineContext.isActive

  private suspend fun streamAlpaca(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradesDedup: DedupCache<String>,
    quotesDedup: DedupCache<String>,
    barsDedup: DedupCache<String>,
  ) {
    val url = "${config.alpacaStreamUrl.trimEnd('/')}/v2/${config.alpacaFeed}"
    httpClient.webSocket(urlString = url) {
      // auth
      val auth = buildJsonObject {
        put("action", "auth")
        put("key", config.alpacaKeyId)
        put("secret", config.alpacaSecretKey)
      }
      sendSerialized(auth)
        val subscribe = buildJsonObject {
          put("action", "subscribe")
          val symbolsJson = buildJsonArray { config.symbols.forEach { add(JsonPrimitive(it)) } }
          put("trades", symbolsJson)
          put("quotes", symbolsJson)
          put("bars", symbolsJson)
        put("updatedBars", symbolsJson)
      }
      sendSerialized(subscribe)

      for (frame in incoming) {
        val text = when (frame) {
          is Frame.Text -> frame.readText()
          is Frame.Binary -> frame.readBytes().decodeToString()
          else -> continue
        }
        val elements = try {
          json.parseToJsonElement(text)
        } catch (e: SerializationException) {
          logger.warn(e) { "failed to parse alpaca frame as JSON; dropping" }
          continue
        }
        val messages: List<JsonElement> =
          if (elements is JsonArray) elements.toList() else listOf(elements)
        messages.forEach { el ->
          val msg = try {
            json.decodeFromJsonElement(AlpacaMessageSerializer, el)
          } catch (e: SerializationException) {
            logger.warn(e) { "failed to decode alpaca message; dropping" }
            return@forEach
          }
          handleMessage(msg, producer, seq, tradesDedup, quotesDedup, barsDedup)
        }
      }
    }
  }

  private suspend fun handleMessage(
    msg: AlpacaMessage,
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradesDedup: DedupCache<String>,
    quotesDedup: DedupCache<String>,
    barsDedup: DedupCache<String>,
  ) {
    when (msg) {
      is AlpacaError -> {
        logger.error { "alpaca error code=${msg.code} msg=${msg.msg}" }
        return
      }
      is AlpacaUnknownMessage -> {
        logger.warn { "alpaca unknown message type=${msg.type}; dropping" }
        return
      }
      is AlpacaTrade -> {
        if (tradesDedup.isDuplicate(msg.id.toString())) return
      }
      is AlpacaQuote -> {
        if (quotesDedup.isDuplicate("${msg.timestamp}-${msg.symbol}")) return
      }
      is AlpacaBar, is AlpacaUpdatedBar -> {
        val symbol = when (msg) {
          is AlpacaBar -> msg.symbol
          is AlpacaUpdatedBar -> msg.symbol
          else -> ""
        }
        val ts = when (msg) {
          is AlpacaBar -> msg.timestamp
          is AlpacaUpdatedBar -> msg.timestamp
          else -> ""
        }
        if (barsDedup.isDuplicate("$ts-$symbol")) return
      }
      else -> {}
    }

    val env = AlpacaMapper.toEnvelope(msg) { symbol -> seq.next(symbol) } ?: return
    val topic = when (env.channel) {
      "trades" -> config.topics.trades
      "quotes" -> config.topics.quotes
      "bars", "updatedBars" -> config.topics.bars1m
      "status" -> config.topics.status
      else -> null
    } ?: return

    val payload = json.encodeToString(env)
    producer.send(ProducerRecord(topic, env.symbol, payload))
  }

  private suspend fun DefaultClientWebSocketSession.sendSerialized(payload: JsonObject) {
    val text = json.encodeToString(payload)
    send(Frame.Text(text))
  }
}

fun main() = runBlocking {
  try {
    val cfg = ForwarderConfig.fromEnv()
    val app = ForwarderApp(cfg)
    val health = HealthServer(app, cfg)
    health.start()
    val job = app.start()
    Runtime.getRuntime().addShutdownHook(Thread {
      health.stop()
      app.stop()
    })
    job.join()
  } catch (e: Exception) {
    logger.error(e) { "forwarder failed to start" }
    exitProcess(1)
  }
}
