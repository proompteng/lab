package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.DedupCache
import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.platform.buildProducer
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.serialization.kotlinx.json.json
import io.ktor.websocket.Frame
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
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import mu.KotlinLogging
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.system.exitProcess

private val appLogger = KotlinLogging.logger {}

class HyperliquidFeedApp(
  private val config: HyperliquidConfig,
  private val producerFactory: (HyperliquidConfig) -> KafkaProducer<String, String> = { cfg -> buildProducer(cfg.kafka) },
  private val json: Json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
      explicitNulls = false
    },
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private val scope = CoroutineScope(Dispatchers.Default)
  private val ready = AtomicBoolean(false)
  private val wsReady = AtomicBoolean(false)
  private val kafkaReadiness = KafkaReadinessTracker(config.kafkaReadyMaxAgeMs, nowMs)
  private val clickHouseReady = AtomicBoolean(!config.clickHouse.enabled)
  private val clickHouseTableFresh = AtomicBoolean(!config.clickHouse.enabled)
  private val alive = AtomicBoolean(true)
  private val clickHouseLastSuccessMs = AtomicLong(if (config.clickHouse.enabled) 0 else nowMs())
  private val clickHouseLastFailureMs = AtomicLong(0)
  private val catalogReady = AtomicBoolean(false)
  private val marketCount = AtomicInteger(0)
  private val subscriptionCount = AtomicInteger(0)

  @Volatile
  private var clickHouseTableIngestLagMs: Map<String, Long?> = config.clickHouse.readyTables.associateWith { null }

  @Volatile
  private var clickHouseTableEventLagMs: Map<String, Long?> = config.clickHouse.readyTables.associateWith { null }

  @Volatile
  private var clickHouseTableEventFutureSkewMs: Map<String, Long?> = config.clickHouse.readyTables.associateWith { null }

  private val httpClient =
    HttpClient(CIO) {
      install(WebSockets)
      install(ContentNegotiation) { json(this@HyperliquidFeedApp.json) }
    }
  private val metrics = HyperliquidMetrics(Metrics.registry)
  private val restBudget = MinuteWeightBudget(config.restWeightBudgetPerMinute, nowMs)
  private val backoff = ReconnectBackoff(config.reconnectBaseMs, config.reconnectMaxMs)
  private val dedup = DedupCache<String>(Duration.ofSeconds(config.dedupTtlSeconds), config.dedupMaxEntries)
  private val eventFreshness =
    EventFreshnessTracker(
      requiredChannels = config.readyRequiredChannels,
      maxAgeMs = config.readyEventMaxAgeMs,
      nowMs = nowMs,
    )

  fun start(): Job =
    scope.launch {
      appLogger.info {
        "hyperliquid feed starting network=${config.network} coverage=${config.marketCoverage} " +
          "infoUrl=${config.infoUrl} wsUrl=${config.wsUrl}"
      }
      val producer = producerFactory(config)
      val clickHouseSink =
        ClickHouseSink(config.clickHouse, httpClient, metrics, json, network = config.network) { update ->
          val observedAt = nowMs()
          clickHouseTableIngestLagMs = update.tableIngestLagMs
          clickHouseTableEventLagMs = update.tableEventLagMs
          clickHouseTableEventFutureSkewMs = update.tableEventFutureSkewMs
          clickHouseTableFresh.set(update.tableFreshnessReady)
          if (update.ready) {
            clickHouseLastSuccessMs.set(observedAt)
          } else {
            clickHouseLastFailureMs.set(observedAt)
          }
          clickHouseReady.set(update.ready)
          updateReady()
        }
      val clickHouseJob = clickHouseSink.start(this)
      val infoClient = HyperliquidInfoClient(config, httpClient, restBudget, json)

      try {
        val markets = infoClient.loadMarkets()
        if (markets.isEmpty()) error("Hyperliquid market catalog is empty")
        val shards = SubscriptionPlanner.plan(markets, config)
        val mapper = HyperliquidMapper(config, markets, SeqTracker(), json)
        marketCount.set(markets.size)
        subscriptionCount.set(shards.sumOf { it.subscriptions.size })
        catalogReady.set(true)
        metrics.setCatalogMarketCount(markets.size)
        metrics.setSubscriptionCount(subscriptionCount.get())
        metrics.setCatalogLastRefreshEpochMs(nowMs())

        publishRecords(producer, clickHouseSink, mapper.marketRecords(markets))
        publishRecords(producer, clickHouseSink, infoClient.loadFundingAndContextRecords(markets))

        val jobs =
          shards.map { shard ->
            launch { streamShardLoop(shard, producer, clickHouseSink, mapper) }
          } + launch { refreshContextLoop(infoClient, producer, clickHouseSink, markets) }

        jobs.joinAll()
        clickHouseJob.join()
      } finally {
        alive.set(false)
        markReady(false)
        wsReady.set(false)
        runCatching { producer.flush() }
        runCatching { producer.close() }
        runCatching { httpClient.close() }
      }
    }

  fun stop() {
    alive.set(false)
    markReady(false)
    scope.cancel()
  }

  fun isAlive(): Boolean = alive.get() && scope.coroutineContext.isActive

  fun readinessInfo(): HyperliquidReadinessInfo {
    val freshness = eventFreshnessSnapshot()
    val kafka = kafkaReadiness.snapshot()
    val clickHouseFresh = clickHouseFresh()
    val blockers =
      hyperliquidReadinessBlockers(
        wsReady = wsReady.get(),
        kafkaReady = kafka.ready,
        clickHouseFresh = clickHouseFresh,
        clickHouseRequiredForReadiness = config.clickHouse.requiredForReadiness,
        marketDataFresh = freshness.fresh,
        catalogReady = catalogReady.get(),
      )
    return HyperliquidReadinessInfo(
      status = if (ready.get()) "ready" else "not_ready",
      ready = ready.get(),
      readinessBlockers = blockers,
      websocket = wsReady.get(),
      kafka = kafka.ready,
      kafkaLastSuccessLagMs = kafka.lastSuccessLagMs,
      kafkaLastFailureAgeMs = kafka.lastFailureAgeMs,
      kafkaLastFailureReason = kafka.lastFailureReason,
      kafkaReadyMaxAgeMs = kafka.maxSuccessAgeMs,
      clickhouse = clickHouseFresh,
      clickhouseTableFresh = clickHouseTableFresh.get(),
      clickhouseLastSuccessLagMs = clickHouseLastSuccessLagMs(),
      clickhouseLastFailureAgeMs = clickHouseLastFailureAgeMs(),
      clickhouseReadyMaxAgeMs = config.clickHouse.readyMaxAgeMs,
      clickhouseTableReadyMaxAgeMs = config.clickHouse.tableReadyMaxAgeMs,
      clickhouseFailureHoldMs = config.clickHouse.failureHoldMs,
      clickhouseTableIngestLagMs = clickHouseTableIngestLagMs,
      clickhouseTableEventLagMs = clickHouseTableEventLagMs,
      clickhouseTableEventFutureSkewMs = clickHouseTableEventFutureSkewMs,
      marketDataFresh = freshness.fresh,
      marketDataLastSeenLagMs = freshness.lastSeenLagMs,
      marketDataMaxAgeMs = config.readyEventMaxAgeMs,
      catalog = catalogReady.get(),
      subscriptions = subscriptionCount.get(),
      markets = marketCount.get(),
    )
  }

  private suspend fun streamShardLoop(
    shard: SubscriptionShard,
    producer: KafkaProducer<String, String>,
    clickHouseSink: ClickHouseSink,
    mapper: HyperliquidMapper,
  ) {
    var attempt = 0
    while (scope.isActive) {
      try {
        metrics.reconnects.increment()
        httpClient.webSocket(config.wsUrl) {
          attempt = 0
          metrics.wsConnectSuccess.increment()
          wsReady.set(true)
          metrics.setWsConnected(true)
          subscribeAll(shard)
          updateReady()
          val marketDataStallGuard =
            MarketDataStallGuard(
              connectedAtMs = nowMs(),
              startupGraceMs = config.readyEventMaxAgeMs,
              checkIntervalMs = config.heartbeatIntervalMs,
            )
          val heartbeat = launch { heartbeatLoop() }
          try {
            while (scope.isActive) {
              val frame =
                withTimeoutOrNull(config.wsReadIdleTimeoutMs) {
                  incoming.receive()
                } ?: error(
                  "hyperliquid websocket shard=${shard.index} idle for ${config.wsReadIdleTimeoutMs}ms; reconnecting",
                )
              if (frame is Frame.Text) {
                val raw = frame.readText()
                val rawRecord = mapper.rawRecord(raw)
                publishRecords(producer, clickHouseSink, listOf(rawRecord))
                val normalized = mapper.websocketRecords(raw)
                publishRecords(producer, clickHouseSink, normalized)
              }

              val staleMarketData =
                marketDataStallGuard.staleSnapshotIfDue(
                  observedAtMs = nowMs(),
                  freshness = ::eventFreshnessSnapshot,
                )
              if (staleMarketData != null) {
                error(
                  "hyperliquid websocket shard=${shard.index} market data stale " +
                    "last_seen_lag_ms=${staleMarketData.lastSeenLagMs} " +
                    "ready_event_max_age_ms=${config.readyEventMaxAgeMs}; reconnecting",
                )
              }
            }
          } finally {
            heartbeat.cancel()
          }
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        wsReady.set(false)
        metrics.setWsConnected(false)
        updateReady()
        attempt += 1
        val delayMs = backoff.nextDelay(attempt)
        appLogger.warn(error) { "hyperliquid websocket shard=${shard.index} failed; reconnecting in ${delayMs}ms" }
        delay(delayMs)
      }
    }
  }

  private suspend fun DefaultClientWebSocketSession.subscribeAll(shard: SubscriptionShard) {
    shard.subscriptions.forEach { subscription ->
      outgoing.send(
        Frame.Text(
          json.encodeToString(
            buildJsonObject {
              put("method", "subscribe")
              put("subscription", subscription.toJson())
            },
          ),
        ),
      )
    }
  }

  private suspend fun DefaultClientWebSocketSession.heartbeatLoop() {
    while (scope.isActive) {
      delay(config.heartbeatIntervalMs)
      outgoing.send(Frame.Text("""{"method":"ping"}"""))
    }
  }

  private suspend fun refreshContextLoop(
    infoClient: HyperliquidInfoClient,
    producer: KafkaProducer<String, String>,
    clickHouseSink: ClickHouseSink,
    markets: List<HyperliquidMarket>,
  ) {
    while (scope.isActive) {
      delay(config.restMetadataRefreshMs)
      runCatching {
        publishRecords(producer, clickHouseSink, infoClient.loadFundingAndContextRecords(markets))
        metrics.setCatalogLastRefreshEpochMs(nowMs())
        metrics.setRestWeightUsed(restBudget.usedWeightInCurrentWindow())
      }.onFailure { error ->
        appLogger.warn(error) { "Hyperliquid metadata refresh failed" }
      }
    }
  }

  private suspend fun publishRecords(
    producer: KafkaProducer<String, String>,
    clickHouseSink: ClickHouseSink,
    records: List<RoutedEnvelope>,
  ) {
    records.forEach { record ->
      if (record.topic != config.topics.raw && dedup.isDuplicate(record.dedupKey())) {
        metrics.recordDedupDrop(record.envelope.channel)
        return@forEach
      }
      metrics.recordEvent(record.envelope.channel)
      recordMarketDataFreshness(record.envelope.channel)
      val payload = json.encodeToString(record.envelope)
      runCatching {
        producer.send(ProducerRecord(record.topic, record.key, payload)) { _, error ->
          if (error == null) {
            recordKafkaSuccess()
            metrics.kafkaProduceSuccess.increment()
          } else {
            recordKafkaFailure(record.topic, error)
          }
          updateReady()
        }
        clickHouseSink.enqueue(record)
      }.onFailure { error ->
        recordKafkaFailure(record.topic, error)
        updateReady()
      }
    }
  }

  private fun RoutedEnvelope.dedupKey(): String {
    val payload = envelope.payload as? JsonObject ?: return listOf(topic, key, envelope.channel, envelope.eventTs).joinToString(":")
    return when (envelope.channel) {
      "trades" ->
        listOf(
          topic,
          envelope.channel,
          envelope.coin,
          payload["time"]?.jsonPrimitive?.contentOrNull,
          payload["tid"]?.jsonPrimitive?.contentOrNull,
        ).joinToString(":")
      "l2Book", "bbo", "activeAssetCtx" ->
        listOf(topic, envelope.channel, envelope.marketId, payload["time"]?.jsonPrimitive?.contentOrNull).joinToString(":")
      "candle" ->
        listOf(
          topic,
          envelope.channel,
          envelope.marketId,
          payload["i"]?.jsonPrimitive?.contentOrNull,
          payload["t"]?.jsonPrimitive?.contentOrNull,
          payload["T"]?.jsonPrimitive?.contentOrNull,
        ).joinToString(":")
      else -> listOf(topic, key, envelope.channel, envelope.eventTs).joinToString(":")
    }
  }

  private fun updateReady() {
    val isReady =
      hyperliquidReadinessReady(
        wsReady = wsReady.get(),
        kafkaReady = kafkaReadiness.isReady(),
        clickHouseFresh = clickHouseFresh(),
        clickHouseRequiredForReadiness = config.clickHouse.requiredForReadiness,
        marketDataFresh = marketDataFresh(),
        catalogReady = catalogReady.get(),
      )
    markReady(isReady)
  }

  private fun recordMarketDataFreshness(channel: String) {
    val observedAt = eventFreshness.record(channel)
    metrics.setEventLastSeenEpochMs(channel, observedAt)
  }

  private fun marketDataFresh(): Boolean {
    val fresh = eventFreshness.isFresh()
    metrics.setMarketDataReady(fresh)
    return fresh
  }

  private fun eventFreshnessSnapshot(): EventFreshnessSnapshot = eventFreshness.snapshot()

  private fun recordKafkaSuccess() {
    kafkaReadiness.recordSuccess()
    val kafka = kafkaReadiness.snapshot()
    metrics.setKafkaLastSuccessEpochMs(kafka.lastSuccessEpochMs)
  }

  private fun recordKafkaFailure(
    topic: String,
    error: Throwable,
  ) {
    kafkaReadiness.recordFailure(error)
    val kafka = kafkaReadiness.snapshot()
    metrics.setKafkaLastFailureEpochMs(kafka.lastFailureEpochMs)
    metrics.recordKafkaError(topic)
    appLogger.warn(error) {
      "Kafka produce failed topic=$topic kafka_ready=${kafka.ready} " +
        "last_success_lag_ms=${kafka.lastSuccessLagMs} ready_max_age_ms=${kafka.maxSuccessAgeMs}"
    }
  }

  private fun clickHouseFresh(): Boolean {
    val fresh = clickHouseFreshAt(nowMs())
    metrics.setClickHouseReady(fresh)
    return fresh
  }

  private fun clickHouseFreshAt(observedAt: Long): Boolean {
    if (!config.clickHouse.enabled) return true
    val lastSuccess = clickHouseLastSuccessMs.get()
    val successFresh = lastSuccess > 0 && observedAt - lastSuccess <= config.clickHouse.readyMaxAgeMs
    return clickHouseReady.get() && successFresh
  }

  private fun clickHouseLastSuccessLagMs(): Long? {
    val lastSuccess = clickHouseLastSuccessMs.get()
    if (lastSuccess <= 0) return null
    return nowMs() - lastSuccess
  }

  private fun clickHouseLastFailureAgeMs(): Long? {
    val lastFailure = clickHouseLastFailureMs.get()
    if (lastFailure <= 0) return null
    return nowMs() - lastFailure
  }

  private fun markReady(value: Boolean) {
    ready.set(value)
    metrics.setReady(value)
    metrics.setWsConnected(wsReady.get())
    val observedAt = nowMs()
    val kafkaReady = kafkaReadiness.isReady()
    val clickHouseFresh = clickHouseFreshAt(observedAt)
    val marketDataFresh = eventFreshnessSnapshot().fresh
    metrics.setKafkaReady(kafkaReady)
    metrics.setClickHouseReady(clickHouseFresh)
    metrics.setMarketDataReady(marketDataFresh)
    metrics.setReadinessBlockers(
      hyperliquidReadinessBlockers(
        wsReady = wsReady.get(),
        kafkaReady = kafkaReady,
        clickHouseFresh = clickHouseFresh,
        clickHouseRequiredForReadiness = config.clickHouse.requiredForReadiness,
        marketDataFresh = marketDataFresh,
        catalogReady = catalogReady.get(),
      ),
    )
  }
}

