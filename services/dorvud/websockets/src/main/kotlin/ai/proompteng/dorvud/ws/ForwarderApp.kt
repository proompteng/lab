package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.DedupCache
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.platform.buildProducer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.POJONode
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
import io.ktor.client.request.url
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
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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
import org.msgpack.jackson.dataformat.MessagePackExtensionType
import org.msgpack.jackson.dataformat.MessagePackFactory
import org.msgpack.jackson.dataformat.TimestampExtensionModule
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.CRC32
import kotlin.system.exitProcess

private val logger = KotlinLogging.logger {}
private val marketSessionZoneId: ZoneId = ZoneId.of("America/New_York")
private const val DEFAULT_ALPACA_BARS_BACKFILL_LOOKBACK_HOURS = 12L
private const val ALPACA_BARS_BACKFILL_LIMIT = 10_000
private const val ALPACA_TRADES_BACKFILL_LIMIT = 10_000
private const val WEBSOCKET_PING_INTERVAL_MS = 20_000L
private const val MESSAGE_PACK_TIMESTAMP_32_UNSIGNED_MASK = 0xffffffffL
private const val MESSAGE_PACK_TIMESTAMP_64_NANO_SHIFT = 34
private const val MESSAGE_PACK_TIMESTAMP_64_SECONDS_MASK = 0x00000003ffffffffL

internal fun alpacaMarketDataStreamUrl(config: ForwarderConfig): String =
  alpacaMarketDataStreamUrl(config, config.marketDataFeedConfigs().first())

internal fun alpacaMarketDataStreamUrl(
  config: ForwarderConfig,
  feed: FeedRuntimeConfig,
): String =
  when (config.alpacaMarketType) {
    AlpacaMarketType.EQUITY -> {
      val equityFeed = requireNotNull(feed.equityFeed) { "equity runtime requires a typed equity feed" }
      "${config.alpacaStreamUrl.trimEnd('/')}/${equityFeed.apiVersion}/${equityFeed.id}"
    }
    AlpacaMarketType.CRYPTO ->
      "${config.alpacaStreamUrl.trimEnd('/')}/v1beta3/crypto/${config.alpacaCryptoLocation}"
    AlpacaMarketType.OPTIONS -> "${config.alpacaStreamUrl.trimEnd('/')}/v1beta1/${feed.feed}"
  }

internal fun marketDataIdleRequiresReconnect(
  sessionReady: Boolean,
  now: Instant,
  marketType: AlpacaMarketType,
  marketHolidays: Set<LocalDate>,
  equityFeed: EquityFeed?,
): Boolean =
  !sessionReady ||
    marketDataFreshnessGateActive(
      marketSessionState(now, marketType, marketHolidays),
      equityFeed,
    )

internal fun alpacaBarsBackfillUrl(config: ForwarderConfig): String =
  when (config.alpacaMarketType) {
    AlpacaMarketType.EQUITY -> "${config.alpacaBaseUrl.trimEnd('/')}/v2/stocks/bars"
    AlpacaMarketType.CRYPTO ->
      "${config.alpacaBaseUrl.trimEnd('/')}/v1beta3/crypto/${config.alpacaCryptoLocation}/bars"
    AlpacaMarketType.OPTIONS -> error("options bars backfill is not supported on the websocket lane")
  }

internal fun alpacaTradesBackfillUrl(config: ForwarderConfig): String =
  when (config.alpacaMarketType) {
    AlpacaMarketType.EQUITY -> "${config.alpacaBaseUrl.trimEnd('/')}/v2/stocks/trades"
    AlpacaMarketType.CRYPTO -> error("crypto trades backfill is not supported on the websocket lane")
    AlpacaMarketType.OPTIONS -> error("options trades backfill is not supported on the websocket lane")
  }

internal fun alpacaBarsBackfillNeedsFeed(config: ForwarderConfig): Boolean = config.alpacaMarketType != AlpacaMarketType.CRYPTO

internal fun alpacaBarsBackfillFeed(config: ForwarderConfig): String? =
  when {
    !alpacaBarsBackfillNeedsFeed(config) -> null
    config.alpacaFeed.equals("overnight", ignoreCase = true) -> "boats"
    else -> config.alpacaFeed
  }

internal data class AlpacaBarsBackfillWindow(
  val start: Instant,
  val end: Instant,
)

internal fun alpacaBarsBackfillWindow(
  now: Instant,
  lookbackHours: Long = DEFAULT_ALPACA_BARS_BACKFILL_LOOKBACK_HOURS,
): AlpacaBarsBackfillWindow =
  AlpacaBarsBackfillWindow(
    start = now.minus(Duration.ofHours(lookbackHours)),
    end = now,
  )

internal data class AlpacaBarsBackfillQuery(
  val symbols: String,
  val timeframe: String,
  val start: String,
  val end: String,
  val limit: String,
  val sort: String,
  val feed: String?,
  val pageToken: String?,
)

internal fun alpacaBarsBackfillQuery(
  config: ForwarderConfig,
  symbols: List<String>,
  now: Instant,
  pageToken: String? = null,
): AlpacaBarsBackfillQuery {
  val window = alpacaBarsBackfillWindow(now, config.barsBackfillLookbackHours)
  return AlpacaBarsBackfillQuery(
    symbols = symbols.joinToString(","),
    timeframe = "1Min",
    start = window.start.toString(),
    end = window.end.toString(),
    limit = ALPACA_BARS_BACKFILL_LIMIT.toString(),
    sort = "asc",
    feed = alpacaBarsBackfillFeed(config),
    pageToken = pageToken,
  )
}

internal data class AlpacaTradesBackfillQuery(
  val symbols: String,
  val start: String,
  val end: String,
  val limit: String,
  val sort: String,
  val feed: String?,
  val pageToken: String?,
)

internal fun alpacaTradesBackfillQuery(
  config: ForwarderConfig,
  symbols: List<String>,
  now: Instant,
  pageToken: String? = null,
): AlpacaTradesBackfillQuery =
  AlpacaTradesBackfillQuery(
    symbols = symbols.joinToString(","),
    start = now.minus(Duration.ofHours(config.tradesBackfillLookbackHours)).toString(),
    end = now.toString(),
    limit = ALPACA_TRADES_BACKFILL_LIMIT.toString(),
    sort = "desc",
    feed = config.alpacaFeed,
    pageToken = pageToken,
  )

internal fun alpacaMarketDataChannels(config: ForwarderConfig): List<String> = config.alpacaMarketDataChannels

internal fun barDedupKey(
  message: AlpacaMessage,
  feed: String? = null,
): String? =
  when (message) {
    is AlpacaBar -> listOfNotNull(feed, "bars", "${message.timestamp}-${message.symbol}").joinToString(":")
    is AlpacaUpdatedBar -> listOfNotNull(feed, "updatedBars", "${message.timestamp}-${message.symbol}").joinToString(":")
    else -> null
  }

@Serializable
internal data class AlpacaBarsResponse(
  val bars: JsonElement? = null,
  val symbol: String? = null,
  @SerialName("next_page_token")
  val nextPageToken: String? = null,
)

@Serializable
internal data class AlpacaTradesResponse(
  val trades: JsonElement? = null,
  val symbol: String? = null,
  @SerialName("next_page_token")
  val nextPageToken: String? = null,
)

internal fun decodeAlpacaBarsResponse(
  payload: String,
  json: Json,
): AlpacaBarsResponse = json.decodeFromString(payload)

internal fun decodeAlpacaTradesResponse(
  payload: String,
  json: Json,
): AlpacaTradesResponse = json.decodeFromString(payload)

private class MarketDataFeedRuntimeState(
  val config: FeedRuntimeConfig,
  appConfig: ForwarderConfig,
  nowMs: () -> Long,
) {
  val sequence = SeqTracker()
  val tradesDedup = DedupCache<String>(Duration.ofSeconds(appConfig.dedupTtlSeconds), appConfig.dedupMaxEntries)
  val quotesDedup = DedupCache<String>(Duration.ofSeconds(appConfig.dedupTtlSeconds), appConfig.dedupMaxEntries)
  val barsDedup = DedupCache<String>(Duration.ofSeconds(appConfig.dedupTtlSeconds), appConfig.dedupMaxEntries)
  val websocketReady = AtomicBoolean(false)
  val kafkaReady = AtomicBoolean(false)
  val websocketStatus = AtomicReference(AlpacaMarketDataWebsocketStatus())
  val errorClass = AtomicReference<ReadinessErrorClass?>(null)
  val kafkaFailureCount = AtomicInteger(0)
  val envelopeDropLogged = AtomicBoolean(false)
  val backfillDone = AtomicBoolean(false)
  val tradesBackfillDone = AtomicBoolean(false)
  val reconnectBackoff = ReconnectBackoff(appConfig.reconnectBaseMs, appConfig.reconnectMaxMs)
  val channelFreshness =
    MarketDataChannelFreshnessTracker(
      requiredChannels = config.channels,
      maxLagMs = appConfig.marketDataChannelFreshnessMaxMs,
      warmupMs = appConfig.marketDataChannelFreshnessWarmupMs,
      nowMs = nowMs,
      marketType = appConfig.alpacaMarketType,
      marketHolidays = appConfig.optionsMarketHolidays,
      equityFeed = config.equityFeed,
    )

  fun readiness(): MarketDataFeedReadiness {
    val channels = channelFreshness.snapshot()
    val websocket = websocketStatus.get()
    val ready = websocketReady.get() && kafkaReady.get() && channels.all { it.ready }
    return MarketDataFeedReadiness(
      feed = config.feed,
      core = config.core,
      ready = ready,
      authOk = websocket.authOk,
      subscriptionOk = websocket.subscriptionOk,
      kafkaReady = kafkaReady.get(),
      errorClass = errorClass.get()?.id ?: websocket.errorClass,
      channels = channels,
    )
  }
}

