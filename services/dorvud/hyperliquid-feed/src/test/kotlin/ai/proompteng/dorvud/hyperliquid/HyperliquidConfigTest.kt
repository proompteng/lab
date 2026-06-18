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
          "CLICKHOUSE_FAILURE_HOLD_MS" to "45000",
          "HYPERLIQUID_READY_REQUIRED_CHANNELS" to "raw,candle",
          "HYPERLIQUID_READY_EVENT_MAX_AGE_MS" to "120000",
        ),
      )

    assertEquals(90_000, config.clickHouse.readyMaxAgeMs)
    assertEquals(45_000, config.clickHouse.failureHoldMs)
    assertEquals(setOf("raw", "candle"), config.readyRequiredChannels)
    assertEquals(120_000, config.readyEventMaxAgeMs)
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
}
