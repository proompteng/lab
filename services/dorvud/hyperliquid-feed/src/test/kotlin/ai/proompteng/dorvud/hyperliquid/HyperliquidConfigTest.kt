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
    assertFalse(config.wsChannels.any { it.startsWith("user", ignoreCase = true) })
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
}