class ForwarderApp(
  private val config: ForwarderConfig,
  private val producerFactory: (ForwarderConfig) -> KafkaProducer<String, String> = { cfg -> buildProducer(cfg.kafka) },
  private val nowMs: () -> Long = { System.currentTimeMillis() },
  private val json: Json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
    },
) {
  private val jsonObjectMapper = ObjectMapper()
  private val msgPackMapper = ObjectMapper(MessagePackFactory())
  private val scope = CoroutineScope(Dispatchers.Default)
  private val optionsWsLastSuccessTs = AtomicReference<Instant?>(null)
  private val ready = AtomicBoolean(false)
  private val wsReady = AtomicBoolean(false)
  private val tradeUpdatesReady = AtomicBoolean(false)
  private val kafkaReady = AtomicBoolean(false)
  private val readinessErrorClass = AtomicReference<ReadinessErrorClass?>(null)
  private val alpacaErrorClass = AtomicReference<ReadinessErrorClass?>(null)
  private val tradeUpdatesErrorClass = AtomicReference<ReadinessErrorClass?>(null)
  private val kafkaErrorClass = AtomicReference<ReadinessErrorClass?>(null)
  private val reportedNotReadyClass = AtomicReference<ReadinessErrorClass?>(null)
  private val notReadyLivenessGate = NotReadyLivenessGate(config.healthNotReadyKillAfterMs, nowMs)
  private val notReadyLivenessLogged = AtomicBoolean(false)
  private val tradeUpdatesEnabled =
    config.enableTradeUpdates && !config.alpacaTradeStreamUrl.isNullOrBlank() && config.topics.tradeUpdates != null
  private val httpClient =
    HttpClient(CIO) {
      install(WebSockets) { pingInterval = WEBSOCKET_PING_INTERVAL_MS }
      install(ContentNegotiation) { json(this@ForwarderApp.json) }
    }
  private val metrics = ForwarderMetrics(Metrics.registry)
  private val marketDataFeeds = config.marketDataFeedConfigs().map { MarketDataFeedRuntimeState(it, config, nowMs) }
  private val coreMarketDataFeed = marketDataFeeds.single { it.config.core }
  private val tradeUpdatesReconnectBackoff = ReconnectBackoff(config.reconnectBaseMs, config.reconnectMaxMs)

  fun start(): Job {
    val job =
      scope.launch {
        logger.info {
          "dorvud-ws starting shard=${config.shardIndex}/${config.shardCount} " +
            "jangarSymbolsUrl=${config.jangarSymbolsUrl} feeds=${marketDataFeeds.map { it.config.feed }} " +
            "universeId=${config.universeContract?.id} universeSymbolHash=${config.universeContract?.symbolHash}"
        }
        val producer = producerFactory(config)
        val tradeUpdatesSequence = SeqTracker()
        val tradeUpdatesDedup =
          if (tradeUpdatesEnabled) {
            DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
          } else {
            null
          }

        val jobs =
          marketDataFeeds
            .map { feed ->
              launch {
                val symbolsTracker =
                  SymbolsTracker(
                    normalizeSymbols(feed.config.symbols),
                    config.jangarSymbolsUrl?.takeIf { feed.config.core }?.let { url ->
                      suspend {
                        runCatching { fetchDesiredSymbols(url) }
                          .getOrElse { err -> throw RuntimeException("jangar desired symbols fetch failed url=$url", err) }
                          .let(::normalizeSymbols)
                      }
                    },
                  )
                streamMarketDataLoop(producer, feed, symbolsTracker)
              }
            }.toMutableList()

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
                  tradeUpdatesSequence,
                  tradeUpdatesDedup
                    ?: DedupCache(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries),
                  tradeStreamUrl,
                  tradeTopic,
                  config.topics.tradeUpdatesV2,
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
          marketDataFeeds.forEach { feed ->
            feed.websocketReady.set(false)
            feed.kafkaReady.set(false)
          }
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

  fun isReady(): Boolean {
    refreshReadinessFromMarketDataChannels()
    return ready.get()
  }

  fun readinessInfo(): ReadinessInfo {
    refreshReadinessFromMarketDataChannels()
    val readyNow = ready.get()
    val gates = currentReadinessGates()
    val errorClassId = currentReadinessErrorClass(readyNow, gates)?.id
    val channelSnapshot = marketDataChannelSnapshot()
    val feedSnapshot = marketDataFeeds.map { it.readiness() }
    feedSnapshot.forEach { feed -> metrics.setMarketDataChannelReadiness(feed.feed, feed.channels) }
    return ReadinessInfo(
      status = if (readyNow) "ready" else "not_ready",
      ready = readyNow,
      errorClass = errorClassId,
      gates = gates,
      alpacaMarketDataWs = coreMarketDataFeed.websocketStatus.get(),
      marketDataChannels = channelSnapshot,
      marketDataFeeds = feedSnapshot,
      marketDataUniverse =
        config.universeContract?.let { contract ->
          MarketDataUniverseInfo(
            id = contract.id,
            symbolHash = contract.symbolHash,
            symbols = contract.symbols,
          )
        },
    )
  }

  fun isAlive(): Boolean {
    if (!scope.coroutineContext.isActive) return false
    val staleNotReady = notReadyLivenessGate.shouldFailLiveness()
    if (staleNotReady && notReadyLivenessLogged.compareAndSet(false, true)) {
      val gates = currentReadinessGates()
      val errorClass = currentReadinessErrorClass(ready.get(), gates)?.id ?: ReadinessErrorClass.Unknown.id
      logger.error {
        "liveness failing after readiness remained false for >=${config.healthNotReadyKillAfterMs}ms " +
          "error_class=$errorClass gates=alpaca_ws:${gates.alpacaWs} kafka:${gates.kafka} " +
          "trade_updates:${gates.tradeUpdates} market_data_channels:${gates.marketDataChannels}"
      }
    }
    return !staleNotReady
  }

  private suspend fun streamMarketDataLoop(
    producer: KafkaProducer<String, String>,
    feed: MarketDataFeedRuntimeState,
    symbolsTracker: SymbolsTracker,
  ) {
    var attempt = 0
    while (scope.isActive) {
      try {
        ensureKafkaReady(producer, feed)
        streamMarketDataSession(producer, feed, symbolsTracker) {
          attempt = 0
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        ReadinessClassifier.classifyAlpacaHandshakeFailure(e)?.let { errorClass ->
          metrics.recordWsConnectError(errorClass)
          metrics.recordMarketDataWsConnectError(feed.config.feed, errorClass)
          recordFeedError(feed, errorClass)
        }
        logger.warn(e) { "alpaca ws session ended feed=${feed.config.feed}" }
      } finally {
        setFeedWsReady(feed, false)
      }

      if (!scope.isActive) break
      attempt += 1
      metrics.reconnects.increment()
      metrics.recordMarketDataReconnect(feed.config.feed)
      val delayMs = feed.reconnectBackoff.nextDelay(attempt)
      logger.warn { "alpaca ws reconnecting feed=${feed.config.feed} in ${delayMs}ms (attempt=$attempt)" }
      delay(delayMs)
    }
  }

  private suspend fun streamTradeUpdatesLoop(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradeUpdatesDedup: DedupCache<String>,
    streamUrl: String,
    topicV1: String,
    topicV2: String?,
  ) {
    var attempt = 0
    while (scope.isActive) {
      try {
        ensureKafkaReady(producer, coreMarketDataFeed)
        streamTradeUpdatesSession(producer, seq, tradeUpdatesDedup, streamUrl, topicV1, topicV2) {
          attempt = 0
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        ReadinessClassifier.classifyAlpacaHandshakeFailure(e)?.let { errorClass ->
          metrics.recordWsConnectError(errorClass)
          recordTradeUpdatesError(errorClass)
        }
        logger.warn(e) { "alpaca trade_updates session ended" }
      } finally {
        setTradeUpdatesReady(false)
      }

      if (!scope.isActive) break
      attempt += 1
      metrics.reconnects.increment()
      val delayMs = tradeUpdatesReconnectBackoff.nextDelay(attempt)
      logger.warn { "alpaca trade_updates reconnecting in ${delayMs}ms (attempt=$attempt)" }
      delay(delayMs)
    }
  }

  private suspend fun streamMarketDataSession(
    producer: KafkaProducer<String, String>,
    feed: MarketDataFeedRuntimeState,
    symbolsTracker: SymbolsTracker,
    onReady: () -> Unit,
  ) {
    val url = alpacaMarketDataStreamUrl(config, feed.config)
    httpClient.webSocket({
      url(url)
      if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
        header("Content-Type", "application/msgpack")
      }
    }) {
      var authOk = false
      var subscribedOk = false

      suspend fun decodeNextMessages(): List<AlpacaMessage> {
        while (true) {
          val frame =
            withTimeoutOrNull(config.marketDataReadIdleTimeoutMs) {
              incoming.receive()
            }
          if (frame == null) {
            val reconnect =
              marketDataIdleRequiresReconnect(
                sessionReady = authOk && subscribedOk,
                now = Instant.ofEpochMilli(nowMs()),
                marketType = config.alpacaMarketType,
                marketHolidays = config.optionsMarketHolidays,
                equityFeed = feed.config.equityFeed,
              )
            if (reconnect) {
              error("alpaca market-data websocket idle for ${config.marketDataReadIdleTimeoutMs}ms; reconnecting")
            }
            continue
          }

          val elements = decodeMarketDataFrame(frame) ?: return emptyList()
          val messages: List<JsonElement> =
            if (elements is JsonArray) elements.toList() else listOf(elements)
          return messages.mapNotNull { el ->
            try {
              json.decodeFromJsonElement(AlpacaMessageSerializer, el)
            } catch (e: SerializationException) {
              logger.warn(e) { "failed to decode alpaca message; dropping" }
              null
            }
          }
        }
      }

      val auth =
        buildJsonObject {
          put("action", "auth")
          put("key", config.alpacaKeyId)
          put("secret", config.alpacaSecretKey)
        }
      sendSerialized(auth)
      markMarketDataWsSessionStarting(feed)
      publishObservationStatus(producer, feed, "connecting")

      val subscribedSymbols = mutableSetOf<String>()
      val subscribedLock = Mutex()
      var readyNotified = false
      val subscribedSince = AtomicReference<Instant?>(null)
      val lastOptionsMarketDataEventAt = AtomicReference<Instant?>(null)
      val starvationStatusPublished = AtomicBoolean(false)

      fun updateWsReady() {
        val eventStarved =
          optionsEventStarved(
            now = Instant.ofEpochMilli(nowMs()),
            lastEventAt = lastOptionsMarketDataEventAt.get(),
            subscribedSince = subscribedSince.get(),
            subscribedCount = if (subscribedOk) 1 else 0,
            marketType = config.alpacaMarketType,
            marketHolidays = config.optionsMarketHolidays,
          )
        if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
          metrics.setOptionsEventStarvation(eventStarved)
          if (eventStarved) {
            recordFeedError(feed, ReadinessErrorClass.OptionsEventStarvation)
          }
        }
        val nowReady = authOk && subscribedOk && !eventStarved
        setFeedWsReady(feed, nowReady)
        if (nowReady && !readyNotified) {
          onReady()
          readyNotified = true
        }
      }

      suspend fun awaitAuthOrThrow() {
        // Alpaca rejects subscribe requests before a successful auth handshake; if we get an error,
        // restart the session so the outer loop can apply backoff.
        val authed =
          withTimeoutOrNull(10_000) {
            while (isActive && !authOk) {
              decodeNextMessages().forEach { msg ->
                when (msg) {
                  is AlpacaSuccess -> {
                    if (msg.msg.contains("auth", ignoreCase = true)) {
                      authOk = true
                      recordMarketDataAuthSuccess(feed)
                      publishObservationStatus(producer, feed, "authenticated")
                      updateWsReady()
                    }
                  }
                  is AlpacaError -> {
                    authOk = false
                    subscribedOk = false
                    val errorClass = ReadinessClassifier.classifyAlpacaError(msg.code, msg.msg)
                    recordMarketDataWsDisconnected(feed, errorClass)
                    updateWsReady()
                    metrics.recordWsConnectError(errorClass)
                    metrics.recordMarketDataWsConnectError(feed.config.feed, errorClass)
                    recordFeedError(feed, errorClass)
                    publishObservationStatus(producer, feed, "degraded", errorClass, msg.msg)
                    publishOptionsWsStatus(
                      producer = producer,
                      seq = feed.sequence,
                      subscribedCount = 0,
                      statusValue = optionsStatusForCode(msg.code),
                      errorCode = msg.code?.toString(),
                      errorDetail = msg.msg,
                      authOk = false,
                      subscriptionOk = false,
                      eventStarved = false,
                    )
                    logger.error { "alpaca auth error code=${msg.code} msg=${msg.msg} error_class=${errorClass.id}" }
                    throw RuntimeException("alpaca auth error code=${msg.code} msg=${msg.msg} error_class=${errorClass.id}")
                  }
                  else -> {}
                }
              }
            }
            authOk
          } ?: false
        if (!authed) {
          throw RuntimeException("alpaca auth timed out after 10000ms")
        }
      }

      suspend fun applySubscribe(symbols: List<String>) {
        if (symbols.isEmpty()) return
        val channels = feed.config.channels
        symbols.chunked(config.subscribeBatchSize).forEach { batch ->
          val subscribe =
            buildJsonObject {
              put("action", "subscribe")
              val symbolsJson = buildJsonArray { batch.forEach { add(JsonPrimitive(it)) } }
              channels.forEach { channel -> put(channel, symbolsJson) }
            }
          sendSerialized(subscribe)
        }
      }

      suspend fun applyUnsubscribe(symbols: List<String>) {
        if (symbols.isEmpty()) return
        val channels = feed.config.channels
        symbols.chunked(config.subscribeBatchSize).forEach { batch ->
          val unsubscribe =
            buildJsonObject {
              put("action", "unsubscribe")
              val symbolsJson = buildJsonArray { batch.forEach { add(JsonPrimitive(it)) } }
              channels.forEach { channel -> put(channel, symbolsJson) }
            }
          sendSerialized(unsubscribe)
        }
      }

      suspend fun desiredSymbols(): SymbolsRefreshResult {
        val refreshed = symbolsTracker.refresh()
        if (refreshed.hadError) {
          metrics.recordDesiredSymbolsFetchFailure(refreshed.failureReason ?: "unknown")
          logger.warn {
            "failed to poll desired symbols; keeping last-known list reason=${refreshed.failureReason ?: "unknown"}"
          }
        } else {
          metrics.recordDesiredSymbolsFetchSuccess()
        }
        return refreshed
      }

      val initial = desiredSymbols().symbols
      if (initial.isEmpty()) {
        logger.warn { "dorvud-ws received empty symbol list" }
      } else {
        logger.info { "dorvud-ws initial symbols=$initial count=${initial.size}" }
      }

      awaitAuthOrThrow()
      applySubscribe(initial)
      if (feed.config.core) {
        maybeBackfillTrades(producer, feed.sequence, initial)
        maybeBackfillBars(producer, feed.sequence, initial)
      }

      val poller =
        config.jangarSymbolsUrl?.takeIf { feed.config.core }?.let {
          launch {
            while (isActive) {
              delay(config.symbolsPollIntervalMs)
              val desired = desiredSymbols().symbols
              val updates = subscribedLock.withLock { subscriptionUpdates(desired, subscribedSymbols) }

              updates.forEach { update ->
                when (update.action) {
                  SubscriptionAction.Unsubscribe -> {
                    logger.info { "unsubscribing ${update.symbols.size} symbols symbols=${update.symbols}" }
                    applyUnsubscribe(update.symbols)
                  }
                  SubscriptionAction.Subscribe -> {
                    logger.info { "subscribing ${update.symbols.size} symbols symbols=${update.symbols}" }
                    applySubscribe(update.symbols)
                  }
                }
              }
              if (config.alpacaMarketType == AlpacaMarketType.OPTIONS && updates.isNotEmpty()) {
                publishOptionsWsStatus(
                  producer = producer,
                  seq = feed.sequence,
                  subscribedCount = desired.size,
                  statusValue = "ok",
                  authOk = authOk,
                  subscriptionOk = subscribedOk,
                  eventStarved = false,
                  lastEventTs = lastOptionsMarketDataEventAt.get(),
                )
              }
              if (feed.config.core) {
                maybeBackfillTrades(producer, feed.sequence, desired)
                maybeBackfillBars(producer, feed.sequence, desired)
              }
            }
          }
        }
      val starvationMonitor =
        if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
          launch {
            while (isActive) {
              delay(15_000)
              val subscribedCount =
                subscribedLock.withLock {
                  subscribedSymbols.size
                }
              val eventStarved =
                optionsEventStarved(
                  now = Instant.ofEpochMilli(nowMs()),
                  lastEventAt = lastOptionsMarketDataEventAt.get(),
                  subscribedSince = subscribedSince.get(),
                  subscribedCount = subscribedCount,
                  marketType = config.alpacaMarketType,
                  marketHolidays = config.optionsMarketHolidays,
                )
              metrics.setOptionsEventStarvation(eventStarved)
              if (eventStarved) {
                recordFeedError(feed, ReadinessErrorClass.OptionsEventStarvation)
                setFeedWsReady(feed, false)
                if (starvationStatusPublished.compareAndSet(false, true)) {
                  publishOptionsWsStatus(
                    producer = producer,
                    seq = feed.sequence,
                    subscribedCount = subscribedCount,
                    statusValue = "degraded",
                    errorCode = ReadinessErrorClass.OptionsEventStarvation.id,
                    errorDetail = "options websocket is subscribed during regular market hours but has not received quote or trade events",
                    authOk = authOk,
                    subscriptionOk = subscribedCount > 0,
                    eventStarved = true,
                    lastEventTs = lastOptionsMarketDataEventAt.get(),
                  )
                }
              }
            }
          }
        } else {
          null
        }

      try {
        while (isActive) {
          decodeNextMessages().forEach { msg ->
            when (msg) {
              is AlpacaSuccess -> {
                if (msg.msg.contains("auth", ignoreCase = true)) {
                  authOk = true
                  recordMarketDataAuthSuccess(feed)
                  updateWsReady()
                }
                return@forEach
              }
              is AlpacaSubscription -> {
                val channels = feed.config.channels
                val actualSubscribedByChannel = msg.subscribedSymbolsByChannel(channels)
                val actualSubscribed = actualSubscribedByChannel.values.flatten().toSet()
                val missingByChannel = missingDesiredSymbolsByChannel(symbolsTracker.current(), actualSubscribedByChannel, channels)
                val missing = missingByChannel.values.flatten().distinct()
                val wsStatus =
                  msg.toMarketDataWebsocketStatus(
                    previous = feed.websocketStatus.get(),
                    channels = channels,
                    desiredSymbols = symbolsTracker.current(),
                    authOk = authOk,
                    nowMs = nowMs(),
                  )
                feed.websocketStatus.set(wsStatus)
                subscribedLock.withLock {
                  subscribedSymbols.clear()
                  subscribedSymbols.addAll(actualSubscribed)
                }
                if (actualSubscribed.isNotEmpty()) {
                  subscribedSince.compareAndSet(null, Instant.ofEpochMilli(nowMs()))
                  feed.channelFreshness.recordSubscriptionByChannel(actualSubscribedByChannel)
                } else {
                  subscribedSince.set(null)
                  lastOptionsMarketDataEventAt.set(null)
                  feed.channelFreshness.clearSubscription()
                }
                subscribedOk = wsStatus.subscriptionOk
                updateWsReady()
                publishObservationStatus(
                  producer,
                  feed,
                  if (subscribedOk) "ready" else "degraded",
                  if (subscribedOk) null else ReadinessErrorClass.Unknown,
                  if (subscribedOk) null else "subscription acknowledgement is incomplete",
                )
                if (missingByChannel.isNotEmpty()) {
                  logger.warn {
                    val missingSummary = missingByChannel.mapValues { (_, symbols) -> symbols.size }
                    val subscribedSummary = actualSubscribedByChannel.mapValues { (_, symbols) -> symbols.size }
                    "alpaca subscription missing desired symbols channels=$missingSummary symbols=$missing " +
                      "subscribed_channels=$subscribedSummary subscribed_count=${actualSubscribed.size}"
                  }
                  applySubscribe(missing)
                }
                publishOptionsWsStatus(
                  producer = producer,
                  seq = feed.sequence,
                  subscribedCount =
                    subscribedLock.withLock {
                      subscribedSymbols.size
                    },
                  statusValue = "ok",
                  authOk = authOk,
                  subscriptionOk = subscribedOk,
                  eventStarved = false,
                  lastEventTs = lastOptionsMarketDataEventAt.get(),
                )
                return@forEach
              }
              is AlpacaError -> {
                authOk = false
                subscribedOk = false
                val errorClass = ReadinessClassifier.classifyAlpacaError(msg.code, msg.msg)
                recordMarketDataWsDisconnected(feed, errorClass)
                updateWsReady()
                metrics.recordWsConnectError(errorClass)
                metrics.recordMarketDataWsConnectError(feed.config.feed, errorClass)
                recordFeedError(feed, errorClass)
                publishObservationStatus(producer, feed, "degraded", errorClass, msg.msg)
                publishOptionsWsStatus(
                  producer = producer,
                  seq = feed.sequence,
                  subscribedCount =
                    subscribedLock.withLock {
                      subscribedSymbols.size
                    },
                  statusValue = optionsStatusForCode(msg.code),
                  errorCode = msg.code?.toString(),
                  errorDetail = msg.msg,
                  authOk = false,
                  subscriptionOk = false,
                  eventStarved = false,
                  lastEventTs = lastOptionsMarketDataEventAt.get(),
                )
                logger.error { "alpaca error code=${msg.code} msg=${msg.msg} error_class=${errorClass.id}" }
                throw RuntimeException("alpaca error code=${msg.code} msg=${msg.msg}")
              }
              else -> {
                val observed = observedMarketDataMessage(msg)
                if (observed != null) {
                  metrics.recordProviderMessage(config.alpacaMarketType, feed.config.feed, observed.channel)
                  feed.channelFreshness.recordProviderEvent(observed.channel, observed.symbol)
                  if (config.alpacaMarketType == AlpacaMarketType.OPTIONS && observed.isQuoteOrTrade) {
                    lastOptionsMarketDataEventAt.set(Instant.ofEpochMilli(nowMs()))
                    starvationStatusPublished.set(false)
                    metrics.setOptionsEventStarvation(false)
                    updateWsReady()
                  }
                }
                val channel = handleMessage(msg, producer, feed)
                if (config.alpacaMarketType == AlpacaMarketType.OPTIONS && channel in setOf("trade", "trades", "quote", "quotes")) {
                  lastOptionsMarketDataEventAt.set(Instant.ofEpochMilli(nowMs()))
                  starvationStatusPublished.set(false)
                  metrics.setOptionsEventStarvation(false)
                  updateWsReady()
                }
              }
            }
          }
        }
      } finally {
        poller?.cancel()
        starvationMonitor?.cancel()
        recordMarketDataWsDisconnected(feed)
        publishObservationStatus(producer, feed, "disconnected", feed.errorClass.get(), "market-data session closed")
        if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
          publishOptionsWsStatus(
            producer = producer,
            seq = feed.sequence,
            subscribedCount = 0,
            statusValue = "degraded",
            errorCode = "session_closed",
            errorDetail = "alpaca market-data websocket session closed",
            authOk = authOk,
            subscriptionOk = subscribedOk,
            eventStarved = false,
            lastEventTs = lastOptionsMarketDataEventAt.get(),
          )
        }
      }
    }
  }

  private suspend fun streamTradeUpdatesSession(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    tradeUpdatesDedup: DedupCache<String>,
    streamUrl: String,
    topicV1: String,
    topicV2: String?,
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

      while (isActive) {
        val frame = incoming.receive()
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
              val errorClass = ReadinessErrorClass.AlpacaAuth
              metrics.recordWsConnectError(errorClass)
              recordTradeUpdatesError(errorClass)
              logger.error { "alpaca trade_updates auth failed status=$status error_class=${errorClass.id}" }
              updateReady()
            }
          }
          "listening" -> {
            subscribedOk = true
            updateReady()
          }
          "trade_updates" -> {
            val data = obj["data"] as? JsonObject ?: continue
            handleTradeUpdate(data, producer, seq, tradeUpdatesDedup, topicV1, topicV2)
          }
        }
      }
    }
  }

  private suspend fun fetchDesiredSymbols(url: String): List<String> {
    val payload: String = httpClient.get(url).body()
    val element = json.parseToJsonElement(payload)
    return when (element) {
      is JsonObject ->
        extractSymbols(element["symbols"])
          .ifEmpty { extractSymbols(element["contracts"]) }
          .ifEmpty { extractSymbols(element["hot_symbols"]) }
      is JsonArray -> extractSymbols(element)
      else -> emptyList()
    }
  }

  private fun normalizeSymbols(symbols: List<String>): List<String> =
    symbols
      .map { it.trim().uppercase() }
      .filter { it.isNotEmpty() }
      .filter { config.symbolAllowlist.isEmpty() || it in config.symbolAllowlist }
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
    topicV1: String,
    topicV2: String?,
  ) {
    val order = data["order"] as? JsonObject
    val symbol = order?.get("symbol")?.jsonPrimitive?.contentOrNull ?: "UNKNOWN"
    val eventTs =
      data["timestamp"]?.jsonPrimitive?.contentOrNull
        ?: data["t"]?.jsonPrimitive?.contentOrNull
        ?: order?.get("submitted_at")?.jsonPrimitive?.contentOrNull
        ?: Instant.now().toString()

    val orderId =
      order?.get("id")?.jsonPrimitive?.contentOrNull
        ?: order?.get("client_order_id")?.jsonPrimitive?.contentOrNull
    val eventType =
      data["event"]?.jsonPrimitive?.contentOrNull
        ?: data["event_type"]?.jsonPrimitive?.contentOrNull
    val status = order?.get("status")?.jsonPrimitive?.contentOrNull
    val eventKeyTs =
      data["timestamp"]?.jsonPrimitive?.contentOrNull
        ?: data["t"]?.jsonPrimitive?.contentOrNull
        ?: order?.get("updated_at")?.jsonPrimitive?.contentOrNull
        ?: order?.get("submitted_at")?.jsonPrimitive?.contentOrNull

    val dedupKey =
      if (orderId != null) {
        listOfNotNull(orderId, eventType, status, eventKeyTs).joinToString(":")
      } else if (eventKeyTs != null) {
        "$symbol:$eventKeyTs"
      } else {
        null
      }

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
    sendKafka(producer, topicV1, env)
    if (!topicV2.isNullOrBlank()) {
      val payloadV2 =
        buildJsonObject {
          data.forEach { (key, value) -> put(key, value) }
          config.torghutAccountLabel?.let { put("account_label", JsonPrimitive(it)) }
        }
      val envV2: Envelope<JsonElement> =
        Envelope(
          ingestTs = env.ingestTs,
          eventTs = env.eventTs,
          feed = env.feed,
          channel = env.channel,
          symbol = env.symbol,
          seq = env.seq,
          payload = payloadV2,
          accountLabel = config.torghutAccountLabel,
          isFinal = true,
          source = env.source,
          version = 2,
        )
      sendKafka(producer, topicV2, envV2)
    }
  }

  private suspend fun maybeBackfillBars(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    symbols: List<String>,
  ) {
    if (!config.enableBarsBackfill) return
    val barsTopic = config.topics.bars1m ?: return
    if (symbols.isEmpty()) return
    if (!coreMarketDataFeed.backfillDone.compareAndSet(false, true)) return

    try {
      val requestNow = Instant.ofEpochMilli(nowMs())
      val window = alpacaBarsBackfillWindow(requestNow, config.barsBackfillLookbackHours)
      val bars = fetchBackfillBars(symbols)
      if (bars.isEmpty()) {
        logger.warn {
          "backfill returned 0 bars lookback_hours=${config.barsBackfillLookbackHours} " +
            "feed=${alpacaBarsBackfillFeed(config) ?: "none"} start=${window.start} end=${window.end}"
        }
        return
      }

      logger.info {
        "backfill sending ${bars.size} bars lookback_hours=${config.barsBackfillLookbackHours} " +
          "feed=${alpacaBarsBackfillFeed(config) ?: "none"} start=${window.start} end=${window.end}"
      }
      bars.forEach { bar ->
        val eventTime = Instant.parse(bar.timestamp)
        val env =
          Envelope(
            ingestTs = Instant.now(),
            eventTs = eventTime,
            feed = config.alpacaFeed,
            channel = "bars",
            symbol = bar.symbol,
            seq = seq.next("bars:${bar.symbol}"),
            payload = json.encodeToJsonElement(AlpacaBar.serializer(), bar),
            provider = "alpaca",
            marketSession = classifyMarketSession(eventTime).id,
            delayClass = coreMarketDataFeed.config.equityFeed?.let { marketDataDelayClass(it, "bars").id },
            isFinal = true,
            source = "rest",
            version = 2,
          )
        recordLag(env, coreMarketDataFeed)
        sendKafka(producer, barsTopic, env, "bars", coreMarketDataFeed)
      }
    } catch (e: Exception) {
      coreMarketDataFeed.backfillDone.set(false)
      logger.warn(e) { "backfill failed; will retry when symbols refresh" }
    }
  }

  private suspend fun maybeBackfillTrades(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    symbols: List<String>,
  ) {
    if (!config.enableTradesBackfill) return
    if (symbols.isEmpty()) return
    if (!coreMarketDataFeed.tradesBackfillDone.compareAndSet(false, true)) return

    try {
      val requestNow = Instant.ofEpochMilli(nowMs())
      val trades = fetchBackfillTrades(symbols)
      if (trades.isEmpty()) {
        logger.warn {
          "trades backfill returned 0 records lookback_hours=${config.tradesBackfillLookbackHours} " +
            "feed=${config.alpacaFeed} end=$requestNow"
        }
        return
      }

      logger.info {
        "trades backfill sending ${trades.size} records lookback_hours=${config.tradesBackfillLookbackHours} " +
          "feed=${config.alpacaFeed} end=$requestNow"
      }
      trades
        .sortedBy { it.timestamp }
        .forEach { trade ->
          val eventTime = Instant.parse(trade.timestamp)
          val env =
            Envelope(
              ingestTs = Instant.now(),
              eventTs = eventTime,
              feed = config.alpacaFeed,
              channel = "trades",
              symbol = trade.symbol,
              seq = seq.next("trades:${trade.symbol}"),
              payload = json.encodeToJsonElement(AlpacaTrade.serializer(), trade),
              provider = "alpaca",
              marketSession = classifyMarketSession(eventTime).id,
              delayClass = coreMarketDataFeed.config.equityFeed?.let { marketDataDelayClass(it, "trades").id },
              isFinal = true,
              source = "rest",
              version = 2,
            )
          recordLag(env, coreMarketDataFeed)
          sendKafka(producer, config.topics.trades, env, "trades", coreMarketDataFeed)
        }
    } catch (e: Exception) {
      coreMarketDataFeed.tradesBackfillDone.set(false)
      logger.warn(e) { "trades backfill failed; will retry when symbols refresh" }
    }
  }

  private suspend fun fetchBackfillTrades(symbols: List<String>): List<AlpacaTrade> {
    if (symbols.isEmpty()) return emptyList()
    val trades = mutableListOf<AlpacaTrade>()
    for (chunk in symbols.chunked(config.subscribeBatchSize)) {
      if (trades.size >= config.tradesBackfillMaxRecords) break
      val remaining = config.tradesBackfillMaxRecords - trades.size
      trades += fetchBackfillTradesChunk(chunk, remaining)
    }
    return trades
  }

  private suspend fun fetchBackfillTradesChunk(
    symbols: List<String>,
    maxRecords: Int,
  ): List<AlpacaTrade> {
    if (symbols.isEmpty() || maxRecords <= 0) return emptyList()
    val url = alpacaTradesBackfillUrl(config)
    val requestNow = Instant.ofEpochMilli(nowMs())
    val trades = mutableListOf<AlpacaTrade>()
    var pageToken: String? = null

    do {
      val query = alpacaTradesBackfillQuery(config, symbols, requestNow, pageToken)
      val response =
        decodeAlpacaTradesResponse(
          httpClient
            .get(url) {
              parameter("symbols", query.symbols)
              parameter("start", query.start)
              parameter("end", query.end)
              parameter("limit", query.limit)
              parameter("sort", query.sort)
              query.feed?.let { parameter("feed", it) }
              query.pageToken?.let { parameter("page_token", it) }
              header("APCA-API-KEY-ID", config.alpacaKeyId)
              header("APCA-API-SECRET-KEY", config.alpacaSecretKey)
            }.body(),
          json,
        )

      val pageTrades =
        when (val tradesElement = response.trades) {
          null -> emptyList()
          is JsonArray -> decodeTradesArray(tradesElement, response.symbol)
          is JsonObject ->
            tradesElement.entries.flatMap { (symbol, entry) ->
              val arr = entry as? JsonArray ?: return@flatMap emptyList()
              decodeTradesArray(arr, symbol)
            }
          else -> emptyList()
        }
      val remaining = maxRecords - trades.size
      trades += pageTrades.take(remaining)
      pageToken = response.nextPageToken
    } while (pageToken != null && trades.size < maxRecords)

    return trades
  }

  private suspend fun fetchBackfillBars(symbols: List<String>): List<AlpacaBar> {
    if (symbols.isEmpty()) return emptyList()
    return symbols.chunked(config.subscribeBatchSize).flatMap { chunk ->
      fetchBackfillBarsChunk(chunk)
    }
  }

  private suspend fun fetchBackfillBarsChunk(symbols: List<String>): List<AlpacaBar> {
    if (symbols.isEmpty()) return emptyList()
    val url = alpacaBarsBackfillUrl(config)
    val requestNow = Instant.ofEpochMilli(nowMs())
    val bars = mutableListOf<AlpacaBar>()
    var pageToken: String? = null

    do {
      val query = alpacaBarsBackfillQuery(config, symbols, requestNow, pageToken)
      val response =
        decodeAlpacaBarsResponse(
          httpClient
            .get(url) {
              parameter("symbols", query.symbols)
              parameter("timeframe", query.timeframe)
              parameter("start", query.start)
              parameter("end", query.end)
              parameter("limit", query.limit)
              parameter("sort", query.sort)
              query.feed?.let { parameter("feed", it) }
              query.pageToken?.let { parameter("page_token", it) }
              header("APCA-API-KEY-ID", config.alpacaKeyId)
              header("APCA-API-SECRET-KEY", config.alpacaSecretKey)
            }.body(),
          json,
        )

      val pageBars =
        when (val barsElement = response.bars) {
          null -> emptyList()
          is JsonArray -> decodeBarsArray(barsElement, response.symbol)
          is JsonObject ->
            barsElement.entries.flatMap { (symbol, entry) ->
              val arr = entry as? JsonArray ?: return@flatMap emptyList()
              decodeBarsArray(arr, symbol)
            }
          else -> emptyList()
        }
      bars += pageBars
      pageToken = response.nextPageToken
    } while (pageToken != null)

    return bars
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

  private fun decodeTradesArray(
    trades: JsonArray,
    symbolFallback: String?,
  ): List<AlpacaTrade> {
    return trades.mapNotNull { tradeEl ->
      val obj = tradeEl as? JsonObject ?: return@mapNotNull null
      val symbol = obj["S"]?.jsonPrimitive?.contentOrNull ?: symbolFallback
      if (symbol.isNullOrBlank()) return@mapNotNull null

      val withSymbol =
        if (obj.containsKey("S")) {
          obj
        } else {
          JsonObject(obj + ("S" to JsonPrimitive(symbol)))
        }

      runCatching { json.decodeFromJsonElement(AlpacaTrade.serializer(), withSymbol) }.getOrNull()
    }
  }

  private fun ensureKafkaReady(
    producer: KafkaProducer<String, String>,
    feed: MarketDataFeedRuntimeState,
  ) {
    val topics =
      buildList {
        add(feed.config.topics.trades)
        add(feed.config.topics.quotes)
        feed.config.topics.bars1m
          ?.let { add(it) }
        add(feed.config.topics.status)
        if (feed.config.core && tradeUpdatesEnabled) {
          config.topics.tradeUpdates?.let { add(it) }
        }
      }.distinct()

    val result =
      runCatching {
        topics.forEach { producer.partitionsFor(it) }
      }
    val readyNow = result.isSuccess
    if (!readyNow) {
      val errorClass =
        ReadinessClassifier.classifyKafkaFailure(
          result.exceptionOrNull() ?: Exception("kafka_metadata_unknown"),
          KafkaFailureContext.Metadata,
        )
      metrics.recordKafkaMetadataError(errorClass)
      feed.errorClass.set(errorClass)
      if (feed.config.core) recordKafkaError(errorClass)
    }

    if (readyNow) {
      feed.kafkaFailureCount.set(0)
    }
    setFeedKafkaReady(feed, readyNow)
  }

  private fun handleMessage(
    msg: AlpacaMessage,
    producer: KafkaProducer<String, String>,
    feed: MarketDataFeedRuntimeState,
  ): String? {
    when (msg) {
      is AlpacaError -> {
        logger.error { "alpaca error code=${msg.code} msg=${msg.msg}" }
        return null
      }
      is AlpacaUnknownMessage -> {
        logger.warn { "alpaca unknown message type=${msg.type}; dropping" }
        return null
      }
      is AlpacaTrade -> {
        val dedupKey =
          if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
            "${feed.config.feed}:trades:${msg.symbol}:${msg.timestamp}:${msg.price}:${msg.size}:${msg.exchange}:" +
              msg.conditions.orEmpty().joinToString("|")
          } else {
            msg.id?.let { "${feed.config.feed}:trades:id:$it" }
              ?: "${feed.config.feed}:trades:${msg.symbol}:${msg.timestamp}:${msg.price}:${msg.size}:${msg.exchange}:" +
              msg.conditions.orEmpty().joinToString("|")
          }
        if (feed.tradesDedup.isDuplicate(dedupKey)) {
          metrics.recordMarketDataDedup(feed.config.feed, "trades")
          return null
        }
      }
      is AlpacaQuote -> {
        val dedupKey =
          if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
            "${feed.config.feed}:quotes:${msg.symbol}:${msg.timestamp}:${msg.bidPrice}:${msg.bidSize}:" +
              "${msg.askPrice}:${msg.askSize}"
          } else {
            "${feed.config.feed}:quotes:${msg.timestamp}-${msg.symbol}"
          }
        if (feed.quotesDedup.isDuplicate(dedupKey)) {
          metrics.recordMarketDataDedup(feed.config.feed, "quotes")
          return null
        }
      }
      is AlpacaBar, is AlpacaUpdatedBar -> {
        val dedupKey = requireNotNull(barDedupKey(msg, feed.config.feed))
        if (feed.barsDedup.isDuplicate(dedupKey)) {
          metrics.recordMarketDataDedup(feed.config.feed, "bars")
          return null
        }
      }
      else -> {}
    }

    val env =
      AlpacaMapper.toEnvelope(
        msg,
        config.alpacaMarketType,
        feed.config.feed,
        feed.config.equityFeed,
      ) { key -> feed.sequence.next(key) }
        ?: run {
          recordMarketDataEnvelopeDrop(feed, msg)
          return null
        }
    recordLag(env, feed)

    val topic = feed.config.topicFor(env.channel, config.alpacaMarketType) ?: return null

    val serializedSequence = feed.channelFreshness.recordSerializedEvent(env.channel, env.symbol)
    sendKafka(producer, topic, env, env.channel, feed, serializedSequence)
    return env.channel
  }

  private fun sendKafka(
    producer: KafkaProducer<String, String>,
    topic: String,
    env: Envelope<JsonElement>,
    marketDataChannel: String? = null,
    feed: MarketDataFeedRuntimeState? = null,
    serializedSequence: Long? = null,
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
          recordKafkaFailure(exception, topic, feed)
        } else {
          metrics.recordKafkaProduceSuccess(topic)
          feed?.channelFreshness?.recordKafkaSuccess(
            marketDataFreshnessChannelFor(env, marketDataChannel),
            env.symbol,
            serializedSequence,
          )
          recordKafkaSuccess(feed)
        }
      }
    } catch (e: Exception) {
      val elapsed = Duration.ofNanos(System.nanoTime() - start)
      metrics.recordKafkaLatency(elapsed)
      metrics.kafkaSendErrors.increment()
      recordKafkaFailure(e, topic, feed)
    }
  }

  private fun recordLag(
    env: Envelope<*>,
    feed: MarketDataFeedRuntimeState? = null,
  ) {
    val lagMs = Duration.between(env.eventTs, env.ingestTs).toMillis()
    metrics.recordLagMs(lagMs)
    feed?.let { metrics.recordMarketDataLagMs(it.config.feed, env.channel, lagMs) }
  }

  private fun recordMarketDataEnvelopeDrop(
    feed: MarketDataFeedRuntimeState,
    msg: AlpacaMessage,
  ) {
    val observed = observedMarketDataMessage(msg) ?: return
    val reason = marketDataEnvelopeDropReason(msg)
    metrics.recordMarketDataDrop(config.alpacaMarketType, feed.config.feed, observed.channel, reason)
    if (feed.envelopeDropLogged.compareAndSet(false, true)) {
      logger.warn {
        "alpaca market-data frame dropped before envelope " +
          "market_type=${config.alpacaMarketType.name.lowercase()} feed=${feed.config.feed} channel=${observed.channel} " +
          "reason=$reason timestamp_shape=${timestampShape(alpacaEventTimestamp(msg))}"
      }
    }
  }

  private fun recordKafkaFailure(
    exception: Exception,
    topic: String,
    feed: MarketDataFeedRuntimeState? = null,
  ) {
    val target = feed ?: coreMarketDataFeed
    val errorClass = ReadinessClassifier.classifyKafkaFailure(exception, KafkaFailureContext.Produce)
    metrics.recordKafkaProduceError(topic, errorClass)
    target.errorClass.set(errorClass)
    if (target.config.core) recordKafkaError(errorClass)
    val failures = target.kafkaFailureCount.incrementAndGet()
    if (failures == 1) {
      logger.warn(exception) { "kafka send failure detected; count=$failures error_class=${errorClass.id}" }
    }
    if (failures >= 3) {
      if (failures == 3) {
        logger.warn(exception) { "kafka send failures reached $failures; marking not-ready error_class=${errorClass.id}" }
      }
      setFeedKafkaReady(target, false)
    }
  }

  private fun recordKafkaSuccess(feed: MarketDataFeedRuntimeState? = null) {
    val target = feed ?: coreMarketDataFeed
    target.kafkaFailureCount.set(0)
    target.errorClass.compareAndSet(ReadinessErrorClass.KafkaMetadata, null)
    target.errorClass.compareAndSet(ReadinessErrorClass.KafkaProduce, null)
    target.errorClass.compareAndSet(ReadinessErrorClass.KafkaAuth, null)
    if (!target.kafkaReady.get()) {
      setFeedKafkaReady(target, true)
      return
    }
    if (target.config.core) refreshReadinessFromMarketDataChannels()
  }

  private fun setFeedKafkaReady(
    feed: MarketDataFeedRuntimeState,
    value: Boolean,
  ) {
    feed.kafkaReady.set(value)
    if (feed.config.core) setKafkaReady(value)
  }

  private fun setKafkaReady(value: Boolean) {
    if (value) {
      kafkaErrorClass.set(null)
    }
    kafkaReady.set(value)
    coreMarketDataFeed.kafkaReady.set(value)
    markReady(value && wsReady.get() && tradeUpdatesGate() && marketDataChannelsGate())
  }

  private fun setFeedWsReady(
    feed: MarketDataFeedRuntimeState,
    value: Boolean,
  ) {
    val previous = feed.websocketReady.getAndSet(value)
    if (value) feed.errorClass.set(null)
    if (value && !previous) metrics.recordMarketDataWsConnectSuccess(feed.config.feed)
    if (!feed.config.core) {
      return
    }
    setWsReady(value)
  }

  private fun setWsReady(value: Boolean) {
    val previous = wsReady.getAndSet(value)
    if (value) {
      alpacaErrorClass.set(null)
    }
    if (value && !previous) {
      metrics.wsConnectSuccess.increment()
    }
    markReady(value && kafkaReady.get() && tradeUpdatesGate() && marketDataChannelsGate())
  }

  private fun markMarketDataWsSessionStarting(feed: MarketDataFeedRuntimeState) {
    feed.channelFreshness.clearSubscription()
    feed.websocketStatus.updateAndGet {
      it.copy(
        authOk = false,
        subscriptionOk = false,
        latestSubscriptionAckAtMs = null,
        subscribedSymbolCount = 0,
        subscribedSymbols = emptyList(),
        subscribedSymbolsByChannel = emptyMap(),
        missingSubscriptionSymbolsByChannel = emptyMap(),
        errorClass = null,
      )
    }
  }

  private fun recordMarketDataAuthSuccess(feed: MarketDataFeedRuntimeState) {
    feed.websocketStatus.updateAndGet {
      it.copy(authOk = true, latestAuthSuccessAtMs = nowMs(), errorClass = null)
    }
  }

  private fun recordMarketDataWsDisconnected(
    feed: MarketDataFeedRuntimeState,
    errorClass: ReadinessErrorClass? = null,
  ) {
    feed.channelFreshness.clearSubscription()
    feed.websocketStatus.updateAndGet {
      it.copy(
        authOk = false,
        subscriptionOk = false,
        latestSubscriptionAckAtMs = null,
        subscribedSymbolCount = 0,
        subscribedSymbols = emptyList(),
        subscribedSymbolsByChannel = emptyMap(),
        missingSubscriptionSymbolsByChannel = emptyMap(),
        errorClass = errorClass?.id ?: it.errorClass,
      )
    }
  }

  private fun setTradeUpdatesReady(value: Boolean) {
    if (value) {
      tradeUpdatesErrorClass.set(null)
    }
    tradeUpdatesReady.set(value)
    markReady(wsReady.get() && kafkaReady.get() && tradeUpdatesGate() && marketDataChannelsGate())
  }

  private fun tradeUpdatesGate(): Boolean = if (tradeUpdatesEnabled) tradeUpdatesReady.get() else true

  private fun marketDataChannelsGate(): Boolean = marketDataChannelSnapshot().all { it.ready }

  private fun marketDataChannelSnapshot(): List<MarketDataChannelReadiness> {
    val snapshot = coreMarketDataFeed.channelFreshness.snapshot()
    metrics.setMarketDataChannelReadiness(coreMarketDataFeed.config.feed, snapshot)
    return snapshot
  }

  private fun refreshReadinessFromMarketDataChannels() {
    val marketDataReady = marketDataChannelsGate()
    if (!marketDataReady) {
      readinessErrorClass.set(ReadinessErrorClass.MarketDataChannelStarvation)
    } else if (readinessErrorClass.get() == ReadinessErrorClass.MarketDataChannelStarvation) {
      readinessErrorClass.set(null)
    }
    markReady(wsReady.get() && kafkaReady.get() && tradeUpdatesGate() && marketDataReady)
  }

  private fun markReady(value: Boolean) {
    val previous = ready.getAndSet(value)
    metrics.setReady(value)
    val gates = currentReadinessGates()
    metrics.setReadinessGates(gates)
    if (value) {
      notReadyLivenessGate.recordReadiness(ready = true)
      notReadyLivenessLogged.set(false)
      readinessErrorClass.set(null)
      reportedNotReadyClass.set(null)
      metrics.setReadinessErrorClass(null)
      return
    }

    val errorClass = currentReadinessErrorClass(value, gates) ?: ReadinessErrorClass.Unknown
    notReadyLivenessGate.recordReadiness(
      ready = false,
      livenessFailureEligible = errorClass.shouldEscalateToLivenessFailure(),
    )
    metrics.setReadinessErrorClass(errorClass)
    if (previous) {
      logger.warn {
        "readiness changed to not_ready error_class=${errorClass.id} " +
          "gates=alpaca_ws:${gates.alpacaWs} kafka:${gates.kafka} " +
          "trade_updates:${gates.tradeUpdates} market_data_channels:${gates.marketDataChannels}"
      }
      reportedNotReadyClass.set(errorClass)
      metrics.recordReadinessError(errorClass)
    } else {
      val lastReported = reportedNotReadyClass.getAndSet(errorClass)
      if (lastReported != errorClass) {
        metrics.recordReadinessError(errorClass)
      }
    }
  }

  private fun recordReadinessError(errorClass: ReadinessErrorClass) {
    readinessErrorClass.set(errorClass)
    if (!ready.get()) {
      val currentError = currentReadinessErrorClass(ready.get(), currentReadinessGates()) ?: errorClass
      metrics.setReadinessErrorClass(currentError)
      val lastReported = reportedNotReadyClass.getAndSet(currentError)
      if (lastReported != currentError) {
        metrics.recordReadinessError(currentError)
      }
    }
  }

  private fun recordFeedError(
    feed: MarketDataFeedRuntimeState,
    errorClass: ReadinessErrorClass,
  ) {
    feed.errorClass.set(errorClass)
    if (feed.config.core) {
      alpacaErrorClass.set(errorClass)
      recordReadinessError(errorClass)
    }
  }

  private fun recordTradeUpdatesError(errorClass: ReadinessErrorClass) {
    tradeUpdatesErrorClass.set(errorClass)
    recordReadinessError(errorClass)
  }

  private fun recordKafkaError(errorClass: ReadinessErrorClass) {
    kafkaErrorClass.set(errorClass)
    recordReadinessError(errorClass)
  }

  private fun currentReadinessGates(): ReadinessGates =
    ReadinessGates(
      alpacaWs = wsReady.get(),
      kafka = kafkaReady.get(),
      tradeUpdates = tradeUpdatesGate(),
      marketDataChannels = marketDataChannelsGate(),
    )

  private fun currentReadinessErrorClass(
    readyNow: Boolean,
    gates: ReadinessGates,
  ): ReadinessErrorClass? =
    ReadinessClassifier.readinessErrorClassForGates(
      ready = readyNow,
      gates = gates,
      alpacaErrorClass = alpacaErrorClass.get(),
      kafkaErrorClass = kafkaErrorClass.get(),
      tradeUpdatesErrorClass = tradeUpdatesErrorClass.get(),
      fallbackErrorClass = readinessErrorClass.get(),
      marketDataChannelErrorClass = readinessErrorClass.get(),
    )

  private suspend fun DefaultClientWebSocketSession.sendSerialized(payload: JsonObject) {
    val text = json.encodeToString(payload)
    if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
      val jsonTree = jsonObjectMapper.readTree(text)
      send(Frame.Binary(true, msgPackMapper.writeValueAsBytes(jsonTree)))
    } else {
      send(Frame.Text(text))
    }
  }

  private fun decodeMarketDataFrame(frame: Frame): JsonElement? {
    try {
      when (frame) {
        is Frame.Text -> return parseMarketDataJson(frame.readText())
        is Frame.Binary -> {
          val bytes = frame.readBytes()
          if (config.alpacaMarketType == AlpacaMarketType.OPTIONS) {
            return jsonElementFromJacksonNode(msgPackMapper.readTree(bytes))
          }
          return parseMarketDataJson(bytes.decodeToString())
        }
        else -> return null
      }
    } catch (e: Exception) {
      logger.warn(e) { "failed to decode alpaca frame; dropping" }
      return null
    }
  }

  private fun parseMarketDataJson(text: String): JsonElement? =
    try {
      json.parseToJsonElement(text)
    } catch (e: SerializationException) {
      logger.warn(e) { "failed to parse alpaca frame as JSON; dropping" }
      null
    }

  private fun extractSymbols(element: JsonElement?): List<String> =
    when (element) {
      is JsonArray ->
        element.mapNotNull { entry ->
          when (entry) {
            is JsonPrimitive -> entry.contentOrNull
            is JsonObject ->
              entry["contract_symbol"]?.jsonPrimitive?.contentOrNull
                ?: entry["symbol"]?.jsonPrimitive?.contentOrNull
            else -> null
          }
        }
      else -> emptyList()
    }

  private fun optionsStatusForCode(code: Int?): String =
    when (code) {
      405, 406, 410, 412, 413 -> "blocked"
      else -> "degraded"
    }

  private fun publishObservationStatus(
    producer: KafkaProducer<String, String>,
    feed: MarketDataFeedRuntimeState,
    status: String,
    errorClass: ReadinessErrorClass? = null,
    detail: String? = null,
  ) {
    if (feed.config.core) return
    val now = Instant.ofEpochMilli(nowMs())
    val websocket = feed.websocketStatus.get()
    val payload: JsonElement =
      buildJsonObject {
        put("component", "market_data_observation")
        put("provider", "alpaca")
        put("feed", feed.config.feed)
        put("status", status)
        put("auth_ok", websocket.authOk)
        put("subscription_ok", websocket.subscriptionOk)
        put("kafka_ready", feed.kafkaReady.get())
        put("error_class", errorClass?.id?.let(::JsonPrimitive) ?: JsonNull)
        put("detail", detail?.let(::JsonPrimitive) ?: JsonNull)
        put("schema_version", 1)
      }
    val envelope =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = feed.config.feed,
        channel = "status",
        symbol = feed.config.feed,
        seq = feed.sequence.next("status:${feed.config.feed}"),
        payload = payload,
        provider = "alpaca",
        marketSession = classifyMarketSession(now).id,
        isFinal = true,
        source = "ws",
        version = 2,
      )
    sendKafka(producer, feed.config.topics.status, envelope, feed = feed)
  }

  private fun publishOptionsWsStatus(
    producer: KafkaProducer<String, String>,
    seq: SeqTracker,
    subscribedCount: Int,
    statusValue: String,
    errorCode: String? = null,
    errorDetail: String? = null,
    authOk: Boolean? = null,
    subscriptionOk: Boolean? = null,
    eventStarved: Boolean? = null,
    lastEventTs: Instant? = null,
  ) {
    if (config.alpacaMarketType != AlpacaMarketType.OPTIONS) return
    val now = Instant.now()
    if (statusValue == "ok") {
      optionsWsLastSuccessTs.set(now)
    }
    val payload: JsonElement =
      buildJsonObject {
        put("component", "ws")
        put("status", statusValue)
        put("session_state", currentSessionState(now))
        put("watermark_lag_ms", JsonNull)
        put("active_contracts", subscribedCount)
        put("hot_contracts", subscribedCount)
        put("rest_backlog", JsonNull)
        put("auth_ok", authOk?.let(::JsonPrimitive) ?: JsonNull)
        put("subscription_ok", subscriptionOk?.let(::JsonPrimitive) ?: JsonNull)
        put("event_starved", eventStarved?.let(::JsonPrimitive) ?: JsonNull)
        put("last_event_ts", lastEventTs?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("error_code", errorCode?.let(::JsonPrimitive) ?: JsonNull)
        put("error_detail", errorDetail?.let(::JsonPrimitive) ?: JsonNull)
        put("last_success_ts", optionsWsLastSuccessTs.get()?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("heartbeat", true)
        put("schema_version", 1)
      }
    val env =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = config.alpacaFeed,
        channel = "status",
        symbol = "ws",
        seq = seq.next("ws"),
        payload = payload,
        isFinal = true,
        source = "ws",
      )
    sendKafka(producer, config.topics.status, env)
  }

  private fun currentSessionState(now: Instant): String {
    val marketNow = now.atZone(marketSessionZoneId)
    if (marketNow.toLocalDate() in config.optionsMarketHolidays) return "holiday"
    if (marketNow.dayOfWeek.value >= 6) return "weekend"
    val minuteOfDay = (marketNow.hour * 60) + marketNow.minute
    return when {
      minuteOfDay in (4 * 60) until (9 * 60 + 30) -> "pre"
      minuteOfDay in (9 * 60 + 30) until (16 * 60) -> "regular"
      minuteOfDay in (16 * 60) until (20 * 60) -> "post"
      else -> "closed"
    }
  }
}

