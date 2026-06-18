package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.KafkaTls
import io.github.cdimascio.dotenv.dotenv
import java.io.File

data class HyperliquidTopics(
  val raw: String,
  val markets: String,
  val trades: String,
  val booksL2: String,
  val bbo: String,
  val candles: String,
  val assetCtx: String,
  val funding: String,
  val status: String,
)

data class ClickHouseConfig(
  val enabled: Boolean,
  val requiredForReadiness: Boolean,
  val httpUrl: String,
  val database: String,
  val username: String,
  val password: String,
  val batchSize: Int,
  val flushMs: Long,
  val requestTimeoutMs: Long,
  val readyMaxAgeMs: Long,
  val failureHoldMs: Long,
  val enabledTables: Set<String>,
  val readyTables: Set<String> = setOf("hyperliquid_raw", "hyperliquid_candles"),
  val freshnessCheckMs: Long = 30_000,
)

data class HyperliquidConfig(
  val network: String,
  val infoUrl: String,
  val wsUrl: String,
  val includePerps: Boolean,
  val includeSpot: Boolean,
  val marketCoverage: String,
  val topMarketCount: Int,
  val canaryCoins: Set<String>,
  val candleIntervals: List<String>,
  val wsChannels: Set<String>,
  val maxWsConnections: Int,
  val maxSubscriptionsPerConnection: Int,
  val maxTotalSubscriptions: Int,
  val restWeightBudgetPerMinute: Int,
  val restMetadataRefreshMs: Long,
  val reconnectBaseMs: Long,
  val reconnectMaxMs: Long,
  val heartbeatIntervalMs: Long,
  val dedupTtlSeconds: Long,
  val dedupMaxEntries: Int,
  val readyRequiredChannels: Set<String>,
  val readyEventMaxAgeMs: Long,
  val healthPort: Int,
  val metricsPort: Int,
  val kafka: KafkaProducerSettings,
  val topics: HyperliquidTopics,
  val clickHouse: ClickHouseConfig,
) {
  companion object {
    private val supportedIntervals =
      setOf("1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M")
    private val supportedChannels = setOf("allMids", "trades", "l2Book", "bbo", "candle", "activeAssetCtx", "allDexsAssetCtxs")
    private val supportedClickHouseReadyTables =
      setOf(
        "hyperliquid_raw",
        "hyperliquid_trades",
        "hyperliquid_l2_books",
        "hyperliquid_bbo",
        "hyperliquid_candles",
        "hyperliquid_asset_contexts",
        "hyperliquid_funding",
        "hyperliquid_status",
      )
    private val supportedClickHouseTables =
      supportedClickHouseReadyTables + "hyperliquid_market_catalog"

    fun fromEnv(env: Map<String, String>? = null): HyperliquidConfig {
      val mergedEnv = env ?: mergeEnv()
      val network = mergedEnv["HYPERLIQUID_NETWORK"]?.trim()?.lowercase() ?: "mainnet"
      if (network !in setOf("mainnet", "testnet")) error("HYPERLIQUID_NETWORK must be mainnet or testnet")

      val defaultInfoUrl =
        if (network == "mainnet") {
          "https://api.hyperliquid.xyz/info"
        } else {
          "https://api.hyperliquid-testnet.xyz/info"
        }
      val defaultWsUrl =
        if (network == "mainnet") {
          "wss://api.hyperliquid.xyz/ws"
        } else {
          "wss://api.hyperliquid-testnet.xyz/ws"
        }

      val includePerps = mergedEnv["HYPERLIQUID_INCLUDE_PERPS"]?.toBooleanStrictOrNull() ?: true
      val includeSpot = mergedEnv["HYPERLIQUID_INCLUDE_SPOT"]?.toBooleanStrictOrNull() ?: true
      if (!includePerps && !includeSpot) error("At least one of HYPERLIQUID_INCLUDE_PERPS or HYPERLIQUID_INCLUDE_SPOT must be true")

      val marketCoverage = mergedEnv["HYPERLIQUID_MARKET_COVERAGE"]?.trim()?.lowercase() ?: "all"
      val supportedCoverage = setOf("all", "canary", "top-liquidity-canary", "top-volume", "top-volume-100")
      if (marketCoverage !in supportedCoverage) {
        error("HYPERLIQUID_MARKET_COVERAGE must be one of ${supportedCoverage.joinToString(",")}")
      }
      val topMarketCount = intEnv(mergedEnv, "HYPERLIQUID_TOP_MARKET_COUNT", 100)
      if (topMarketCount !in 1..1000) error("HYPERLIQUID_TOP_MARKET_COUNT must be within 1..1000")

      val candleIntervals =
        csv(mergedEnv["HYPERLIQUID_CANDLE_INTERVALS"] ?: "1m")
          .also { if (it.isEmpty()) error("HYPERLIQUID_CANDLE_INTERVALS must include at least one interval") }
          .also { intervals ->
            val unknown = intervals.filterNot { it in supportedIntervals }
            if (unknown.isNotEmpty()) error("Unsupported HYPERLIQUID_CANDLE_INTERVALS: ${unknown.joinToString(",")}")
          }

      val wsChannels =
        csv(mergedEnv["HYPERLIQUID_WS_CHANNELS"] ?: "allMids,trades,l2Book,bbo,candle,activeAssetCtx,allDexsAssetCtxs")
          .toSet()
          .also { channels ->
            if (channels.isEmpty()) error("HYPERLIQUID_WS_CHANNELS must include at least one channel")
            val unknown = channels.filterNot { it in supportedChannels }
            if (unknown.isNotEmpty()) error("Unsupported HYPERLIQUID_WS_CHANNELS: ${unknown.joinToString(",")}")
          }

      val readyRequiredChannels =
        csv(mergedEnv["HYPERLIQUID_READY_REQUIRED_CHANNELS"] ?: "raw,candle")
          .toSet()
          .also { channels ->
            val supportedReadinessChannels = supportedChannels + "raw"
            val unknown = channels.filterNot { it in supportedReadinessChannels }
            if (unknown.isNotEmpty()) error("Unsupported HYPERLIQUID_READY_REQUIRED_CHANNELS: ${unknown.joinToString(",")}")
          }
      val readyEventMaxAgeMs = longEnv(mergedEnv, "HYPERLIQUID_READY_EVENT_MAX_AGE_MS", 180_000).coerceAtLeast(30_000)

      val maxWsConnections = intEnv(mergedEnv, "HYPERLIQUID_MAX_WS_CONNECTIONS", 8)
      val maxSubscriptionsPerConnection = intEnv(mergedEnv, "HYPERLIQUID_MAX_SUBSCRIPTIONS_PER_CONNECTION", 125)
      val maxTotalSubscriptions = intEnv(mergedEnv, "HYPERLIQUID_MAX_TOTAL_SUBSCRIPTIONS", 1000)
      if (maxWsConnections !in 1..8) error("HYPERLIQUID_MAX_WS_CONNECTIONS must be within 1..8")
      if (maxSubscriptionsPerConnection !in 1..1000) {
        error("HYPERLIQUID_MAX_SUBSCRIPTIONS_PER_CONNECTION must be within 1..1000")
      }
      if (maxTotalSubscriptions !in 1..1000) error("HYPERLIQUID_MAX_TOTAL_SUBSCRIPTIONS must be within 1..1000")
      if (maxWsConnections * maxSubscriptionsPerConnection < maxTotalSubscriptions) {
        error("Websocket connection capacity must cover HYPERLIQUID_MAX_TOTAL_SUBSCRIPTIONS")
      }

      val restWeightBudgetPerMinute = intEnv(mergedEnv, "HYPERLIQUID_REST_WEIGHT_BUDGET_PER_MINUTE", 1000)
      if (restWeightBudgetPerMinute !in 1..1200) {
        error("HYPERLIQUID_REST_WEIGHT_BUDGET_PER_MINUTE must be within 1..1200")
      }

      val clickHouse =
        ClickHouseConfig(
          enabled = mergedEnv["CLICKHOUSE_ENABLED"]?.toBooleanStrictOrNull() ?: true,
          requiredForReadiness = mergedEnv["CLICKHOUSE_REQUIRED_FOR_READINESS"]?.toBooleanStrictOrNull() ?: true,
          httpUrl = mergedEnv["CLICKHOUSE_HTTP_URL"] ?: "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
          database = mergedEnv["CLICKHOUSE_DATABASE"] ?: "torghut",
          username = mergedEnv["CLICKHOUSE_USERNAME"] ?: "torghut",
          password = mergedEnv["CLICKHOUSE_PASSWORD"] ?: "",
          batchSize = intEnv(mergedEnv, "CLICKHOUSE_BATCH_SIZE", 250).coerceIn(1, 5000),
          flushMs = longEnv(mergedEnv, "CLICKHOUSE_FLUSH_MS", 1000).coerceAtLeast(250),
          requestTimeoutMs = longEnv(mergedEnv, "CLICKHOUSE_REQUEST_TIMEOUT_MS", 10_000).coerceAtLeast(1_000),
          readyMaxAgeMs = longEnv(mergedEnv, "CLICKHOUSE_READY_MAX_AGE_MS", 120_000).coerceAtLeast(1_000),
          failureHoldMs = longEnv(mergedEnv, "CLICKHOUSE_FAILURE_HOLD_MS", 60_000).coerceAtLeast(1_000),
          enabledTables =
            csv(mergedEnv["CLICKHOUSE_ENABLED_TABLES"] ?: supportedClickHouseTables.joinToString(","))
              .toSet()
              .also { tables ->
                if (tables.isEmpty()) error("CLICKHOUSE_ENABLED_TABLES must include at least one table")
                val unknown = tables.filterNot { it in supportedClickHouseTables }
                if (unknown.isNotEmpty()) error("Unsupported CLICKHOUSE_ENABLED_TABLES: ${unknown.joinToString(",")}")
              },
          readyTables =
            csv(mergedEnv["CLICKHOUSE_READY_TABLES"] ?: "hyperliquid_raw,hyperliquid_candles")
              .toSet()
              .also { tables ->
                if (tables.isEmpty()) error("CLICKHOUSE_READY_TABLES must include at least one table")
                val unknown = tables.filterNot { it in supportedClickHouseReadyTables }
                if (unknown.isNotEmpty()) error("Unsupported CLICKHOUSE_READY_TABLES: ${unknown.joinToString(",")}")
              },
          freshnessCheckMs = longEnv(mergedEnv, "CLICKHOUSE_FRESHNESS_CHECK_MS", 30_000).coerceAtLeast(1_000),
        )
      val disabledReadyTables = clickHouse.readyTables - clickHouse.enabledTables
      if (disabledReadyTables.isNotEmpty()) {
        error("CLICKHOUSE_READY_TABLES must be included in CLICKHOUSE_ENABLED_TABLES: ${disabledReadyTables.joinToString(",")}")
      }

      return HyperliquidConfig(
        network = network,
        infoUrl = mergedEnv["HYPERLIQUID_INFO_URL"] ?: defaultInfoUrl,
        wsUrl = mergedEnv["HYPERLIQUID_WS_URL"] ?: defaultWsUrl,
        includePerps = includePerps,
        includeSpot = includeSpot,
        marketCoverage = marketCoverage,
        topMarketCount = topMarketCount,
        canaryCoins = csv(mergedEnv["HYPERLIQUID_CANARY_COINS"] ?: "BTC,ETH,SOL,HYPE").map { it.uppercase() }.toSet(),
        candleIntervals = candleIntervals,
        wsChannels = wsChannels,
        maxWsConnections = maxWsConnections,
        maxSubscriptionsPerConnection = maxSubscriptionsPerConnection,
        maxTotalSubscriptions = maxTotalSubscriptions,
        restWeightBudgetPerMinute = restWeightBudgetPerMinute,
        restMetadataRefreshMs = longEnv(mergedEnv, "HYPERLIQUID_REST_METADATA_REFRESH_MS", 300_000),
        reconnectBaseMs = longEnv(mergedEnv, "RECONNECT_BASE_MS", 500),
        reconnectMaxMs = longEnv(mergedEnv, "RECONNECT_MAX_MS", 30_000),
        heartbeatIntervalMs = longEnv(mergedEnv, "HYPERLIQUID_HEARTBEAT_INTERVAL_MS", 30_000),
        dedupTtlSeconds = longEnv(mergedEnv, "DEDUP_TTL_SEC", 30),
        dedupMaxEntries = intEnv(mergedEnv, "DEDUP_MAX_ENTRIES", 100_000),
        readyRequiredChannels = readyRequiredChannels,
        readyEventMaxAgeMs = readyEventMaxAgeMs,
        healthPort = intEnv(mergedEnv, "HEALTH_PORT", 8080),
        metricsPort = intEnv(mergedEnv, "METRICS_PORT", 9090),
        kafka = kafkaSettings(mergedEnv),
        topics =
          HyperliquidTopics(
            raw = mergedEnv["TOPIC_RAW"] ?: "torghut.hyperliquid.raw.v1",
            markets = mergedEnv["TOPIC_MARKETS"] ?: "torghut.hyperliquid.markets.v1",
            trades = mergedEnv["TOPIC_TRADES"] ?: "torghut.hyperliquid.trades.v1",
            booksL2 = mergedEnv["TOPIC_BOOKS_L2"] ?: "torghut.hyperliquid.books.l2.v1",
            bbo = mergedEnv["TOPIC_BBO"] ?: "torghut.hyperliquid.bbo.v1",
            candles = mergedEnv["TOPIC_CANDLES"] ?: "torghut.hyperliquid.candles.v1",
            assetCtx = mergedEnv["TOPIC_ASSET_CTX"] ?: "torghut.hyperliquid.asset-ctx.v1",
            funding = mergedEnv["TOPIC_FUNDING"] ?: "torghut.hyperliquid.funding.v1",
            status = mergedEnv["TOPIC_STATUS"] ?: "torghut.hyperliquid.status.v1",
          ),
        clickHouse = clickHouse,
      )
    }

    private fun kafkaSettings(env: Map<String, String>): KafkaProducerSettings =
      KafkaProducerSettings(
        bootstrapServers = env["KAFKA_BOOTSTRAP"] ?: "localhost:9093",
        clientId = env["KAFKA_CLIENT_ID"] ?: "dorvud-hyperliquid-feed",
        lingerMs = intEnv(env, "KAFKA_LINGER_MS", 30),
        batchSize = intEnv(env, "KAFKA_BATCH_SIZE", 32768),
        bufferMemoryBytes = longEnv(env, "KAFKA_BUFFER_MEMORY_BYTES", 16L * 1024 * 1024),
        maxRequestSizeBytes = intEnv(env, "KAFKA_MAX_REQUEST_SIZE_BYTES", 512 * 1024),
        deliveryTimeoutMs = intEnv(env, "KAFKA_DELIVERY_TIMEOUT_MS", 60_000),
        requestTimeoutMs = intEnv(env, "KAFKA_REQUEST_TIMEOUT_MS", 15_000),
        maxBlockMs = longEnv(env, "KAFKA_MAX_BLOCK_MS", 10_000),
        acks = env["KAFKA_ACKS"] ?: "all",
        compressionType = env["KAFKA_COMPRESSION"] ?: "lz4",
        securityProtocol = env["KAFKA_SECURITY_PROTOCOL"] ?: "SASL_SSL",
        auth =
          KafkaAuth(
            username = env["KAFKA_SASL_USER"] ?: "torghut-hyperliquid-feed",
            password = env["KAFKA_SASL_PASSWORD"] ?: "changeme",
            mechanism = env["KAFKA_SASL_MECH"] ?: "SCRAM-SHA-512",
          ),
        tls =
          KafkaTls(
            truststorePath = env["KAFKA_TRUSTSTORE_PATH"],
            truststorePassword = env["KAFKA_TRUSTSTORE_PASSWORD"],
            endpointIdentification = env["KAFKA_SSL_ENDPOINT_IDENTIFICATION"] ?: "HTTPS",
          ),
      )

    private fun mergeEnv(): Map<String, String> {
      val merged = loadDotEnv().toMutableMap()
      merged.putAll(System.getenv())
      return merged
    }

    private fun loadDotEnv(): Map<String, String> {
      val customPath = System.getProperty("dotenv.path") ?: System.getenv("DOTENV_PATH")
      val file = customPath?.let(::File) ?: File(".env.local")
      if (!file.exists()) return emptyMap()
      return dotenv {
        directory = file.parent ?: "."
        filename = file.name
        ignoreIfMissing = true
      }.entries().associate { it.key to it.value }
    }

    private fun csv(value: String): List<String> = value.split(",").map { it.trim() }.filter { it.isNotEmpty() }

    private fun intEnv(
      env: Map<String, String>,
      name: String,
      default: Int,
    ): Int = env[name]?.toIntOrNull() ?: default

    private fun longEnv(
      env: Map<String, String>,
      name: String,
      default: Long,
    ): Long = env[name]?.toLongOrNull() ?: default
  }
}