internal fun hyperliquidReadinessReady(
  wsReady: Boolean,
  kafkaReady: Boolean,
  clickHouseFresh: Boolean,
  clickHouseRequiredForReadiness: Boolean,
  marketDataFresh: Boolean,
  catalogReady: Boolean,
): Boolean =
  wsReady &&
    kafkaReady &&
    (!clickHouseRequiredForReadiness || clickHouseFresh) &&
    marketDataFresh &&
    catalogReady

internal fun hyperliquidReadinessBlockers(
  wsReady: Boolean,
  kafkaReady: Boolean,
  clickHouseFresh: Boolean,
  clickHouseRequiredForReadiness: Boolean,
  marketDataFresh: Boolean,
  catalogReady: Boolean,
): List<String> =
  buildList {
    if (!wsReady) add("websocket_not_connected")
    if (!kafkaReady) add("kafka_no_recent_success")
    if (clickHouseRequiredForReadiness && !clickHouseFresh) add("clickhouse_not_fresh")
    if (!marketDataFresh) add("market_data_stale")
    if (!catalogReady) add("catalog_not_loaded")
  }

fun main() =
  runBlocking {
    val config =
      runCatching { HyperliquidConfig.fromEnv() }
        .getOrElse { error ->
          appLogger.error(error) { "invalid Hyperliquid feed configuration" }
          exitProcess(2)
        }
    val app = HyperliquidFeedApp(config)
    val health = HealthServer(app, config)
    health.start()
    val job = app.start()
    Runtime.getRuntime().addShutdownHook(
      Thread {
        app.stop()
        health.stop()
      },
    )
    job.join()
  }