internal fun optionsEventStarved(
  now: Instant,
  lastEventAt: Instant?,
  subscribedSince: Instant?,
  subscribedCount: Int,
  marketType: AlpacaMarketType,
  marketHolidays: Set<LocalDate> = emptySet(),
  grace: Duration = Duration.ofSeconds(90),
): Boolean {
  if (marketType != AlpacaMarketType.OPTIONS || subscribedCount <= 0 || !isRegularMarketSession(now, marketHolidays)) {
    return false
  }
  val lastHealthyEvent = lastEventAt ?: subscribedSince ?: return false
  return Duration.between(lastHealthyEvent, now) >= grace
}

internal data class ObservedMarketDataMessage(
  val channel: String,
  val symbol: String,
) {
  val isQuoteOrTrade: Boolean
    get() = channel == "trade" || channel == "trades" || channel == "quote" || channel == "quotes"
}

internal fun observedMarketDataMessage(message: AlpacaMessage): ObservedMarketDataMessage? =
  when (message) {
    is AlpacaTrade -> ObservedMarketDataMessage("trade", message.symbol)
    is AlpacaQuote -> ObservedMarketDataMessage("quote", message.symbol)
    is AlpacaBar -> ObservedMarketDataMessage("bars", message.symbol)
    is AlpacaUpdatedBar -> ObservedMarketDataMessage("updatedBars", message.symbol)
    else -> null
  }

