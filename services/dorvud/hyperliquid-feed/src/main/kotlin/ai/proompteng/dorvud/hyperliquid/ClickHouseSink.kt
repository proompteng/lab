package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.request.basicAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import mu.KotlinLogging
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

private val clickHouseLogger = KotlinLogging.logger {}
private val clickHouseIdentifierPattern = Regex("[A-Za-z_][A-Za-z0-9_]*")

data class ClickHouseReadinessUpdate(
  val ready: Boolean,
  val tableFreshnessReady: Boolean = ready,
  val tableIngestLagMs: Map<String, Long?>,
  val tableEventLagMs: Map<String, Long?>,
)

private data class ClickHouseTableFreshness(
  val ingestLagMs: Map<String, Long?>,
  val eventLagMs: Map<String, Long?>,
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
  private val channel = Channel<RoutedEnvelope>(capacity = 10_000)
  private val lastFreshnessCheckMs = AtomicLong(0)
  private val tableFreshnessReady = AtomicBoolean(!config.enabled)

  @Volatile
  private var latestTableIngestLagMs: Map<String, Long?> = config.readyTables.associateWith { null }

  @Volatile
  private var latestTableEventLagMs: Map<String, Long?> = config.readyTables.associateWith { null }

  suspend fun enqueue(record: RoutedEnvelope) {
    if (!config.enabled) return
    if (tableForTopic(record.topic) !in config.enabledTables) return
    channel.send(record)
  }

  fun start(scope: CoroutineScope): Job =
    scope.launch(Dispatchers.IO) {
      if (!config.enabled) {
        metrics.setClickHouseReady(true)
        emitReadiness(ready = true, tableFreshnessReady = true)
        return@launch
      }
      val batch = mutableListOf<RoutedEnvelope>()
      while (isActive) {
        val first = channel.receiveCatching().getOrNull() ?: continue
        batch += first
        val deadline = nowMs() + config.flushMs
        while (batch.size < config.batchSize) {
          val remainingMs = deadline - nowMs()
          if (remainingMs <= 0) break
          val next =
            withTimeoutOrNull(remainingMs) {
              channel.receiveCatching().getOrNull()
            } ?: break
          batch += next
        }
        flush(batch.toList())
        batch.clear()
      }
    }

  private suspend fun flush(records: List<RoutedEnvelope>) {
    records.groupBy { tableForTopic(it.topic) }.forEach { (table, tableRecords) ->
      val body = tableRecords.joinToString("\n") { json.encodeToString(rowFor(it)) }
      runCatching {
        insertRows(table, body)
        refreshTableFreshnessIfDue()
      }.onSuccess {
        metrics.setClickHouseReady(it)
        emitReadiness(ready = it, tableFreshnessReady = it)
      }.onFailure { error ->
        metrics.setClickHouseReady(false)
        emitReadiness(ready = false, tableFreshnessReady = false)
        metrics.recordClickHouseError(table)
        clickHouseLogger.warn(error) { "clickhouse insert failed table=$table records=${tableRecords.size}" }
      }
    }
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

    return runCatching {
      queryTableFreshness(observedAt)
    }.fold(
      onSuccess = { freshness ->
        latestTableIngestLagMs = freshness.ingestLagMs
        latestTableEventLagMs = freshness.eventLagMs
        freshness.ingestLagMs.forEach { (table, lagMs) -> metrics.setClickHouseTableIngestLagMs(table, lagMs) }
        freshness.eventLagMs.forEach { (table, lagMs) -> metrics.setClickHouseTableEventLagMs(table, lagMs) }
        val fresh = freshness.eventLagMs.values.all { lagMs -> lagMs != null && lagMs <= config.readyMaxAgeMs }
        tableFreshnessReady.set(fresh)
        lastFreshnessCheckMs.set(observedAt)
        if (!fresh) clickHouseLogger.warn { "clickhouse table event freshness stale lags_ms=${freshness.eventLagMs}" }
        fresh
      },
      onFailure = { error ->
        tableFreshnessReady.set(false)
        lastFreshnessCheckMs.set(observedAt)
        clickHouseLogger.warn(error) { "clickhouse table freshness query failed" }
        false
      },
    )
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
        }
      }
    return ClickHouseTableFreshness(
      ingestLagMs = tables.associateWith { ingestRows[it] },
      eventLagMs = tables.associateWith { eventRows[it] },
    )
  }

  private fun rowFor(record: RoutedEnvelope): JsonObject =
    buildJsonObject {
      val env = record.envelope
      put("ingest_ts", env.ingestTs)
      put("event_ts", env.eventTs)
      put("provider", env.provider)
      put("network", env.network)
      put("feed", env.feed)
      put("channel", env.channel)
      put("symbol", env.symbol)
      env.marketType?.let { put("market_type", it) }
      env.marketId?.let { put("market_id", it) }
      env.dex?.let { put("dex", it) }
      env.coin?.let { put("coin", it) }
      env.spotIndex?.let { put("spot_index", it) }
      put("seq", env.seq)
      put("is_final", env.isFinal)
      put("source", env.source)
      put("version", env.version)
      put("payload", json.encodeToString(env.payload))
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
  ) {
    onReady(
      ClickHouseReadinessUpdate(
        ready = ready,
        tableFreshnessReady = tableFreshnessReady,
        tableIngestLagMs = latestTableIngestLagMs,
        tableEventLagMs = latestTableEventLagMs,
      ),
    )
  }

  private fun clickHouseIdentifier(value: String): String {
    require(clickHouseIdentifierPattern.matches(value)) { "Invalid ClickHouse identifier: $value" }
    return value
  }

  private fun sqlString(value: String): String = "'${value.replace("\\", "\\\\").replace("'", "\\'")}'"
}
