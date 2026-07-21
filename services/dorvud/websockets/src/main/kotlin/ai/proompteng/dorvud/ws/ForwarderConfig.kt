package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.KafkaTls
import io.github.cdimascio.dotenv.dotenv
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.LocalDate
import java.util.Properties

data class TopicConfig(
  val trades: String,
  val quotes: String,
  val bars1m: String?,
  val status: String,
  val tradeUpdates: String?,
  val tradeUpdatesV2: String?,
)

data class MarketDataUniverseContract(
  val id: String,
  val symbolHash: String,
  val symbols: List<String>,
)

internal fun canonicalSymbolHash(symbols: Collection<String>): String =
  MessageDigest
    .getInstance("SHA-256")
    .digest(symbols.joinToString(",").toByteArray(StandardCharsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

enum class AlpacaMarketType {
  EQUITY,
  CRYPTO,
  OPTIONS,
}

internal fun defaultAlpacaMarketDataChannels(marketType: AlpacaMarketType): List<String> =
  when (marketType) {
    AlpacaMarketType.EQUITY -> listOf("trades", "quotes", "bars", "updatedBars")
    AlpacaMarketType.CRYPTO -> listOf("trades", "quotes", "bars")
    AlpacaMarketType.OPTIONS -> listOf("trades", "quotes")
  }

data class ForwarderConfig(
  val alpacaKeyId: String,
  val alpacaSecretKey: String,
  val alpacaMarketType: AlpacaMarketType,
  val alpacaCryptoLocation: String,
  val alpacaFeed: String,
  val alpacaStreamUrl: String,
  val alpacaBaseUrl: String,
  val alpacaTradeStreamUrl: String?,
  val alpacaMarketDataChannels: List<String>,
  val optionsMarketHolidays: Set<LocalDate> = emptySet(),
  val jangarSymbolsUrl: String?,
  val staticSymbols: List<String>,
  val symbolAllowlist: Set<String>,
  val universeContract: MarketDataUniverseContract? = null,
  val symbolsPollIntervalMs: Long,
  val subscribeBatchSize: Int,
  val shardCount: Int,
  val shardIndex: Int,
  val enableTradeUpdates: Boolean,
  val torghutAccountLabel: String?,
  val enableBarsBackfill: Boolean,
  val barsBackfillLookbackHours: Long,
  val enableTradesBackfill: Boolean = false,
  val tradesBackfillLookbackHours: Long = 24,
  val tradesBackfillMaxRecords: Int = 50_000,
  val reconnectBaseMs: Long,
  val reconnectMaxMs: Long,
  val dedupTtlSeconds: Long,
  val dedupMaxEntries: Int,
  val kafka: KafkaProducerSettings,
  val topics: TopicConfig,
  val healthPort: Int = 8080,
  val metricsPort: Int = 9090,
  val healthNotReadyKillAfterMs: Long = 180_000,
  val marketDataChannelFreshnessMaxMs: Long = 180_000,
  val marketDataChannelFreshnessWarmupMs: Long = 120_000,
  val marketDataReadIdleTimeoutMs: Long = 180_000,
) {
  companion object {
    fun fromEnv(env: Map<String, String>? = null): ForwarderConfig {
      val mergedEnv = env ?: mergeEnv()

      val shardCount = mergedEnv["SHARD_COUNT"]?.toIntOrNull() ?: 1
      val shardIndex = mergedEnv["SHARD_INDEX"]?.toIntOrNull() ?: 0
      if (shardCount <= 0) error("SHARD_COUNT must be > 0")
      if (shardIndex < 0 || shardIndex >= shardCount) error("SHARD_INDEX must be within [0, SHARD_COUNT)")

      val symbolsPollIntervalMs = mergedEnv["SYMBOLS_POLL_INTERVAL_MS"]?.toLongOrNull() ?: 30_000
      val subscribeBatchSize = mergedEnv["SUBSCRIBE_BATCH_SIZE"]?.toIntOrNull() ?: 200
      if (symbolsPollIntervalMs <= 0) error("SYMBOLS_POLL_INTERVAL_MS must be > 0")
      if (subscribeBatchSize <= 0) error("SUBSCRIBE_BATCH_SIZE must be > 0")

      val configuredAllowlistSymbols =
        mergedEnv["SYMBOLS_ALLOWLIST"]
          ?.split(",")
          ?.map { it.trim().uppercase() }
          ?.filter { it.isNotEmpty() }
          ?: emptyList()
      val symbolAllowlist = configuredAllowlistSymbols.toSet()
      if (symbolAllowlist.size > 12) error("SYMBOLS_ALLOWLIST must include no more than 12 symbols")
      val configuredStaticSymbols =
        mergedEnv["SYMBOLS"]
          ?.split(",")
          ?.map { it.trim() }
          ?.filter { it.isNotEmpty() }
          ?: emptyList()
      val staticSymbols =
        if (symbolAllowlist.isEmpty()) {
          configuredStaticSymbols
        } else {
          configuredStaticSymbols.filter { it.trim().uppercase() in symbolAllowlist }
        }
      val alpacaMarketType =
        when (mergedEnv["ALPACA_MARKET_TYPE"]?.trim()?.lowercase() ?: "equity") {
          "equity" -> AlpacaMarketType.EQUITY
          "crypto" -> AlpacaMarketType.CRYPTO
          "options" -> AlpacaMarketType.OPTIONS
          else -> error("ALPACA_MARKET_TYPE must be one of: equity, crypto, options")
        }
      val alpacaCryptoLocation = mergedEnv["ALPACA_CRYPTO_LOCATION"]?.trim()?.lowercase() ?: "us"
      if (
        alpacaMarketType == AlpacaMarketType.CRYPTO &&
        alpacaCryptoLocation !in setOf("us", "us-1", "eu-1")
      ) {
        error("ALPACA_CRYPTO_LOCATION must be one of: us, us-1, eu-1 when ALPACA_MARKET_TYPE=crypto")
      }
      val allowedChannels =
        when (alpacaMarketType) {
          AlpacaMarketType.EQUITY -> listOf("trades", "quotes", "bars", "updatedBars")
          AlpacaMarketType.CRYPTO -> listOf("trades", "quotes", "bars")
          AlpacaMarketType.OPTIONS -> listOf("trades", "quotes")
        }
      val allowedByLower = allowedChannels.associateBy { it.lowercase() }
      val channelOverride =
        mergedEnv["ALPACA_MARKET_DATA_CHANNELS"]?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }
      val alpacaMarketDataChannels =
        when {
          channelOverride == null -> defaultAlpacaMarketDataChannels(alpacaMarketType)
          channelOverride.isEmpty() -> error("ALPACA_MARKET_DATA_CHANNELS must include at least one channel")
          else -> channelOverride.map { raw -> allowedByLower[raw.lowercase()] ?: raw }.distinct()
        }
      val unknownChannels = alpacaMarketDataChannels.filterNot { it in allowedChannels }
      if (unknownChannels.isNotEmpty()) {
        val allowed = allowedChannels.sorted().joinToString(",")
        error(
          "ALPACA_MARKET_DATA_CHANNELS contains unsupported channel(s): ${unknownChannels.joinToString(",")} " +
            "for market type ${alpacaMarketType.name.lowercase()} (allowed: $allowed)",
        )
      }
      val optionsMarketHolidays = parseIsoDateSet(mergedEnv["OPTIONS_MARKET_HOLIDAYS"])

      val jangarSymbolsUrl =
        mergedEnv["JANGAR_SYMBOLS_URL"]?.trim()?.takeIf { it.isNotEmpty() }

      if (jangarSymbolsUrl == null && staticSymbols.isEmpty()) {
        error("JANGAR_SYMBOLS_URL or SYMBOLS must be set")
      }

      val universeId = mergedEnv["MARKET_DATA_UNIVERSE_ID"]?.trim()?.takeIf { it.isNotEmpty() }
      val universeSymbolHash =
        mergedEnv["MARKET_DATA_UNIVERSE_SYMBOL_HASH"]
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
      if ((universeId == null) != (universeSymbolHash == null)) {
        error("MARKET_DATA_UNIVERSE_ID and MARKET_DATA_UNIVERSE_SYMBOL_HASH must be set together")
      }
      val universeContract =
        universeId?.let { id ->
          val expectedHash = requireNotNull(universeSymbolHash)
          if (!id.matches(Regex("^[a-z0-9]+(?:[.-][a-z0-9]+)*$"))) {
            error("MARKET_DATA_UNIVERSE_ID must be a versioned lowercase identifier")
          }
          if (!expectedHash.matches(Regex("^[0-9a-f]{64}$"))) {
            error("MARKET_DATA_UNIVERSE_SYMBOL_HASH must be a lowercase SHA-256 hash")
          }
          if (jangarSymbolsUrl != null) {
            error("a versioned market-data universe cannot use JANGAR_SYMBOLS_URL")
          }
          val configuredSymbols =
            configuredStaticSymbols.map { it.trim().uppercase() }.filter { it.isNotEmpty() }
          val canonicalSymbols =
            configuredSymbols.distinct().sorted()
          if (configuredSymbols != canonicalSymbols) {
            error("SYMBOLS must be unique and canonically sorted for a versioned market-data universe")
          }
          if (configuredAllowlistSymbols != canonicalSymbols) {
            error("SYMBOLS_ALLOWLIST must exactly match SYMBOLS for a versioned market-data universe")
          }
          val actualHash = canonicalSymbolHash(canonicalSymbols)
          if (expectedHash != actualHash) {
            error("MARKET_DATA_UNIVERSE_SYMBOL_HASH does not match canonical SYMBOLS")
          }
          MarketDataUniverseContract(id = id, symbolHash = actualHash, symbols = canonicalSymbols)
        }

      val topics =
        TopicConfig(
          trades = mergedEnv["TOPIC_TRADES"] ?: "torghut.trades.v1",
          quotes = mergedEnv["TOPIC_QUOTES"] ?: "torghut.quotes.v1",
          bars1m =
            mergedEnv["TOPIC_BARS_1M"]?.trim()?.takeIf { it.isNotEmpty() }
              ?: if (alpacaMarketType == AlpacaMarketType.OPTIONS) null else "torghut.bars.1m.v1",
          status = mergedEnv["TOPIC_STATUS"] ?: "torghut.status.v1",
          tradeUpdates = mergedEnv["TOPIC_TRADE_UPDATES"],
          tradeUpdatesV2 = mergedEnv["TOPIC_TRADE_UPDATES_V2"],
        )
      val enableBarsBackfill = mergedEnv["ENABLE_BARS_BACKFILL"]?.toBooleanStrictOrNull() ?: false
      if (alpacaMarketType == AlpacaMarketType.OPTIONS && enableBarsBackfill) {
        error("ENABLE_BARS_BACKFILL is not supported when ALPACA_MARKET_TYPE=options")
      }
      if (enableBarsBackfill && topics.bars1m == null) {
        error("TOPIC_BARS_1M must be set when ENABLE_BARS_BACKFILL=true")
      }
      val barsBackfillLookbackHours =
        mergedEnv["BARS_BACKFILL_LOOKBACK_HOURS"]?.toLongOrNull() ?: 12L
      if (barsBackfillLookbackHours <= 0) {
        error("BARS_BACKFILL_LOOKBACK_HOURS must be > 0")
      }
      val enableTradesBackfill = mergedEnv["ENABLE_TRADES_BACKFILL"]?.toBooleanStrictOrNull() ?: false
      if (enableTradesBackfill && alpacaMarketType != AlpacaMarketType.EQUITY) {
        error("ENABLE_TRADES_BACKFILL is only supported when ALPACA_MARKET_TYPE=equity")
      }
      val tradesBackfillLookbackHours =
        mergedEnv["TRADES_BACKFILL_LOOKBACK_HOURS"]?.toLongOrNull() ?: 24L
      if (tradesBackfillLookbackHours <= 0) {
        error("TRADES_BACKFILL_LOOKBACK_HOURS must be > 0")
      }
      val tradesBackfillMaxRecords =
        mergedEnv["TRADES_BACKFILL_MAX_RECORDS"]?.toIntOrNull() ?: 50_000
      if (tradesBackfillMaxRecords <= 0) {
        error("TRADES_BACKFILL_MAX_RECORDS must be > 0")
      }

      val kafka =
        KafkaProducerSettings(
          bootstrapServers = mergedEnv["KAFKA_BOOTSTRAP"] ?: "localhost:9093",
          clientId = mergedEnv["KAFKA_CLIENT_ID"] ?: "dorvud-ws",
          lingerMs = mergedEnv["KAFKA_LINGER_MS"]?.toIntOrNull() ?: 30,
          batchSize = mergedEnv["KAFKA_BATCH_SIZE"]?.toIntOrNull() ?: 32768,
          bufferMemoryBytes = mergedEnv["KAFKA_BUFFER_MEMORY_BYTES"]?.toLongOrNull() ?: (16L * 1024 * 1024),
          maxRequestSizeBytes = mergedEnv["KAFKA_MAX_REQUEST_SIZE_BYTES"]?.toIntOrNull() ?: (512 * 1024),
          deliveryTimeoutMs = mergedEnv["KAFKA_DELIVERY_TIMEOUT_MS"]?.toIntOrNull() ?: 60_000,
          requestTimeoutMs = mergedEnv["KAFKA_REQUEST_TIMEOUT_MS"]?.toIntOrNull() ?: 15_000,
          maxBlockMs = mergedEnv["KAFKA_MAX_BLOCK_MS"]?.toLongOrNull() ?: 10_000,
          acks = mergedEnv["KAFKA_ACKS"] ?: "all",
          compressionType = mergedEnv["KAFKA_COMPRESSION"] ?: "lz4",
          securityProtocol = mergedEnv["KAFKA_SECURITY_PROTOCOL"] ?: "SASL_SSL",
          auth =
            KafkaAuth(
              username = mergedEnv["KAFKA_SASL_USER"] ?: "dorvud-ws",
              password = mergedEnv["KAFKA_SASL_PASSWORD"] ?: "changeme",
              mechanism = mergedEnv["KAFKA_SASL_MECH"] ?: "SCRAM-SHA-512",
            ),
          tls =
            KafkaTls(
              truststorePath = mergedEnv["KAFKA_TRUSTSTORE_PATH"],
              truststorePassword = mergedEnv["KAFKA_TRUSTSTORE_PASSWORD"],
              endpointIdentification = mergedEnv["KAFKA_SSL_ENDPOINT_IDENTIFICATION"] ?: "HTTPS",
            ),
        )
      if (kafka.bufferMemoryBytes <= 0) error("KAFKA_BUFFER_MEMORY_BYTES must be > 0")
      if (kafka.maxRequestSizeBytes <= 0) error("KAFKA_MAX_REQUEST_SIZE_BYTES must be > 0")
      if (kafka.deliveryTimeoutMs <= 0) error("KAFKA_DELIVERY_TIMEOUT_MS must be > 0")
      if (kafka.requestTimeoutMs <= 0) error("KAFKA_REQUEST_TIMEOUT_MS must be > 0")
      if (kafka.maxBlockMs <= 0) error("KAFKA_MAX_BLOCK_MS must be > 0")

      val healthNotReadyKillAfterMs = mergedEnv["HEALTH_NOT_READY_KILL_AFTER_MS"]?.toLongOrNull() ?: 180_000
      if (healthNotReadyKillAfterMs <= 0) error("HEALTH_NOT_READY_KILL_AFTER_MS must be > 0")
      val marketDataChannelFreshnessMaxMs =
        mergedEnv["MARKET_DATA_CHANNEL_FRESHNESS_MAX_MS"]?.toLongOrNull() ?: 180_000
      if (marketDataChannelFreshnessMaxMs <= 0) error("MARKET_DATA_CHANNEL_FRESHNESS_MAX_MS must be > 0")
      val marketDataChannelFreshnessWarmupMs =
        mergedEnv["MARKET_DATA_CHANNEL_FRESHNESS_WARMUP_MS"]?.toLongOrNull() ?: 120_000
      if (marketDataChannelFreshnessWarmupMs < 0) error("MARKET_DATA_CHANNEL_FRESHNESS_WARMUP_MS must be >= 0")
      val marketDataReadIdleTimeoutMs =
        mergedEnv["ALPACA_MARKET_DATA_READ_IDLE_TIMEOUT_MS"]?.toLongOrNull()
          ?: marketDataChannelFreshnessMaxMs
      if (marketDataReadIdleTimeoutMs <= 0) error("ALPACA_MARKET_DATA_READ_IDLE_TIMEOUT_MS must be > 0")

      return ForwarderConfig(
        alpacaKeyId = mergedEnv.getValue("ALPACA_KEY_ID"),
        alpacaSecretKey = mergedEnv.getValue("ALPACA_SECRET_KEY"),
        alpacaMarketType = alpacaMarketType,
        alpacaCryptoLocation = alpacaCryptoLocation,
        alpacaFeed = mergedEnv["ALPACA_FEED"] ?: if (alpacaMarketType == AlpacaMarketType.OPTIONS) "opra" else "iex",
        alpacaStreamUrl = mergedEnv["ALPACA_STREAM_URL"] ?: "wss://stream.data.alpaca.markets",
        alpacaBaseUrl = mergedEnv["ALPACA_BASE_URL"] ?: "https://data.alpaca.markets",
        alpacaTradeStreamUrl = mergedEnv["ALPACA_TRADE_STREAM_URL"]?.trim()?.takeIf { it.isNotEmpty() },
        alpacaMarketDataChannels = alpacaMarketDataChannels,
        optionsMarketHolidays = optionsMarketHolidays,
        jangarSymbolsUrl = jangarSymbolsUrl,
        staticSymbols = staticSymbols,
        symbolAllowlist = symbolAllowlist,
        universeContract = universeContract,
        symbolsPollIntervalMs = symbolsPollIntervalMs,
        subscribeBatchSize = subscribeBatchSize,
        shardCount = shardCount,
        shardIndex = shardIndex,
        enableTradeUpdates = mergedEnv["ENABLE_TRADE_UPDATES"]?.toBooleanStrictOrNull() ?: false,
        torghutAccountLabel = mergedEnv["TORGHUT_ACCOUNT_LABEL"]?.trim()?.takeIf { it.isNotEmpty() },
        enableBarsBackfill = enableBarsBackfill,
        barsBackfillLookbackHours = barsBackfillLookbackHours,
        enableTradesBackfill = enableTradesBackfill,
        tradesBackfillLookbackHours = tradesBackfillLookbackHours,
        tradesBackfillMaxRecords = tradesBackfillMaxRecords.coerceAtMost(250_000),
        reconnectBaseMs = mergedEnv["RECONNECT_BASE_MS"]?.toLongOrNull() ?: 500,
        reconnectMaxMs = mergedEnv["RECONNECT_MAX_MS"]?.toLongOrNull() ?: 30_000,
        dedupTtlSeconds = mergedEnv["DEDUP_TTL_SEC"]?.toLongOrNull() ?: 5,
        dedupMaxEntries = mergedEnv["DEDUP_MAX_ENTRIES"]?.toIntOrNull() ?: 10_000,
        kafka = kafka,
        topics = topics,
        healthPort = mergedEnv["HEALTH_PORT"]?.toIntOrNull() ?: 8080,
        metricsPort = mergedEnv["METRICS_PORT"]?.toIntOrNull() ?: 9090,
        healthNotReadyKillAfterMs = healthNotReadyKillAfterMs,
        marketDataChannelFreshnessMaxMs = marketDataChannelFreshnessMaxMs,
        marketDataChannelFreshnessWarmupMs = marketDataChannelFreshnessWarmupMs,
        marketDataReadIdleTimeoutMs = marketDataReadIdleTimeoutMs.coerceAtLeast(30_000),
      )
    }

    private fun mergeEnv(): Map<String, String> {
      val dotEnvEntries = loadDotEnv()
      val merged = dotEnvEntries.toMutableMap()
      merged.putAll(System.getenv())
      return merged
    }

    private fun parseIsoDateSet(raw: String?): Set<LocalDate> {
      val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return emptySet()
      if (trimmed == "[]") return emptySet()
      return trimmed
        .trim('[', ']')
        .split(",", "\n", ";", " ")
        .map { it.trim().trim('"', '\'') }
        .filter { it.isNotEmpty() }
        .map { token ->
          runCatching { LocalDate.parse(token) }
            .getOrElse {
              error("OPTIONS_MARKET_HOLIDAYS must contain ISO-8601 dates (yyyy-MM-dd): $token")
            }
        }.toSet()
    }

    private fun loadDotEnv(): Map<String, String> {
      val customPath = System.getProperty("dotenv.path") ?: System.getenv("DOTENV_PATH")
      val mergeTarget = mutableMapOf<String, String>()

      fun mergeFrom(file: File) {
        if (!file.exists()) return
        val loaded = loadWithDotenv(file.parent ?: ".", file.name)
        if (loaded.isNotEmpty()) {
          mergeTarget.putAll(loaded)
        } else {
          mergeTarget.putAll(parsePlainEnvFile(file))
        }
      }

      // 1) Explicit path wins
      if (customPath != null) {
        mergeFrom(File(customPath))
        return mergeTarget
      }

      // 2) Standard locations (support running from repo root or module dir)
      val userDir = System.getProperty("user.dir") ?: "."
      val candidateDirs =
        listOf(
          File(userDir),
          File(userDir, "services/dorvud"),
          File(userDir, "services/dorvud/websockets"),
          File(userDir, "websockets"),
        ).distinct().filter { it.exists() }

      candidateDirs.forEach { dir ->
        mergeFrom(File(dir, ".env"))
        mergeFrom(File(dir, ".env.local")) // .env.local overrides within that dir
      }

      return mergeTarget
    }

    private fun loadWithDotenv(
      directory: String,
      filename: String,
    ): Map<String, String> {
      val entries =
        dotenv {
          ignoreIfMissing = true
          ignoreIfMalformed = true
          this.directory = directory
          this.filename = filename
        }.entries().associate { it.key to it.value }
      return entries
    }

    private fun parsePlainEnvFile(file: File): Map<String, String> {
      if (!file.exists()) return emptyMap()
      return file
        .readLines()
        .map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") }
        .mapNotNull { line ->
          val idx = line.indexOf('=')
          if (idx <= 0) return@mapNotNull null
          val key = line.substring(0, idx).trim()
          val value = line.substring(idx + 1).trim()
          key to value
        }.toMap()
    }
  }
}