internal fun jsonElementFromJacksonNode(node: JsonNode): JsonElement =
  when {
    node.isObject -> {
      buildJsonObject {
        val fields = node.fields()
        while (fields.hasNext()) {
          val entry = fields.next()
          put(entry.key, jsonElementFromJacksonNode(entry.value))
        }
      }
    }
    node.isArray -> {
      buildJsonArray {
        val elements = node.elements()
        while (elements.hasNext()) {
          add(jsonElementFromJacksonNode(elements.next()))
        }
      }
    }
    node.isTextual -> JsonPrimitive(node.textValue())
    node.isNumber -> JsonPrimitive(node.numberValue())
    node.isBoolean -> JsonPrimitive(node.booleanValue())
    node.isNull || node.isMissingNode -> JsonNull
    node is POJONode -> jsonElementFromPojo(node.pojo)
    node.isBinary -> JsonPrimitive(node.asText())
    else -> JsonPrimitive(node.asText())
  }

private fun jsonElementFromPojo(pojo: Any?): JsonElement =
  when (pojo) {
    null -> JsonNull
    is Instant -> JsonPrimitive(pojo.toString())
    is MessagePackExtensionType -> messagePackTimestampInstant(pojo)?.toString()?.let(::JsonPrimitive) ?: JsonPrimitive(pojo.toString())
    else -> JsonPrimitive(pojo.toString())
  }

