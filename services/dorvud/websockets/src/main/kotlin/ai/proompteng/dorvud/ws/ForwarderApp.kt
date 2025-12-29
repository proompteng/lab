package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.DedupCache
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.platform.buildProducer
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.serialization.kotlinx.json.json
import io.ktor.websocket.Frame
import io.ktor.websocket.readBytes
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import mu.KotlinLogging
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.CRC32
import kotlin.system.exitProcess

private val logger = KotlinLogging.logger {}

class ForwarderApp(
  private val config: ForwarderConfig,
  private val producerFactory: (ForwarderConfig) -> KafkaProducer<String, String> = { cfg -> buildProducer(cfg.kafka) },
  private val json: Json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
    },
) {
  private val scope = CoroutineScope(Dispatchers.Default)
  private val ready = AtomicBoolean(false)
  private val wsReady = AtomicBoolean(false)
  private val tradeUpdatesReady = AtomicBoolean(false)
  private val kafkaReady = AtomicBoolean(false)
  private val kafkaFailureCount = AtomicInteger(0)
  private val backfillDone = AtomicBoolean(false)
  private val tradeUpdatesEnabled =
    config.enableTradeUpdates && !config.alpacaTradeStreamUrl.isNullOrBlank() && config.topics.tradeUpdates != null
  private val httpClient =
    HttpClient(CIO) {
      install(WebSockets)
      install(ContentNegotiation) { json() }
    }
  private val metrics = ForwarderMetrics(Metrics.registry)
  private val reconnectBackoff = ReconnectBackoff(config.reconnectBaseMs, config.reconnectMaxMs)

  fun start(): Job {
    val job =
      scope.launch {
        logger.info {
          "dorvud-ws starting shard=${config.shardIndex}/${config.shardCount} " +
            "jangarSymbolsUrl=${config.jangarSymbolsUrl}"
        }
        val producer = producerFactory(config)
        val seq = SeqTracker()

        val tradesDedup = DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
        val quotesDedup = DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
        val barsDedup = DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
        val tradeUpdatesDedup =
          if (tradeUpdatesEnabled) {
            DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
          } else {
            null
          }

        val symbolsTracker =
          SymbolsTracker(
            normalizeSymbols(config.staticSymbols),
            config.jangarSymbolsUrl?.let { url ->
              suspend { normalizeSymbols(fetchDesiredSymbols(url)) }
            },
          )

        val jobs = mutableListOf<Job>()
        jobs +=
          launch {
            streamMarketDataLoop(
              producer,
              seq,
              tradesDedup,
              quotesDedup,
              barsDedup,
              symbolsTracker,
            )
          }

        if (tradeUpdatesEnabled) {
          val tradeStreamUrl = config.alpacaTradeStreamUrl
          val tradeTopic = config.topics.tradeUpdates
          if (tradeStreamUrl.isNullOrBlank() || tradeTopic == null) {
            logger.warn {
              "trade_updates enabled but ALPACA_TRADE_STREAM_URL or TOPIC_TRADE_UPDATES missing; skipping"
            }
          } else {
            jobs +=
              launch {
                streamTradeUpdatesLoop(
                  producer,
                  seq,
                  tradeUpdatesDedup
                    ?: DedupCache(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries),
                  tradeStreamUrl,
                  tradeTopic,
                )
              }
          }
        } else if (config.enableTradeUpdates) {
          logger.warn {
            "trade_updates enabled but missing ALPACA_TRADE_STREAM_URL or TOPIC_TRADE_UPDATES; " +
              "readiness will ignore trade updates"
          }
        }

        try {
          jobs.joinAll()
        } finally {
          markReady(false)
          wsReady.set(false)
          tradeUpdatesReady.set(false)
          kafkaReady.set(false)
          runCatching { producer.flush() }
          runCatching { producer.close() }
          runCatching { httpClient.close() }
        }
      }
    return job
  }

  fun stop() {
    markReady(false)
    scope.cancel()
  }

  fun isReady(): Boolean = ready.get()

  fun isAlive(): Boolean = scope.coroutineContext.isActive

  private suspend fun streamMarketDataLoop(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradesDedup: DedupCache<String>,
    quotesDedup: DedupCache<String>,
    barsDedup: DedupCache<String>,
    symbolsTracker: SymbolsTracker,
  ) {
    var attempt = 0
    while (scope.isActive) {
      try {
        ensureKafkaReady(producer)
        streamMarketDataSession(producer, seq, tradesDedup, quotesDedup, barsDedup, symbolsTracker) {
          attempt = 0
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        logger.warn(e) { "alpaca ws session ended" }
      } finally {
        setWsReady(false)
      }

      if (!scope.isActive) break
      attempt += 1
      metrics.reconnects.increment()
      val delayMs = reconnectBackoff.nextDelay(attempt)
      logger.warn { "alpaca ws reconnecting in ${delayMs}ms (attempt=$attempt)" }
      delay(delayMs)
    }
  }

  private suspend fun streamTradeUpdatesLoop(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradeUpdatesDedup: DedupCache<String>,
    streamUrl: String,
    topic: String,
  ) {
    var attempt = 0
    while (scope.isActive) {
      try {
        ensureKafkaReady(producer)
        streamTradeUpdatesSession(producer, seq, tradeUpdatesDedup, streamUrl, topic) {
          attempt = 0
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        logger.warn(e) { "alpaca trade_updates session ended" }
      } finally {
        setTradeUpdatesReady(false)
      }

      if (!scope.isActive) break
      attempt += 1
      metrics.reconnects.increment()
      val delayMs = reconnectBackoff.nextDelay(attempt)
      logger.warn { "alpaca trade_updates reconnecting in ${delayMs}ms (attempt=$attempt)" }
      delay(delayMs)
    }
  }

  private suspend fun streamMarketDataSession(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradesDedup: DedupCache<String>,
    quotesDedup: DedupCache<String>,
    barsDedup: DedupCache<String>,
    symbolsTracker: SymbolsTracker,
    onReady: () -> Unit,
  ) {
    val url = "${config.alpacaStreamUrl.trimEnd('/')}/v2/${config.alpacaFeed}"
    httpClient.webSocket(urlString = url) {
      val auth =
        buildJsonObject {
          put("action", "auth")
          put("key", config.alpacaKeyId)
          put("secret", config.alpacaSecretKey)
        }
      sendSerialized(auth)

      val subscribedSymbols = mutableSetOf<String>()
      val subscribedLock = Mutex()
      var authOk = false
      var subscribedOk = false
      var readyNotified = false

      fun updateWsReady() {
        val nowReady = authOk && subscribedOk
        setWsReady(nowReady)
        if (nowReady && !readyNotified) {
          onReady()
          readyNotified = true
        }
      }

      suspend fun applySubscribe(symbols: List<String>) {
        if (symbols.isEmpty()) return
        symbols.chunked(config.subscribeBatchSize).forEach { batch ->
          val subscribe =
            buildJsonObject {
              put("action", "subscribe")
              val symbolsJson = buildJsonArray { batch.forEach { add(JsonPrimitive(it)) } }
              put("trades", symbolsJson)
              put("quotes", symbolsJson)
              put("bars", symbolsJson)
              put("updatedBars", symbolsJson)
            }
          sendSerialized(subscribe)
        }
      }

      suspend fun applyUnsubscribe(symbols: List<String>) {
        if (symbols.isEmpty()) return
        symbols.chunked(config.subscribeBatchSize).forEach { batch ->
          val unsubscribe =
            buildJsonObject {
              put("action", "unsubscribe")
              val symbolsJson = buildJsonArray { batch.forEach { add(JsonPrimitive(it)) } }
              put("trades", symbolsJson)
              put("quotes", symbolsJson)
              put("bars", symbolsJson)
              put("updatedBars", symbolsJson)
            }
          sendSerialized(unsubscribe)
        }
      }

      suspend fun desiredSymbols(): SymbolsRefreshResult {
        val refreshed = symbolsTracker.refresh()
        if (refreshed.hadError) {
          logger.warn { "failed to poll desired symbols; keeping last-known list" }
        }
        return refreshed
      }

      val initial = desiredSymbols().symbols
      if (initial.isEmpty()) {
        logger.warn { "dorvud-ws received empty symbol list" }
      } else {
        logger.info { "dorvud-ws initial symbols=$initial count=${initial.size}" }
      }

      subscribedLock.withLock {
        subscribedSymbols.clear()
        subscribedSymbols.addAll(initial)
      }
      applySubscribe(initial)
      maybeBackfillBars(producer, seq, initial)

      val poller =
        config.jangarSymbolsUrl?.let {
          launch {
            while (isActive) {
              delay(config.symbolsPollIntervalMs)
              val desired = desiredSymbols().symbols
              val (toAdd, toRemove) =
                subscribedLock.withLock {
                  val add = desired.filter { !subscribedSymbols.contains(it) }
                  val remove = subscribedSymbols.filter { !desired.contains(it) }
                  subscribedSymbols.addAll(add)
                  remove.forEach { subscribedSymbols.remove(it) }
                  add to remove
                }

              if (toAdd.isNotEmpty()) {
                logger.info { "subscribing ${toAdd.size} symbols" }
                applySubscribe(toAdd)
              }
              if (toRemove.isNotEmpty()) {
                logger.info { "unsubscribing ${toRemove.size} symbols" }
                applyUnsubscribe(toRemove)
              }
              maybeBackfillBars(producer, seq, desired)
            }
          }
        }

      try {
        for (frame in incoming) {
          val text =
            when (frame) {
              is Frame.Text -> frame.readText()
              is Frame.Binary -> frame.readBytes().decodeToString()
              else -> continue
            }
          val elements =
            try {
              json.parseToJsonElement(text)
            } catch (e: SerializationException) {
              logger.warn(e) { "failed to parse alpaca frame as JSON; dropping" }
              continue
            }
          val messages: List<JsonElement> =
            if (elements is JsonArray) elements.toList() else listOf(elements)
          messages.forEach { el ->
            val msg =
              try {
                json.decodeFromJsonElement(AlpacaMessageSerializer, el)
              } catch (e: SerializationException) {
                logger.warn(e) { "failed to decode alpaca message; dropping" }
                return@forEach
              }

            when (msg) {
              is AlpacaSuccess -> {
                if (msg.msg.contains("auth", ignoreCase = true)) {
                  authOk = true
                  updateWsReady()
                }
                return@forEach
              }
              is AlpacaSubscription -> {
                subscribedOk = true
                updateWsReady()
                return@forEach
              }
              is AlpacaError -> {
                authOk = false
                subscribedOk = false
                updateWsReady()
                logger.error { "alpaca error code=${msg.code} msg=${msg.msg}" }
                return@forEach
              }
              else -> handleMessage(msg, producer, seq, tradesDedup, quotesDedup, barsDedup)
            }
          }
        }
      } finally {
        poller?.cancel()
      }
    }
  }

  private suspend fun streamTradeUpdatesSession(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradeUpdatesDedup: DedupCache<String>,
    streamUrl: String,
    topic: String,
    onReady: () -> Unit,
  ) {
    httpClient.webSocket(urlString = streamUrl) {
      val auth =
        buildJsonObject {
          put("action", "auth")
          put("key", config.alpacaKeyId)
          put("secret", config.alpacaSecretKey)
        }
      sendSerialized(auth)

      val listen =
        buildJsonObject {
          put("action", "listen")
          put(
            "data",
            buildJsonObject {
              put("streams", buildJsonArray { add(JsonPrimitive("trade_updates")) })
            },
          )
        }
      sendSerialized(listen)

      var authOk = false
      var subscribedOk = false
      var readyNotified = false

      fun updateReady() {
        val nowReady = authOk && subscribedOk
        setTradeUpdatesReady(nowReady)
        if (nowReady && !readyNotified) {
          onReady()
          readyNotified = true
        }
      }

      for (frame in incoming) {
        val text =
          when (frame) {
            is Frame.Text -> frame.readText()
            is Frame.Binary -> frame.readBytes().decodeToString()
            else -> continue
          }
        val element =
          try {
            json.parseToJsonElement(text)
          } catch (e: SerializationException) {
            logger.warn(e) { "failed to parse trade_updates frame as JSON; dropping" }
            continue
          }
        val obj = element as? JsonObject ?: continue
        val stream = obj["stream"]?.jsonPrimitive?.contentOrNull ?: continue
        when (stream) {
          "authorization" -> {
            val status =
              obj["data"]
                ?.jsonObject
                ?.get("status")
                ?.jsonPrimitive
                ?.contentOrNull
            if (status.equals("authorized", ignoreCase = true)) {
              authOk = true
              updateReady()
            } else {
              authOk = false
              updateReady()
            }
          }
          "listening" -> {
            subscribedOk = true
            updateReady()
          }
          "trade_updates" -> {
            val data = obj["data"] as? JsonObject ?: continue
            handleTradeUpdate(data, producer, seq, tradeUpdatesDedup, topic)
          }
        }
      }
    }
  }

  @Serializable
  private data class JangarSymbolsResponse(
    val symbols: List<String>,
  )

  private suspend fun fetchDesiredSymbols(url: String): List<String> {
    val response: JangarSymbolsResponse = httpClient.get(url).body()
    return response.symbols
  }

  private fun normalizeSymbols(symbols: List<String>): List<String> =
    symbols
      .map { it.trim().uppercase() }
      .filter { it.isNotEmpty() }
      .filter { ownsSymbol(it) }
      .distinct()

  private fun ownsSymbol(symbol: String): Boolean {
    if (config.shardCount <= 1) return true
    val crc = CRC32()
    crc.update(symbol.toByteArray(StandardCharsets.UTF_8))
    val bucket = (crc.value % config.shardCount.toLong()).toInt()
    return bucket == config.shardIndex
  }

  private fun handleTradeUpdate(
    data: JsonObject,
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradeUpdatesDedup: DedupCache<String>,
    topic: String,
  ) {
    val order = data["order"] as? JsonObject
    val symbol = order?.get("symbol")?.jsonPrimitive?.contentOrNull ?: "UNKNOWN"
    val eventTs =
      data["timestamp"]?.jsonPrimitive?.contentOrNull
        ?: data["t"]?.jsonPrimitive?.contentOrNull
        ?: order?.get("submitted_at")?.jsonPrimitive?.contentOrNull
        ?: Instant.now().toString()

    val dedupKey =
      order?.get("id")?.jsonPrimitive?.contentOrNull
        ?: order?.get("client_order_id")?.jsonPrimitive?.contentOrNull

    if (dedupKey != null && tradeUpdatesDedup.isDuplicate(dedupKey)) {
      metrics.recordDedup("trade_updates")
      return
    }

    val env: Envelope<JsonElement> =
      Envelope(
        ingestTs = Instant.now(),
        eventTs = runCatching { Instant.parse(eventTs) }.getOrElse { Instant.now() },
        feed = "alpaca",
        channel = "trade_updates",
        symbol = symbol,
        seq = seq.next(symbol),
        payload = data,
        isFinal = true,
        source = "ws",
      )

    recordLag(env)
    sendKafka(producer, topic, env)
  }

  private suspend fun maybeBackfillBars(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    symbols: List<String>,
  ) {
    if (!config.enableBarsBackfill) return
    if (symbols.isEmpty()) return
    if (!backfillDone.compareAndSet(false, true)) return

    try {
      val bars = fetchBackfillBars(symbols)
      if (bars.isEmpty()) {
        logger.warn { "backfill returned 0 bars" }
        return
      }

      logger.info { "backfill sending ${bars.size} bars" }
      bars.forEach { bar ->
        val env =
          Envelope(
            ingestTs = Instant.now(),
            eventTs = Instant.parse(bar.timestamp),
            feed = "alpaca",
            channel = "bars",
            symbol = bar.symbol,
            seq = seq.next(bar.symbol),
            payload = json.encodeToJsonElement(AlpacaBar.serializer(), bar),
            isFinal = true,
            source = "rest",
          )
        recordLag(env)
        sendKafka(producer, config.topics.bars1m, env)
      }
    } catch (e: Exception) {
      backfillDone.set(false)
      logger.warn(e) { "backfill failed; will retry when symbols refresh" }
    }
  }

  @Serializable
  private data class AlpacaBarsResponse(
    val bars: JsonElement? = null,
    val symbol: String? = null,
  )

  private suspend fun fetchBackfillBars(symbols: List<String>): List<AlpacaBar> {
    if (symbols.isEmpty()) return emptyList()
    return symbols.chunked(config.subscribeBatchSize).flatMap { chunk ->
      fetchBackfillBarsChunk(chunk)
    }
  }

  private suspend fun fetchBackfillBarsChunk(symbols: List<String>): List<AlpacaBar> {
    if (symbols.isEmpty()) return emptyList()
    val url = "${config.alpacaBaseUrl.trimEnd('/')}/v2/stocks/bars"

    val response: AlpacaBarsResponse =
      httpClient
        .get(url) {
          parameter("symbols", symbols.joinToString(","))
          parameter("timeframe", "1Min")
          parameter("limit", "100")
          parameter("feed", config.alpacaFeed)
          header("APCA-API-KEY-ID", config.alpacaKeyId)
          header("APCA-API-SECRET-KEY", config.alpacaSecretKey)
        }.body()

    val barsElement = response.bars ?: return emptyList()

    return when (barsElement) {
      is JsonArray -> decodeBarsArray(barsElement, response.symbol)
      is JsonObject ->
        barsElement.entries.flatMap { (symbol, entry) ->
          val arr = entry as? JsonArray ?: return@flatMap emptyList()
          decodeBarsArray(arr, symbol)
        }
      else -> emptyList()
    }
  }

  private fun decodeBarsArray(
    bars: JsonArray,
    symbolFallback: String?,
  ): List<AlpacaBar> {
    return bars.mapNotNull { barEl ->
      val obj = barEl as? JsonObject ?: return@mapNotNull null
      val symbol = obj["S"]?.jsonPrimitive?.contentOrNull ?: symbolFallback
      if (symbol.isNullOrBlank()) return@mapNotNull null

      val withSymbol =
        if (obj.containsKey("S")) {
          obj
        } else {
          JsonObject(obj + ("S" to JsonPrimitive(symbol)))
        }

      runCatching { json.decodeFromJsonElement(AlpacaBar.serializer(), withSymbol) }.getOrNull()
    }
  }

  private fun ensureKafkaReady(producer: KafkaProducer<String, String>) {
    val topics =
      buildList {
        add(config.topics.trades)
        add(config.topics.quotes)
        add(config.topics.bars1m)
        add(config.topics.status)
        config.topics.tradeUpdates?.let { add(it) }
      }

    val readyNow =
      runCatching {
        topics.forEach { producer.partitionsFor(it) }
      }.isSuccess

    if (readyNow) {
      kafkaFailureCount.set(0)
    }
    setKafkaReady(readyNow)
  }

  private fun handleMessage(
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
        if (tradesDedup.isDuplicate(msg.id.toString())) {
          metrics.recordDedup("trades")
          return
        }
      }
      is AlpacaQuote -> {
        if (quotesDedup.isDuplicate("${msg.timestamp}-${msg.symbol}")) {
          metrics.recordDedup("quotes")
          return
        }
      }
      is AlpacaBar, is AlpacaUpdatedBar -> {
        val symbol =
          when (msg) {
            is AlpacaBar -> msg.symbol
            is AlpacaUpdatedBar -> msg.symbol
          }
        val ts =
          when (msg) {
            is AlpacaBar -> msg.timestamp
            is AlpacaUpdatedBar -> msg.timestamp
          }
        if (barsDedup.isDuplicate("$ts-$symbol")) {
          metrics.recordDedup("bars")
          return
        }
      }
      else -> {}
    }

    val env = AlpacaMapper.toEnvelope(msg) { symbol -> seq.next(symbol) } ?: return
    recordLag(env)

    val topic =
      when (env.channel) {
        "trades" -> config.topics.trades
        "quotes" -> config.topics.quotes
        "bars", "updatedBars" -> config.topics.bars1m
        "status" -> config.topics.status
        else -> null
      } ?: return

    sendKafka(producer, topic, env)
  }

  private fun sendKafka(
    producer: KafkaProducer<String, String>,
    topic: String,
    env: Envelope<JsonElement>,
  ) {
    val payload = json.encodeToString(env)
    val record = ProducerRecord(topic, env.symbol, payload)
    val start = System.nanoTime()
    try {
      producer.send(record) { _, exception ->
        val elapsed = Duration.ofNanos(System.nanoTime() - start)
        metrics.recordKafkaLatency(elapsed)
        if (exception != null) {
          metrics.kafkaSendErrors.increment()
          recordKafkaFailure(exception)
        } else {
          recordKafkaSuccess()
        }
      }
    } catch (e: Exception) {
      metrics.kafkaSendErrors.increment()
      recordKafkaFailure(e)
    }
  }

  private fun recordLag(env: Envelope<*>) {
    val lagMs = Duration.between(env.eventTs, env.ingestTs).toMillis()
    metrics.recordLagMs(lagMs)
  }

  private fun recordKafkaFailure(exception: Exception) {
    val failures = kafkaFailureCount.incrementAndGet()
    if (failures >= 3) {
      logger.warn(exception) { "kafka send failures reached $failures; marking not-ready" }
      setKafkaReady(false)
    }
  }

  private fun recordKafkaSuccess() {
    kafkaFailureCount.set(0)
    if (!kafkaReady.get()) {
      setKafkaReady(true)
    }
  }

  private fun setKafkaReady(value: Boolean) {
    kafkaReady.set(value)
    markReady(value && wsReady.get() && tradeUpdatesGate())
  }

  private fun setWsReady(value: Boolean) {
    wsReady.set(value)
    markReady(value && kafkaReady.get() && tradeUpdatesGate())
  }

  private fun setTradeUpdatesReady(value: Boolean) {
    tradeUpdatesReady.set(value)
    markReady(wsReady.get() && kafkaReady.get() && tradeUpdatesGate())
  }

  private fun tradeUpdatesGate(): Boolean = if (tradeUpdatesEnabled) tradeUpdatesReady.get() else true

  private fun markReady(value: Boolean) {
    ready.set(value)
  }

  private suspend fun DefaultClientWebSocketSession.sendSerialized(payload: JsonObject) {
    val text = json.encodeToString(payload)
    send(Frame.Text(text))
  }
}

fun main() =
  runBlocking {
    try {
      val cfg = ForwarderConfig.fromEnv()
      val app = ForwarderApp(cfg)
      val health = HealthServer(app, cfg)
      health.start()
      val job = app.start()
      Runtime.getRuntime().addShutdownHook(
        Thread {
          health.stop()
          app.stop()
        },
      )
      job.join()
    } catch (e: Exception) {
      logger.error(e) { "forwarder failed to start" }
      exitProcess(1)
    }
  }
