package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

class ClickHouseSinkTest {
  @Test
  fun `marks clickhouse not ready for non successful insert response`() =
    runBlocking {
      val readySignals = mutableListOf<ClickHouseReadinessUpdate>()
      val client =
        HttpClient(
          MockEngine {
            respond(content = "replica unavailable", status = HttpStatusCode.InternalServerError)
          },
        )
      val sink =
        ClickHouseSink(
          config =
            ClickHouseConfig(
              enabled = true,
              httpUrl = "http://clickhouse.local:8123",
              database = "torghut",
              username = "torghut",
              password = "",
              batchSize = 1,
              flushMs = 1,
              readyMaxAgeMs = 1_000,
              failureHoldMs = 1_000,
            ),
          httpClient = client,
          metrics = HyperliquidMetrics(SimpleMeterRegistry()),
          json = Json,
          onReady = { readySignals += it },
        )
      val job = sink.start(this)

      sink.enqueue(candleRecord())

      withTimeout(1_000) {
        while (readySignals.lastOrNull()?.ready != false) {
          delay(10)
        }
      }

      assertEquals(false, readySignals.last().ready)
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `marks clickhouse not ready when table ingest freshness is stale`() =
    runBlocking {
      val readySignals = mutableListOf<ClickHouseReadinessUpdate>()
      val client =
        HttpClient(
          MockEngine { request ->
            if (queryParam(request.url).startsWith("INSERT")) {
              respond(content = "", status = HttpStatusCode.OK)
            } else {
              respond(
                content =
                  """
                  {"table":"hyperliquid_candles","latest_ingest_ms":7000}
                  {"table":"hyperliquid_raw","latest_ingest_ms":7000}
                  """.trimIndent(),
                status = HttpStatusCode.OK,
              )
            }
          },
        )
      val sink =
        ClickHouseSink(
          config = clickHouseConfig(readyMaxAgeMs = 1_000),
          httpClient = client,
          metrics = HyperliquidMetrics(SimpleMeterRegistry()),
          json = Json,
          nowMs = { 10_000 },
          onReady = { readySignals += it },
        )
      val job = sink.start(this)

      sink.enqueue(candleRecord())

      withTimeout(1_000) {
        while (readySignals.lastOrNull()?.ready != false) {
          delay(10)
        }
      }

      assertEquals(false, readySignals.last().ready)
      assertEquals(3_000, readySignals.last().tableIngestLagMs["hyperliquid_candles"])
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `marks clickhouse ready when insert succeeds and table ingest is fresh`() =
    runBlocking {
      val readySignals = mutableListOf<ClickHouseReadinessUpdate>()
      val client =
        HttpClient(
          MockEngine { request ->
            if (queryParam(request.url).startsWith("INSERT")) {
              respond(content = "", status = HttpStatusCode.OK)
            } else {
              respond(
                content =
                  """
                  {"table":"hyperliquid_candles","latest_ingest_ms":9500}
                  {"table":"hyperliquid_raw","latest_ingest_ms":9400}
                  """.trimIndent(),
                status = HttpStatusCode.OK,
              )
            }
          },
        )
      val sink =
        ClickHouseSink(
          config = clickHouseConfig(readyMaxAgeMs = 1_000),
          httpClient = client,
          metrics = HyperliquidMetrics(SimpleMeterRegistry()),
          json = Json,
          nowMs = { 10_000 },
          onReady = { readySignals += it },
        )
      val job = sink.start(this)

      sink.enqueue(candleRecord())

      withTimeout(1_000) {
        while (readySignals.lastOrNull()?.ready != true) {
          delay(10)
        }
      }

      assertEquals(true, readySignals.last().ready)
      assertEquals(500, readySignals.last().tableIngestLagMs["hyperliquid_candles"])
      job.cancelAndJoin()
      client.close()
    }

  private fun clickHouseConfig(readyMaxAgeMs: Long): ClickHouseConfig =
    ClickHouseConfig(
      enabled = true,
      httpUrl = "http://clickhouse.local:8123",
      database = "torghut",
      username = "torghut",
      password = "",
      batchSize = 1,
      flushMs = 1,
      readyMaxAgeMs = readyMaxAgeMs,
      failureHoldMs = 1_000,
      readyTables = setOf("hyperliquid_raw", "hyperliquid_candles"),
      freshnessCheckMs = 1,
    )

  private fun queryParam(url: Url): String = url.parameters["query"] ?: ""

  private fun candleRecord(): RoutedEnvelope =
    RoutedEnvelope(
      topic = "torghut.hyperliquid.candles.v1",
      key = "hl:perp:cash:cash:AAPL",
      envelope =
        HyperliquidEnvelope(
          ingestTs = "2026-06-18T04:00:00Z",
          eventTs = "2026-06-18T04:00:00Z",
          network = "mainnet",
          feed = "hyperliquid-mainnet",
          channel = "candle",
          symbol = "cash:AAPL",
          marketType = "perp",
          marketId = "hl:perp:cash:cash:AAPL",
          dex = "cash",
          coin = "cash:AAPL",
          spotIndex = null,
          seq = 1,
          source = "ws",
          payload =
            buildJsonObject {
              put("i", "1m")
              put("c", "100")
            },
        ),
    )
}
