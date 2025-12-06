package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import java.io.File
import java.nio.file.Files

class ForwarderConfigTest {
  @Test
  fun `loads defaults when optional envs missing`() {
    val cfg = ForwarderConfig.fromEnv(
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
      ),
    )

    assertEquals(listOf("NVDA"), cfg.symbols)
    assertEquals("wss://stream.data.alpaca.markets", cfg.alpacaStreamUrl)
    assertFalse(cfg.enableTradeUpdates)
    assertEquals("torghut.nvda.trades.v1", cfg.topics.trades)
  }

  @Test
  fun `allows overriding stream url`() {
    val cfg = ForwarderConfig.fromEnv(
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
        "ALPACA_STREAM_URL" to "wss://stream.data.sandbox.alpaca.markets",
      ),
    )

    assertEquals("wss://stream.data.sandbox.alpaca.markets", cfg.alpacaStreamUrl)
  }

  @Test
  fun `loads values from dotenv when present`() {
    val tmpDir = Files.createTempDirectory("ws-dotenv-test").toFile()
    val envFile = File(tmpDir, ".env")
    envFile.writeText(
      """
      ALPACA_KEY_ID=from-dotenv
      ALPACA_SECRET_KEY=secret
      ALPACA_STREAM_URL=wss://example.test
      SYMBOLS=MSFT,SPY
      """.trimIndent(),
    )

    val originalUserDir = System.getProperty("user.dir")
    val originalDotenvPath = System.getProperty("dotenv.path")
    System.setProperty("dotenv.path", envFile.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-dotenv", cfg.alpacaKeyId)
      assertEquals("wss://example.test", cfg.alpacaStreamUrl)
      assertEquals(listOf("MSFT", "SPY"), cfg.symbols)
    } finally {
      System.setProperty("user.dir", originalUserDir)
      if (originalDotenvPath != null) {
        System.setProperty("dotenv.path", originalDotenvPath)
      } else {
        System.clearProperty("dotenv.path")
      }
      envFile.delete()
      tmpDir.delete()
    }
  }
}