private fun messagePackTimestampInstant(extension: MessagePackExtensionType): Instant? {
  if (extension.type != TimestampExtensionModule.EXT_TYPE) return null
  val data = extension.data
  return runCatching {
    when (data.size) {
      4 -> Instant.ofEpochSecond(ByteBuffer.wrap(data).int.toLong() and MESSAGE_PACK_TIMESTAMP_32_UNSIGNED_MASK)
      8 -> {
        val packed = ByteBuffer.wrap(data).long
        val nanos = packed ushr MESSAGE_PACK_TIMESTAMP_64_NANO_SHIFT
        val seconds = packed and MESSAGE_PACK_TIMESTAMP_64_SECONDS_MASK
        Instant.ofEpochSecond(seconds, nanos)
      }
      12 -> {
        val buffer = ByteBuffer.wrap(data)
        val nanos = buffer.int.toLong() and MESSAGE_PACK_TIMESTAMP_32_UNSIGNED_MASK
        val seconds = buffer.long
        Instant.ofEpochSecond(seconds, nanos)
      }
      else -> null
    }
  }.getOrNull()
}

internal fun marketDataEnvelopeDropReason(message: AlpacaMessage): String {
  val timestamp = alpacaEventTimestamp(message) ?: return "unsupported_message"
  return if (parseAlpacaEventInstant(timestamp) == null) {
    "invalid_event_ts"
  } else {
    "envelope_mapping_failed"
  }
}

