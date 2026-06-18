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
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import mu.KotlinLogging

private val clickHouseLogger = KotlinLogging.logger {}

class ClickHouseSink(
  private val config: ClickHouseConfig,
  private val httpClient: HttpClient,
  private val metrics: HyperliquidMetrics,
  private val json: Json,
  private val onReady: (Boolean) -> Unit = {},
) {
  private val channel = Channel<RoutedEnvelope>(capacity = 10_000)

  suspend fun enqueue(record: RoutedEnvelope) {
    if (!config.enabled) return
    channel.send(record)
  }

  fun start(scope: CoroutineScope): Job =
    scope.launch(Dispatchers.IO) {
      if (!config.enabled) {
        metrics.setClickHouseReady(true)
        onReady(true)
        return@launch
      }
      val batch = mutableListOf<RoutedEnvelope>()
      while (isActive) {
        val first = channel.receiveCatching().getOrNull()
        if (first != null) batch += first
        val deadline = System.currentTimeMillis() + config.flushMs
        while (batch.size < config.batchSize && System.currentTimeMillis() < deadline) {
          val next = channel.tryReceive().getOrNull() ?: break
          batch += next
        }
        if (batch.isEmpty()) {
          delay(config.flushMs)
          continue
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
      }.onSuccess {
        metrics.setClickHouseReady(true)
        onReady(true)
      }.onFailure { error ->
        metrics.setClickHouseReady(false)
        onReady(false)
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
    val response =
      httpClient.post("${config.httpUrl.trimEnd('/')}?query=${java.net.URLEncoder.encode(query, Charsets.UTF_8)}") {
        if (config.password.isNotEmpty()) basicAuth(config.username, config.password)
        contentType(ContentType.Application.Json)
        setBody(body)
      }
    if (!response.status.isSuccess()) {
      val responseBody = response.bodyAsText().take(256)
      error("clickhouse_http_${response.status.value}:$responseBody")
    }
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
}
