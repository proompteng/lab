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
    assertEquals(null, cfg.jangarSymbolsUrl)
    assertEquals(30_000, cfg.symbolsPollIntervalMs)
    assertEquals(200, cfg.subscribeBatchSize)
    assertEquals(1, cfg.shardCount)
    assertEquals(0, cfg.shardIndex)
    assertEquals("wss://stream.data.alpaca.markets", cfg.alpacaStreamUrl)
    assertEquals("localhost:9093", cfg.kafka.bootstrapServers)
    assertFalse(cfg.enableTradeUpdates)
    assertEquals("torghut.trades.v1", cfg.topics.trades)
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
    System.setProperty("user.dir", tmpDir.absolutePath)

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

  @Test
  fun `prefers env local over env`() {
    val tmpDir = Files.createTempDirectory("ws-dotenv-test").toFile()
    val envFile = File(tmpDir, ".env")
    envFile.writeText(
      """
      ALPACA_KEY_ID=from-env
      ALPACA_SECRET_KEY=secret-env
      SYMBOLS=ENVONLY
      """.trimIndent(),
    )
    val envLocalFile = File(tmpDir, ".env.local")
    envLocalFile.writeText(
      """
      ALPACA_KEY_ID=from-local
      ALPACA_SECRET_KEY=secret-local
      SYMBOLS=LOCAL1,LOCAL2
      """.trimIndent(),
    )

    val originalDotenvPath = System.getProperty("dotenv.path")
    val originalUserDir = System.getProperty("user.dir")
    System.setProperty("user.dir", tmpDir.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-local", cfg.alpacaKeyId)
      assertEquals(listOf("LOCAL1", "LOCAL2"), cfg.symbols)
    } finally {
      System.setProperty("user.dir", originalUserDir)
      if (originalDotenvPath != null) {
        System.setProperty("dotenv.path", originalDotenvPath)
      } else {
        System.clearProperty("dotenv.path")
      }
      envLocalFile.delete()
      envFile.delete()
      tmpDir.delete()
    }
  }

  @Test
  fun `loads dotenv from module subdir when run at repo root`() {
    val rootDir = Files.createTempDirectory("ws-root-test").toFile()
    val moduleDir = File(rootDir, "services/dorvud/websockets")
    moduleDir.mkdirs()
    val envLocal = File(moduleDir, ".env.local")
    envLocal.writeText(
      """
      ALPACA_KEY_ID=from-subdir
      ALPACA_SECRET_KEY=subdir-secret
      SYMBOLS=FAKEPACA
      KAFKA_BOOTSTRAP=localhost:19092
      """.trimIndent(),
    )

    val originalUserDir = System.getProperty("user.dir")
    System.setProperty("user.dir", rootDir.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-subdir", cfg.alpacaKeyId)
      assertEquals("localhost:19092", cfg.kafka.bootstrapServers)
      assertEquals(listOf("FAKEPACA"), cfg.symbols)
    } finally {
      System.setProperty("user.dir", originalUserDir)
      envLocal.delete()
      moduleDir.delete()
      File(rootDir, "services/dorvud").delete()
      File(rootDir, "services").delete()
      rootDir.delete()
    }
  }

  @Test
  fun `loads plain env file when dotenv parse returns empty`() {
    val tmpDir = Files.createTempDirectory("ws-plain-env").toFile()
    val envFile = File(tmpDir, "custom.env")
    envFile.writeText(
      """
      ALPACA_KEY_ID=plain-id
      ALPACA_SECRET_KEY=plain-secret
      SYMBOLS=PLAIN
      """.trimIndent(),
    )

    val originalDotenvPath = System.getProperty("dotenv.path")
    val originalUserDir = System.getProperty("user.dir")
    System.setProperty("dotenv.path", envFile.absolutePath)
    System.setProperty("user.dir", tmpDir.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("plain-id", cfg.alpacaKeyId)
      assertEquals(listOf("PLAIN"), cfg.symbols)
    } finally {
      if (originalDotenvPath != null) {
        System.setProperty("dotenv.path", originalDotenvPath)
      } else {
        System.clearProperty("dotenv.path")
      }
      envFile.delete()
      tmpDir.delete()
      if (originalUserDir != null) {
        System.setProperty("user.dir", originalUserDir)
      } else {
        System.clearProperty("user.dir")
      }
    }
  }

  @Test
  fun `dotenv path overrides files under user dir`() {
    val rootDir = Files.createTempDirectory("ws-root-test").toFile()
    val userEnvLocal = File(rootDir, ".env.local")
    userEnvLocal.writeText(
      """
      ALPACA_KEY_ID=from-userdir
      ALPACA_SECRET_KEY=userdir-secret
      SYMBOLS=USERDIR
      """.trimIndent(),
    )

    val explicitFile = File(rootDir, "custom.env")
    explicitFile.writeText(
      """
      ALPACA_KEY_ID=from-explicit
      ALPACA_SECRET_KEY=explicit-secret
      SYMBOLS=EXPLICIT
      """.trimIndent(),
    )

    val originalUserDir = System.getProperty("user.dir")
    val originalDotenvPath = System.getProperty("dotenv.path")
    System.setProperty("user.dir", rootDir.absolutePath)
    System.setProperty("dotenv.path", explicitFile.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-explicit", cfg.alpacaKeyId)
      assertEquals(listOf("EXPLICIT"), cfg.symbols)
    } finally {
      if (originalUserDir != null) System.setProperty("user.dir", originalUserDir) else System.clearProperty("user.dir")
      if (originalDotenvPath != null) System.setProperty("dotenv.path", originalDotenvPath) else System.clearProperty("dotenv.path")
      userEnvLocal.delete()
      explicitFile.delete()
      rootDir.delete()
    }
  }
}