internal fun alpacaEventTimestamp(message: AlpacaMessage): String? =
  when (message) {
    is AlpacaTrade -> message.timestamp
    is AlpacaQuote -> message.timestamp
    is AlpacaBar -> message.timestamp
    is AlpacaUpdatedBar -> message.timestamp
    is AlpacaStatus -> message.timestamp
    else -> null
  }

private fun timestampShape(timestamp: String?): String {
  val value = timestamp?.trim()?.takeIf { it.isNotEmpty() } ?: return "missing"
  return listOf(
    "len=${value.length}",
    "has_t=${value.contains('T')}",
    "has_space=${value.contains(' ')}",
    "has_z=${value.endsWith('Z')}",
    "has_dot=${value.contains('.')}",
    "has_offset=${Regex("[+-]\\d{2}:?\\d{2}$").containsMatchIn(value)}",
    "numeric=${value.all { it.isDigit() || it == '.' }}",
  ).joinToString(",")
}

internal fun isRegularMarketSession(
  now: Instant,
  marketHolidays: Set<LocalDate> = emptySet(),
): Boolean {
  val marketNow = now.atZone(marketSessionZoneId)
  if (marketNow.toLocalDate() in marketHolidays) return false
  if (marketNow.dayOfWeek.value >= 6) return false
  val minuteOfDay = (marketNow.hour * 60) + marketNow.minute
  return minuteOfDay in (9 * 60 + 30) until (16 * 60)
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
