package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
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
      val readySignals = mutableListOf<Boolean>()
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
        while (readySignals.lastOrNull() != false) {
          delay(10)
        }
      }

      assertEquals(false, readySignals.last())
      job.cancelAndJoin()
      client.close()
    }

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
