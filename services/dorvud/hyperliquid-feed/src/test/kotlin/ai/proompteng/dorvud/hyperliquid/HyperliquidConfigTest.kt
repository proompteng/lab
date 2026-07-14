package ai.proompteng.dorvud.hyperliquid

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HyperliquidConfigTest {
  @Test
  fun `defaults to mainnet public market feed without user scope`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_PASSWORD" to "secret",
        ),
      )

    assertEquals("mainnet", config.network)
    assertEquals("https://api.hyperliquid.xyz/info", config.infoUrl)
    assertEquals("wss://api.hyperliquid.xyz/ws", config.wsUrl)
    assertTrue(config.includePerps)
    assertTrue(config.includeSpot)
    assertEquals(100, config.topMarketCount)
    assertEquals(180_000, config.wsReadIdleTimeoutMs)
    assertFalse(config.wsChannels.any { it.startsWith("user", ignoreCase = true) })
  }

  @Test
  fun `accepts top volume market coverage with explicit count`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "HYPERLIQUID_MARKET_COVERAGE" to "top-volume",
          "HYPERLIQUID_TOP_MARKET_COUNT" to "250",
        ),
      )

    assertEquals("top-volume", config.marketCoverage)
    assertEquals(250, config.topMarketCount)
  }

  @Test
  fun `accepts clickhouse readiness freshness thresholds`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_READY_MAX_AGE_MS" to "90000",
          "CLICKHOUSE_TABLE_READY_MAX_AGE_MS" to "300000",
          "CLICKHOUSE_FAILURE_HOLD_MS" to "45000",
          "CLICKHOUSE_REQUEST_TIMEOUT_MS" to "7000",
          "CLICKHOUSE_REQUIRED_FOR_READINESS" to "false",
          "CLICKHOUSE_ENABLED_TABLES" to "hyperliquid_raw,hyperliquid_candles,hyperliquid_bbo",
          "CLICKHOUSE_READY_TABLES" to "hyperliquid_raw,hyperliquid_candles,hyperliquid_bbo",
          "CLICKHOUSE_FRESHNESS_CHECK_MS" to "5000",
          "CLICKHOUSE_QUEUE_CAPACITY" to "12000",
          "CLICKHOUSE_RETRY_INITIAL_MS" to "100",
          "CLICKHOUSE_RETRY_MAX_MS" to "2000",
          "CLICKHOUSE_SHUTDOWN_FLUSH_TIMEOUT_MS" to "15000",
          "HYPERLIQUID_READY_REQUIRED_CHANNELS" to "raw,candle",
          "HYPERLIQUID_READY_EVENT_MAX_AGE_MS" to "120000",
          "HYPERLIQUID_WS_READ_IDLE_TIMEOUT_MS" to "240000",
          "KAFKA_READY_MAX_AGE_MS" to "180000",
        ),
      )

    assertEquals(90_000, config.clickHouse.readyMaxAgeMs)
    assertEquals(300_000, config.clickHouse.tableReadyMaxAgeMs)
    assertEquals(45_000, config.clickHouse.failureHoldMs)
    assertEquals(7_000, config.clickHouse.requestTimeoutMs)
    assertFalse(config.clickHouse.requiredForReadiness)
    assertEquals(setOf("hyperliquid_raw", "hyperliquid_candles", "hyperliquid_bbo"), config.clickHouse.enabledTables)
    assertEquals(setOf("hyperliquid_raw", "hyperliquid_candles", "hyperliquid_bbo"), config.clickHouse.readyTables)
    assertEquals(5_000, config.clickHouse.freshnessCheckMs)
    assertEquals(12_000, config.clickHouse.queueCapacity)
    assertEquals(100, config.clickHouse.retryInitialMs)
    assertEquals(2_000, config.clickHouse.retryMaxMs)
    assertEquals(15_000, config.clickHouse.shutdownFlushTimeoutMs)
    assertEquals(setOf("raw", "candle"), config.readyRequiredChannels)
    assertEquals(120_000, config.readyEventMaxAgeMs)
    assertEquals(240_000, config.wsReadIdleTimeoutMs)
    assertEquals(180_000, config.kafkaReadyMaxAgeMs)
  }

  @Test
  fun `websocket read idle timeout cannot be shorter than two heartbeats`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "HYPERLIQUID_HEARTBEAT_INTERVAL_MS" to "30000",
          "HYPERLIQUID_WS_READ_IDLE_TIMEOUT_MS" to "45000",
        ),
      )

    assertEquals(60_000, config.wsReadIdleTimeoutMs)
  }

  @Test
  fun `defaults clickhouse table freshness to a wider catchup window`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_PASSWORD" to "secret",
        ),
      )

    assertEquals(120_000, config.clickHouse.readyMaxAgeMs)
    assertEquals(300_000, config.clickHouse.tableReadyMaxAgeMs)
  }

  @Test
  fun `builds independent clickhouse batch policies`() {
    val config =
      HyperliquidConfig.fromEnv(
        mapOf(
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_BBO_BATCH_SIZE" to "1200",
          "CLICKHOUSE_BBO_FLUSH_MS" to "9000",
          "CLICKHOUSE_SPARSE_BATCH_SIZE" to "80",
          "CLICKHOUSE_SPARSE_FLUSH_MS" to "25000",
        ),
      )

    assertEquals(ClickHouseBatchPolicy(1_200, 9_000), config.clickHouse.batchPolicyFor("hyperliquid_bbo"))
    assertEquals(ClickHouseBatchPolicy(80, 25_000), config.clickHouse.batchPolicyFor("hyperliquid_candles"))
    assertEquals(ClickHouseBatchPolicy(80, 25_000), config.clickHouse.batchPolicyFor("hyperliquid_status"))
    assertEquals(
      ClickHouseBatchPolicy(config.clickHouse.batchSize, config.clickHouse.flushMs),
      config.clickHouse.batchPolicyFor("hyperliquid_raw"),
    )
  }

  @Test
  fun `rejects invalid top market count`() {
    val error =
      assertFailsWith<IllegalStateException> {
        HyperliquidConfig.fromEnv(
          mapOf(
            "KAFKA_SASL_PASSWORD" to "secret",
            "HYPERLIQUID_MARKET_COVERAGE" to "top-volume",
            "HYPERLIQUID_TOP_MARKET_COUNT" to "0",
          ),
        )
      }

    assertTrue(error.message.orEmpty().contains("HYPERLIQUID_TOP_MARKET_COUNT"))
  }

  @Test
  fun `rejects websocket limits above documented headroom`() {
    val error =
      assertFailsWith<IllegalStateException> {
        HyperliquidConfig.fromEnv(
          mapOf(
            "KAFKA_SASL_PASSWORD" to "secret",
            "HYPERLIQUID_MAX_WS_CONNECTIONS" to "10",
          ),
        )
      }

    assertTrue(error.message.orEmpty().contains("HYPERLIQUID_MAX_WS_CONNECTIONS"))
  }

  @Test
  fun `rejects user-specific websocket channel names`() {
    val error =
      assertFailsWith<IllegalStateException> {
        HyperliquidConfig.fromEnv(
          mapOf(
            "KAFKA_SASL_PASSWORD" to "secret",
            "HYPERLIQUID_WS_CHANNELS" to "trades,userFills",
          ),
        )
      }

    assertTrue(error.message.orEmpty().contains("Unsupported HYPERLIQUID_WS_CHANNELS"))
  }

  @Test
  fun `rejects unknown readiness channels`() {
    val error =
      assertFailsWith<IllegalStateException> {
        HyperliquidConfig.fromEnv(
          mapOf(
            "KAFKA_SASL_PASSWORD" to "secret",
            "HYPERLIQUID_READY_REQUIRED_CHANNELS" to "raw,userFills",
          ),
        )
      }

    assertTrue(error.message.orEmpty().contains("Unsupported HYPERLIQUID_READY_REQUIRED_CHANNELS"))
  }

  @Test
  fun `rejects unknown clickhouse readiness tables`() {
    val error =
      assertFailsWith<IllegalStateException> {
        HyperliquidConfig.fromEnv(
          mapOf(
            "KAFKA_SASL_PASSWORD" to "secret",
            "CLICKHOUSE_READY_TABLES" to "hyperliquid_raw,system_tables",
          ),
        )
      }

    assertTrue(error.message.orEmpty().contains("Unsupported CLICKHOUSE_READY_TABLES"))
  }

  @Test
  fun `rejects readiness tables disabled for clickhouse writes`() {
    val error =
      assertFailsWith<IllegalStateException> {
        HyperliquidConfig.fromEnv(
          mapOf(
            "KAFKA_SASL_PASSWORD" to "secret",
            "CLICKHOUSE_ENABLED_TABLES" to "hyperliquid_candles",
            "CLICKHOUSE_READY_TABLES" to "hyperliquid_raw,hyperliquid_candles",
          ),
        )
      }

    assertTrue(error.message.orEmpty().contains("CLICKHOUSE_READY_TABLES must be included in CLICKHOUSE_ENABLED_TABLES"))
  }
}
