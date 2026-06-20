package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.content.TextContent
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
import kotlin.test.assertTrue

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
              requiredForReadiness = true,
              httpUrl = "http://clickhouse.local:8123",
              database = "torghut",
              username = "torghut",
              password = "",
              batchSize = 1,
              flushMs = 1,
              requestTimeoutMs = 1_000,
              readyMaxAgeMs = 1_000,
              failureHoldMs = 1_000,
              enabledTables = setOf("hyperliquid_raw", "hyperliquid_candles"),
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
      assertEquals(false, readySignals.last().tableFreshnessReady)
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `batches records during flush window before inserting`() =
    runBlocking {
      val readySignals = mutableListOf<ClickHouseReadinessUpdate>()
      val insertBodies = mutableListOf<String>()
      val client =
        HttpClient(
          MockEngine { request ->
            if (queryParam(request.url).startsWith("INSERT")) {
              insertBodies += (request.body as TextContent).text
              respond(content = "", status = HttpStatusCode.OK)
            } else {
              respond(
                content =
                  """
                  {"table":"hyperliquid_candles","latest_ingest_ms":9900,"latest_event_ms":9900}
                  {"table":"hyperliquid_raw","latest_ingest_ms":9900,"latest_event_ms":9900}
                  """.trimIndent(),
                status = HttpStatusCode.OK,
              )
            }
          },
        )
      val sink =
        ClickHouseSink(
          config = clickHouseConfig(readyMaxAgeMs = 1_000, batchSize = 10, flushMs = 50),
          httpClient = client,
          metrics = HyperliquidMetrics(SimpleMeterRegistry()),
          json = Json,
          nowMs = { 10_000 },
          onReady = { readySignals += it },
        )
      val job = sink.start(this)

      repeat(3) { sink.enqueue(candleRecord(seq = it.toLong() + 1)) }

      withTimeout(1_000) {
        while (readySignals.lastOrNull()?.ready != true) {
          delay(10)
        }
      }

      assertEquals(1, insertBodies.size)
      assertEquals(
        3,
        insertBodies
          .single()
          .lineSequence()
          .filter { it.isNotBlank() }
          .count(),
      )
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `times out a stalled clickhouse request and marks not ready`() =
    runBlocking {
      val readySignals = mutableListOf<ClickHouseReadinessUpdate>()
      var insertAttempts = 0
      val client =
        HttpClient(
          MockEngine { request ->
            if (queryParam(request.url).startsWith("INSERT")) {
              insertAttempts += 1
              if (insertAttempts == 1) {
                delay(5_000)
              }
              respond(content = "", status = HttpStatusCode.OK)
            } else {
              respond(
                content =
                  """
                  {"table":"hyperliquid_candles","latest_ingest_ms":9900,"latest_event_ms":9900}
                  {"table":"hyperliquid_raw","latest_ingest_ms":9900,"latest_event_ms":9900}
                  """.trimIndent(),
                status = HttpStatusCode.OK,
              )
            }
          },
        )
      val sink =
        ClickHouseSink(
          config = clickHouseConfig(readyMaxAgeMs = 1_000, requestTimeoutMs = 100),
          httpClient = client,
          metrics = HyperliquidMetrics(SimpleMeterRegistry()),
          json = Json,
          nowMs = { 10_000 },
          onReady = { readySignals += it },
        )
      val job = sink.start(this)

      sink.enqueue(candleRecord(seq = 1))
      withTimeout(1_000) {
        while (readySignals.lastOrNull()?.ready != false) {
          delay(10)
        }
      }

      assertEquals(1, insertAttempts)
      assertTrue(job.isActive)
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `continues draining records after a clickhouse insert failure`() =
    runBlocking {
      val readySignals = mutableListOf<ClickHouseReadinessUpdate>()
      var insertAttempts = 0
      val client =
        HttpClient(
          MockEngine { request ->
            if (queryParam(request.url).startsWith("INSERT")) {
              insertAttempts += 1
              if (insertAttempts == 1) {
                respond(content = "replica unavailable", status = HttpStatusCode.InternalServerError)
              } else {
                respond(content = "", status = HttpStatusCode.OK)
              }
            } else {
              respond(
                content =
                  """
                  {"table":"hyperliquid_candles","latest_ingest_ms":9900,"latest_event_ms":9900}
                  {"table":"hyperliquid_raw","latest_ingest_ms":9900,"latest_event_ms":9900}
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

      sink.enqueue(candleRecord(seq = 1))
      withTimeout(1_000) {
        while (readySignals.lastOrNull()?.ready != false) {
          delay(10)
        }
      }

      sink.enqueue(candleRecord(seq = 2))
      withTimeout(1_000) {
        while (readySignals.lastOrNull()?.ready != true) {
          delay(10)
        }
      }

      assertEquals(2, insertAttempts)
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `marks clickhouse not ready when inserts succeed but ingest freshness is stale`() =
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
                  {"table":"hyperliquid_candles","latest_ingest_ms":7000,"latest_event_ms":9900}
                  {"table":"hyperliquid_raw","latest_ingest_ms":7000,"latest_event_ms":9900}
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
        while (readySignals.lastOrNull()?.tableFreshnessReady != false) {
          delay(10)
        }
      }

      assertEquals(false, readySignals.last().ready)
      assertEquals(false, readySignals.last().tableFreshnessReady)
      assertEquals(3_000, readySignals.last().tableIngestLagMs["hyperliquid_candles"])
      assertEquals(100, readySignals.last().tableEventLagMs["hyperliquid_candles"])
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `marks clickhouse ready when ingest is fresh even if candle event time is older`() =
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
                  {"table":"hyperliquid_candles","latest_ingest_ms":9900,"latest_event_ms":7000}
                  {"table":"hyperliquid_raw","latest_ingest_ms":9900,"latest_event_ms":9900}
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
      assertEquals(true, readySignals.last().tableFreshnessReady)
      assertEquals(100, readySignals.last().tableIngestLagMs["hyperliquid_candles"])
      assertEquals(3_000, readySignals.last().tableEventLagMs["hyperliquid_candles"])
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `marks clickhouse ready when insert succeeds and table event time is fresh`() =
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
                  {"table":"hyperliquid_candles","latest_ingest_ms":9500,"latest_event_ms":9500}
                  {"table":"hyperliquid_raw","latest_ingest_ms":9400,"latest_event_ms":9400}
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
      assertEquals(true, readySignals.last().tableFreshnessReady)
      assertEquals(500, readySignals.last().tableIngestLagMs["hyperliquid_candles"])
      assertEquals(500, readySignals.last().tableEventLagMs["hyperliquid_candles"])
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `marks clickhouse ready when candle event time is ahead of observed clock`() =
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
                  {"table":"hyperliquid_candles","latest_ingest_ms":9900,"latest_event_ms":12000}
                  {"table":"hyperliquid_raw","latest_ingest_ms":9900,"latest_event_ms":9900}
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
      assertEquals(true, readySignals.last().tableFreshnessReady)
      assertEquals(-2_000, readySignals.last().tableEventLagMs["hyperliquid_candles"])
      assertEquals(2_000, readySignals.last().tableEventFutureSkewMs["hyperliquid_candles"])
      job.cancelAndJoin()
      client.close()
    }

  @Test
  fun `skips clickhouse writes for disabled tables`() =
    runBlocking {
      val observedQueries = mutableListOf<String>()
      val readySignals = mutableListOf<ClickHouseReadinessUpdate>()
      val client =
        HttpClient(
          MockEngine { request ->
            observedQueries += queryParam(request.url)
            respond(content = "", status = HttpStatusCode.OK)
          },
        )
      val sink =
        ClickHouseSink(
          config =
            clickHouseConfig(
              readyMaxAgeMs = 1_000,
              enabledTables = setOf("hyperliquid_candles"),
              readyTables = setOf("hyperliquid_candles"),
            ),
          httpClient = client,
          metrics = HyperliquidMetrics(SimpleMeterRegistry()),
          json = Json,
          nowMs = { 10_000 },
          onReady = { readySignals += it },
        )
      val job = sink.start(this)

      sink.enqueue(rawRecord())

      delay(50)

      assertEquals(emptyList(), observedQueries)
      assertEquals(emptyList(), readySignals)
      job.cancelAndJoin()
      client.close()
    }

  private fun clickHouseConfig(readyMaxAgeMs: Long): ClickHouseConfig =
    clickHouseConfig(
      readyMaxAgeMs = readyMaxAgeMs,
      batchSize = 1,
      flushMs = 1,
      requestTimeoutMs = 1_000,
    )

  private fun clickHouseConfig(
    readyMaxAgeMs: Long,
    batchSize: Int = 1,
    flushMs: Long = 1,
    requestTimeoutMs: Long = 1_000,
    enabledTables: Set<String> = setOf("hyperliquid_raw", "hyperliquid_candles"),
    readyTables: Set<String> = setOf("hyperliquid_raw", "hyperliquid_candles"),
  ): ClickHouseConfig =
    ClickHouseConfig(
      enabled = true,
      requiredForReadiness = true,
      httpUrl = "http://clickhouse.local:8123",
      database = "torghut",
      username = "torghut",
      password = "",
      batchSize = batchSize,
      flushMs = flushMs,
      requestTimeoutMs = requestTimeoutMs,
      readyMaxAgeMs = readyMaxAgeMs,
      failureHoldMs = 1_000,
      enabledTables = enabledTables,
      readyTables = readyTables,
      freshnessCheckMs = 1,
    )

  private fun queryParam(url: Url): String = url.parameters["query"] ?: ""

  private fun candleRecord(seq: Long = 1): RoutedEnvelope =
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
          seq = seq,
          source = "ws",
          payload =
            buildJsonObject {
              put("i", "1m")
              put("c", "100")
            },
        ),
    )

  private fun rawRecord(): RoutedEnvelope =
    RoutedEnvelope(
      topic = "torghut.hyperliquid.raw.v1",
      key = "raw",
      envelope =
        HyperliquidEnvelope(
          ingestTs = "2026-06-18T04:00:00Z",
          eventTs = "2026-06-18T04:00:00Z",
          network = "mainnet",
          feed = "hyperliquid-mainnet",
          channel = "raw",
          symbol = "hyperliquid",
          marketType = null,
          marketId = null,
          dex = null,
          coin = null,
          spotIndex = null,
          seq = 1,
          source = "ws",
          payload = buildJsonObject { put("channel", "raw") },
        ),
    )
}
