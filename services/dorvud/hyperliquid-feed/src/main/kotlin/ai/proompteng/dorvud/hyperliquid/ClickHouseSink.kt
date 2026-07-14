package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.request.basicAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedSendChannelException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import mu.KotlinLogging
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.random.Random

private val clickHouseLogger = KotlinLogging.logger {}
private val clickHouseIdentifierPattern = Regex("[A-Za-z_][A-Za-z0-9_]*")

data class ClickHouseReadinessUpdate(
  val ready: Boolean,
  val writeSucceeded: Boolean? = null,
  val tableFreshnessReady: Boolean = ready,
  val tableIngestLagMs: Map<String, Long?>,
  val tableEventLagMs: Map<String, Long?>,
  val tableEventFutureSkewMs: Map<String, Long?>,
)

private data class ClickHouseTableFreshness(
  val ingestLagMs: Map<String, Long?>,
  val eventLagMs: Map<String, Long?>,
  val eventFutureSkewMs: Map<String, Long?>,
)

class ClickHouseSink(
  private val config: ClickHouseConfig,
  private val httpClient: HttpClient,
  private val metrics: HyperliquidMetrics,
  private val json: Json,
  private val network: String = "mainnet",
  private val nowMs: () -> Long = { System.currentTimeMillis() },
  private val onReady: (ClickHouseReadinessUpdate) -> Unit = {},
) {
  private val channelCapacity = maxOf(1, config.queueCapacity / maxOf(1, config.enabledTables.size))
  private val tableChannels = config.enabledTables.associateWith { Channel<RoutedEnvelope>(capacity = channelCapacity) }
  private val failedTables = ConcurrentHashMap.newKeySet<String>()
  private val freshnessMutex = Mutex()
  private val lastFreshnessCheckMs = AtomicLong(0)
  private val tableFreshnessReady = AtomicBoolean(!config.enabled)

  @Volatile
  private var workerJob: Job? = null

  @Volatile
  private var latestTableIngestLagMs: Map<String, Long?> = config.readyTables.associateWith { null }

  @Volatile
  private var latestTableEventLagMs: Map<String, Long?> = config.readyTables.associateWith { null }

  @Volatile
  private var latestTableEventFutureSkewMs: Map<String, Long?> = config.readyTables.associateWith { null }

  suspend fun enqueue(record: RoutedEnvelope) {
    if (!config.enabled) return
    if (workerJob?.isActive == false) return
    val table = tableForTopic(record.topic)
    val channel = tableChannels[table] ?: return
    metrics.addClickHousePendingRecords(table, 1)
    try {
      channel.send(record)
    } catch (_: ClosedSendChannelException) {
      metrics.addClickHousePendingRecords(table, -1)
    } catch (error: CancellationException) {
      metrics.addClickHousePendingRecords(table, -1)
      throw error
    }
  }

  fun start(scope: CoroutineScope): Job {
    check(workerJob == null) { "ClickHouse sink has already been started" }
    val job =
      scope.launch(Dispatchers.IO) {
        if (!config.enabled) {
          metrics.setClickHouseReady(true)
          emitReadiness(ready = true, tableFreshnessReady = true)
          return@launch
        }
        try {
          coroutineScope {
            tableChannels
              .map { (table, channel) -> launch { processTable(table, channel) } }
              .joinAll()
          }
        } finally {
          tableChannels.values.forEach { it.close() }
        }
      }
    workerJob = job
    return job
  }

  private suspend fun processTable(
    table: String,
    channel: Channel<RoutedEnvelope>,
  ) {
    val policy = config.batchPolicyFor(table)
    val batch = mutableListOf<RoutedEnvelope>()
    try {
      while (currentCoroutineContext().isActive) {
        val first = channel.receiveCatching().getOrNull() ?: break
        batch += first
        val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(policy.flushMs)
        while (batch.size < policy.batchSize) {
          val remainingNanos = deadlineNanos - System.nanoTime()
          if (remainingNanos <= 0) break
          val remainingMs = TimeUnit.NANOSECONDS.toMillis(remainingNanos).coerceAtLeast(1)
          val next = withTimeoutOrNull(remainingMs) { channel.receiveCatching().getOrNull() } ?: break
          batch += next
        }
        val reason = if (batch.size >= policy.batchSize) "size" else "time"
        flushWithRetry(table, batch, reason)
        batch.clear()
        refreshReadinessAfterInsert()
      }
    } finally {
      while (true) {
        val pending = channel.tryReceive().getOrNull() ?: break
        batch += pending
      }
      flushOnShutdown(table, batch)
    }
  }

  private suspend fun flushOnShutdown(
    table: String,
    records: List<RoutedEnvelope>,
  ) {
    if (records.isEmpty()) return
    withContext(NonCancellable) {
      val completed =
        withTimeoutOrNull(config.shutdownFlushTimeoutMs) {
          flushWithRetry(table, records, "shutdown")
          true
        } ?: false
      if (!completed) {
        clickHouseLogger.error {
          "clickhouse shutdown flush timed out table=$table records=${records.size} " +
            "timeout_ms=${config.shutdownFlushTimeoutMs}"
        }
      }
    }
  }

  private suspend fun flushWithRetry(
    table: String,
    records: List<RoutedEnvelope>,
    reason: String,
  ) {
    if (records.isEmpty()) return
    // Reusing the exact body keeps ReplicatedMergeTree retry block hashes stable.
    val body = records.joinToString("\n") { json.encodeToString(clickHouseRowFor(json, it)) }
    val bodyBytes = body.toByteArray(Charsets.UTF_8).size
    val startedAtNanos = System.nanoTime()
    var retryDelayMs = config.retryInitialMs
    var attempt = 1
    while (currentCoroutineContext().isActive) {
      try {
        insertRows(table, body)
      } catch (error: Exception) {
        if (error is CancellationException && !currentCoroutineContext().isActive) throw error
        failedTables.add(table)
        val freshnessReady = tableFreshnessReady.get()
        val ready = !hasRequiredFailures() && freshnessReady
        runCatching {
          metrics.recordClickHouseError(table)
          metrics.recordClickHouseRetry(table)
          metrics.setClickHouseReady(ready)
          emitReadiness(ready = ready, tableFreshnessReady = freshnessReady, writeSucceeded = false)
        }.onFailure { metricsError ->
          clickHouseLogger.warn(metricsError) { "clickhouse retry metric recording failed table=$table" }
        }
        if (attempt == 1 || attempt % 10 == 0) {
          clickHouseLogger.warn(error) {
            "clickhouse insert failed table=$table records=${records.size} attempt=$attempt retry_ms=$retryDelayMs"
          }
        }
        delay(jitteredRetryDelay(retryDelayMs))
        retryDelayMs = min(config.retryMaxMs, retryDelayMs * 2)
        attempt += 1
        continue
      }
      failedTables.remove(table)
      runCatching {
        metrics.addClickHousePendingRecords(table, -records.size)
        metrics.recordClickHouseFlush(
          table = table,
          reason = reason,
          rows = records.size,
          bytes = bodyBytes,
          durationNanos = System.nanoTime() - startedAtNanos,
        )
      }.onFailure { error ->
        clickHouseLogger.warn(error) { "clickhouse flush metric recording failed table=$table" }
      }
      return
    }
  }

  private suspend fun refreshReadinessAfterInsert() {
    val freshnessReady = refreshTableFreshnessIfDue()
    val ready = !hasRequiredFailures() && freshnessReady
    metrics.setClickHouseReady(ready)
    emitReadiness(ready = ready, tableFreshnessReady = freshnessReady, writeSucceeded = true)
  }

  private fun hasRequiredFailures(): Boolean = failedTables.any { it in config.readyTables }

  private fun jitteredRetryDelay(baseMs: Long): Long {
    if (baseMs >= config.retryMaxMs) return config.retryMaxMs
    val jitterLimit = maxOf(1, baseMs / 5)
    return min(config.retryMaxMs, baseMs + Random.nextLong(jitterLimit + 1))
  }

  private suspend fun insertRows(
    table: String,
    body: String,
  ) {
    val query = "INSERT INTO ${config.database}.$table FORMAT JSONEachRow"
    executeClickHouse(query, body)
  }

  private suspend fun executeClickHouse(
    query: String,
    body: String? = null,
  ): String {
    val responseBody =
      withTimeout(config.requestTimeoutMs) {
        val response =
          httpClient.post("${config.httpUrl.trimEnd('/')}?query=${java.net.URLEncoder.encode(query, Charsets.UTF_8)}") {
            if (config.password.isNotEmpty()) basicAuth(config.username, config.password)
            if (body != null) {
              contentType(ContentType.Application.Json)
              setBody(body)
            }
          }
        val responseBody = response.bodyAsText()
        if (!response.status.isSuccess()) {
          error("clickhouse_http_${response.status.value}:${responseBody.take(256)}")
        }
        responseBody
      }
    return responseBody
  }

  private suspend fun refreshTableFreshnessIfDue(): Boolean {
    if (!config.enabled) return true
    val observedAt = nowMs()
    val lastCheck = lastFreshnessCheckMs.get()
    if (lastCheck > 0 && observedAt - lastCheck < config.freshnessCheckMs) return tableFreshnessReady.get()

    return freshnessMutex.withLock {
      val lockedObservedAt = nowMs()
      val lockedLastCheck = lastFreshnessCheckMs.get()
      if (lockedLastCheck > 0 && lockedObservedAt - lockedLastCheck < config.freshnessCheckMs) {
        return@withLock tableFreshnessReady.get()
      }
      try {
        val freshness = queryTableFreshness(lockedObservedAt)
        latestTableIngestLagMs = freshness.ingestLagMs
        latestTableEventLagMs = freshness.eventLagMs
        latestTableEventFutureSkewMs = freshness.eventFutureSkewMs
        freshness.ingestLagMs.forEach { (table, lagMs) -> metrics.setClickHouseTableIngestLagMs(table, lagMs) }
        freshness.eventLagMs.forEach { (table, lagMs) -> metrics.setClickHouseTableEventLagMs(table, lagMs) }
        freshness.eventFutureSkewMs.forEach { (table, skewMs) ->
          metrics.setClickHouseTableEventFutureSkewMs(table, skewMs)
        }
        val fresh = freshness.ingestLagMs.values.all { lagMs -> lagMs != null && lagMs <= config.tableReadyMaxAgeMs }
        tableFreshnessReady.set(fresh)
        lastFreshnessCheckMs.set(lockedObservedAt)
        if (!fresh) {
          clickHouseLogger.warn {
            "clickhouse table ingest freshness stale ingest_lags_ms=${freshness.ingestLagMs} " +
              "event_lags_ms=${freshness.eventLagMs} table_ready_max_age_ms=${config.tableReadyMaxAgeMs}"
          }
        }
        fresh
      } catch (error: Exception) {
        if (error is CancellationException && !currentCoroutineContext().isActive) throw error
        tableFreshnessReady.set(false)
        lastFreshnessCheckMs.set(lockedObservedAt)
        clickHouseLogger.warn(error) { "clickhouse table freshness query failed" }
        false
      }
    }
  }

  private suspend fun queryTableFreshness(observedAt: Long): ClickHouseTableFreshness {
    val database = clickHouseIdentifier(config.database)
    val tables = config.readyTables.sorted().map(::clickHouseIdentifier)
    val union =
      tables.joinToString("\nUNION ALL\n") { table ->
        "SELECT '$table' AS table, " +
          "max(parseDateTimeBestEffort(ingest_ts)) AS latest_ingest, " +
          "max(parseDateTimeBestEffort(event_ts)) AS latest_event " +
          "FROM $database.$table WHERE network = ${sqlString(network)}"
      }
    val query =
      """
      SELECT
        table,
        if(isNull(latest_ingest), NULL, toUnixTimestamp64Milli(toDateTime64(latest_ingest, 3))) AS latest_ingest_ms,
        if(isNull(latest_event), NULL, toUnixTimestamp64Milli(toDateTime64(latest_event, 3))) AS latest_event_ms
      FROM (
      $union
      )
      FORMAT JSONEachRow
      """.trimIndent()
    val ingestRows = mutableMapOf<String, Long?>()
    val eventRows = mutableMapOf<String, Long?>()
    val eventFutureSkewRows = mutableMapOf<String, Long?>()
    executeClickHouse(query)
      .lineSequence()
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .forEach { line ->
        val row = json.decodeFromString<JsonObject>(line)
        val table = row["table"]?.jsonPrimitive?.contentOrNull
        val latestIngestMs = row["latest_ingest_ms"]?.jsonPrimitive?.longOrNull
        val latestEventMs = row["latest_event_ms"]?.jsonPrimitive?.longOrNull
        if (table != null) {
          ingestRows[table] = latestIngestMs?.takeIf { it > 0 }?.let { observedAt - it }
          eventRows[table] = latestEventMs?.takeIf { it > 0 }?.let { observedAt - it }
          eventFutureSkewRows[table] =
            latestEventMs
              ?.takeIf { it > 0 }
              ?.let { eventMs -> if (eventMs > observedAt) eventMs - observedAt else 0 }
        }
      }
    return ClickHouseTableFreshness(
      ingestLagMs = tables.associateWith { ingestRows[it] },
      eventLagMs = tables.associateWith { eventRows[it] },
      eventFutureSkewMs = tables.associateWith { eventFutureSkewRows[it] },
    )
  }

  private fun tableForTopic(topic: String): String =
    when {
      topic.endsWith(".markets.v1") -> "hyperliquid_market_catalog"
      topic.endsWith(".trades.v1") -> "hyperliquid_trades"
      topic.endsWith(".books.l2.v1") -> "hyperliquid_l2_books"
      topic.endsWith(".bbo.v1") -> "hyperliquid_bbo"
      topic.endsWith(".candles.v1") -> "hyperliquid_candles"
      topic.endsWith(".asset-ctx.v1") -> "hyperliquid_asset_contexts"
      topic.endsWith(".funding.v1") -> "hyperliquid_funding"
      topic.endsWith(".status.v1") -> "hyperliquid_status"
      else -> "hyperliquid_raw"
    }

  private fun emitReadiness(
    ready: Boolean,
    tableFreshnessReady: Boolean,
    writeSucceeded: Boolean? = null,
  ) {
    onReady(
      ClickHouseReadinessUpdate(
        ready = ready,
        writeSucceeded = writeSucceeded,
        tableFreshnessReady = tableFreshnessReady,
        tableIngestLagMs = latestTableIngestLagMs,
        tableEventLagMs = latestTableEventLagMs,
        tableEventFutureSkewMs = latestTableEventFutureSkewMs,
      ),
    )
  }

  private fun clickHouseIdentifier(value: String): String {
    require(clickHouseIdentifierPattern.matches(value)) { "Invalid ClickHouse identifier: $value" }
    return value
  }

  private fun sqlString(value: String): String = "'${value.replace("\\", "\\\\").replace("'", "\\'")}'"
}
