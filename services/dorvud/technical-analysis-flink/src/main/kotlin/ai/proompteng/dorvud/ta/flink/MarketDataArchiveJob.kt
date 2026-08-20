package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import kotlinx.serialization.json.Json
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.functions.RichFlatMapFunction
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.connector.jdbc.JdbcConnectionOptions
import org.apache.flink.connector.jdbc.JdbcExecutionOptions
import org.apache.flink.connector.jdbc.JdbcStatementBuilder
import org.apache.flink.connector.jdbc.core.datastream.sink.JdbcSink
import org.apache.flink.connector.kafka.source.KafkaSource
import org.apache.flink.connector.kafka.source.KafkaSourceBuilder
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer
import org.apache.flink.connector.kafka.source.reader.deserializer.KafkaRecordDeserializationSchema
import org.apache.flink.metrics.Counter
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.util.Collector
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.consumer.OffsetResetStrategy
import org.slf4j.LoggerFactory
import java.io.Serializable
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.sql.Timestamp
import java.time.Instant

private const val ARCHIVE_SCHEMA_VERSION = 1
private val supportedSessions = setOf("overnight", "pre", "regular", "post")
private val supportedChannels = setOf("bars", "updatedBars")

enum class ArchiveRecordKind {
  Bar,
  Quote,
  Trade,
}

data class ArchiveUniverse(
  val id: String,
  val symbolHash: String,
  val symbols: Set<String>,
) : Serializable

data class ArchiveRoute(
  val feed: String,
  val universe: ArchiveUniverse,
  val kind: ArchiveRecordKind = ArchiveRecordKind.Bar,
) : Serializable

data class MarketDataArchiveConfig(
  val bootstrapServers: String,
  val routes: Map<String, ArchiveRoute>,
  val groupId: String,
  val eventGroupId: String?,
  val clientId: String,
  val offsetResetStrategy: OffsetResetStrategy,
  val securityProtocol: String,
  val saslMechanism: String,
  val saslUsername: String,
  val saslPassword: String?,
  val checkpointIntervalMs: Long,
  val parallelism: Int,
  val clickhouseUrl: String,
  val clickhouseUsername: String,
  val clickhousePassword: String?,
  val clickhouseBatchSize: Int,
  val clickhouseFlushMs: Long,
  val clickhouseMaxRetries: Int,
) : Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L

    fun fromEnv(env: Map<String, String> = System.getenv()): MarketDataArchiveConfig {
      fun required(key: String): String =
        env[key]?.trim()?.takeIf { it.isNotEmpty() }
          ?: error("$key must be set")

      fun optional(key: String): String? = env[key]?.trim()?.takeIf { it.isNotEmpty() }

      fun universe(
        idKey: String,
        symbolsKey: String,
        hashKey: String,
      ): ArchiveUniverse {
        val symbols =
          required(symbolsKey)
            .split(",")
            .map { it.trim().uppercase() }
            .filter { it.isNotEmpty() }
        require(symbols.isNotEmpty()) { "$symbolsKey must contain at least one symbol" }
        require(symbols == symbols.distinct().sorted()) { "$symbolsKey must be unique and canonically sorted" }
        val id = required(idKey)
        require(id.matches(Regex("^[a-z0-9]+(?:[.-][a-z0-9]+)*$"))) {
          "$idKey must be a versioned lowercase identifier"
        }
        val symbolHash = required(hashKey)
        require(symbolHash == canonicalSymbolHash(symbols)) { "$hashKey does not match canonical $symbolsKey" }
        return ArchiveUniverse(id, symbolHash, symbols.toSet())
      }

      val coreUniverse =
        universe("ARCHIVE_CORE_UNIVERSE_ID", "ARCHIVE_CORE_UNIVERSE_SYMBOLS", "ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH")
      val observationUniverse = universe("UNIVERSE_ID", "UNIVERSE_SYMBOLS", "UNIVERSE_SYMBOL_HASH")
      val coreFeed = optional("ARCHIVE_CORE_FEED") ?: "iex"
      require(coreFeed in setOf("iex", "sip")) { "ARCHIVE_CORE_FEED must be iex or sip" }
      val enrichedTopicKeys =
        listOf(
          "ARCHIVE_CORE_QUOTES_TOPIC",
          "ARCHIVE_CORE_TRADES_TOPIC",
          "ARCHIVE_DELAYED_SIP_QUOTES_TOPIC",
          "ARCHIVE_DELAYED_SIP_TRADES_TOPIC",
        )
      val enrichedTopics = enrichedTopicKeys.associateWith(::optional).filterValues { it != null }
      require(enrichedTopics.isEmpty() || enrichedTopics.size == enrichedTopicKeys.size) {
        "archive quote and trade topics must be configured together"
      }
      require(coreFeed == "iex" || enrichedTopics.isNotEmpty()) {
        "ARCHIVE_CORE_FEED requires the complete quote and trade topic contract"
      }
      val routes =
        buildMap {
          put(optional("ARCHIVE_CORE_BARS_TOPIC") ?: required("ARCHIVE_IEX_BARS_TOPIC"), ArchiveRoute(coreFeed, coreUniverse))
          put(required("ARCHIVE_DELAYED_SIP_BARS_TOPIC"), ArchiveRoute("delayed_sip", observationUniverse))
          put(required("ARCHIVE_OVERNIGHT_BARS_TOPIC"), ArchiveRoute("overnight", observationUniverse))
          if (enrichedTopics.isNotEmpty()) {
            put(requireNotNull(enrichedTopics["ARCHIVE_CORE_QUOTES_TOPIC"]), ArchiveRoute(coreFeed, coreUniverse, ArchiveRecordKind.Quote))
            put(requireNotNull(enrichedTopics["ARCHIVE_CORE_TRADES_TOPIC"]), ArchiveRoute(coreFeed, coreUniverse, ArchiveRecordKind.Trade))
            put(
              requireNotNull(enrichedTopics["ARCHIVE_DELAYED_SIP_QUOTES_TOPIC"]),
              ArchiveRoute("delayed_sip", observationUniverse, ArchiveRecordKind.Quote),
            )
            put(
              requireNotNull(enrichedTopics["ARCHIVE_DELAYED_SIP_TRADES_TOPIC"]),
              ArchiveRoute("delayed_sip", observationUniverse, ArchiveRecordKind.Trade),
            )
          }
        }
      val expectedRouteCount = if (enrichedTopics.isEmpty()) 3 else 7
      if (routes.size != expectedRouteCount) error("archive market-data topics must be unique")

      val groupId = optional("ARCHIVE_GROUP_ID") ?: "bayn-market-data-archive-v1"
      val eventGroupId = if (enrichedTopics.isEmpty()) null else required("ARCHIVE_EVENT_GROUP_ID")
      require(eventGroupId == null || eventGroupId != groupId) {
        "ARCHIVE_EVENT_GROUP_ID must differ from ARCHIVE_GROUP_ID"
      }

      val checkpointIntervalMs = env["ARCHIVE_CHECKPOINT_INTERVAL_MS"]?.toLongOrNull() ?: 60_000
      val parallelism = env["ARCHIVE_PARALLELISM"]?.toIntOrNull() ?: 3
      val batchSize = env["ARCHIVE_CLICKHOUSE_BATCH_SIZE"]?.toIntOrNull() ?: 100
      val flushMs = env["ARCHIVE_CLICKHOUSE_FLUSH_MS"]?.toLongOrNull() ?: 1_000
      val maxRetries = env["ARCHIVE_CLICKHOUSE_MAX_RETRIES"]?.toIntOrNull() ?: 3
      val offsetResetStrategy =
        when (env["ARCHIVE_OFFSET_RESET"]?.trim()?.lowercase() ?: "earliest") {
          "earliest" -> OffsetResetStrategy.EARLIEST
          "latest" -> OffsetResetStrategy.LATEST
          else -> throw IllegalArgumentException("ARCHIVE_OFFSET_RESET must be earliest or latest")
        }
      val securityProtocol = env["ARCHIVE_KAFKA_SECURITY"] ?: "SASL_PLAINTEXT"
      val saslPassword = env["ARCHIVE_KAFKA_PASSWORD"]?.takeIf { it.isNotEmpty() }
      require(checkpointIntervalMs > 0) { "ARCHIVE_CHECKPOINT_INTERVAL_MS must be > 0" }
      require(parallelism in 1..3) { "ARCHIVE_PARALLELISM must be within 1..3" }
      require(batchSize in 1..1_000) { "ARCHIVE_CLICKHOUSE_BATCH_SIZE must be within 1..1000" }
      require(flushMs >= 250) { "ARCHIVE_CLICKHOUSE_FLUSH_MS must be >= 250" }
      require(maxRetries in 0..10) { "ARCHIVE_CLICKHOUSE_MAX_RETRIES must be within 0..10" }
      if (securityProtocol.startsWith("SASL_")) {
        requireNotNull(saslPassword) { "ARCHIVE_KAFKA_PASSWORD must be set for $securityProtocol" }
      }

      return MarketDataArchiveConfig(
        bootstrapServers = env["ARCHIVE_KAFKA_BOOTSTRAP"] ?: "kafka-kafka-bootstrap.kafka:9092",
        routes = routes,
        groupId = groupId,
        eventGroupId = eventGroupId,
        clientId = env["ARCHIVE_CLIENT_ID"] ?: "bayn-market-data-archive",
        offsetResetStrategy = offsetResetStrategy,
        securityProtocol = securityProtocol,
        saslMechanism = env["ARCHIVE_KAFKA_SASL_MECH"] ?: "SCRAM-SHA-512",
        saslUsername = env["ARCHIVE_KAFKA_USERNAME"] ?: "torghut-ws",
        saslPassword = saslPassword,
        checkpointIntervalMs = checkpointIntervalMs,
        parallelism = parallelism,
        clickhouseUrl = required("ARCHIVE_CLICKHOUSE_URL"),
        clickhouseUsername = env["ARCHIVE_CLICKHOUSE_USERNAME"] ?: "signal_publisher",
        clickhousePassword = required("ARCHIVE_CLICKHOUSE_PASSWORD"),
        clickhouseBatchSize = batchSize,
        clickhouseFlushMs = flushMs,
        clickhouseMaxRetries = maxRetries,
      )
    }
  }
}

data class ArchiveKafkaRecord(
  val topic: String,
  val partition: Int,
  val offset: Long,
  val value: String,
) : Serializable

data class IntradayBarRecord(
  val provider: String,
  val universeId: String,
  val universeSymbolHash: String,
  val feed: String,
  val channel: String,
  val marketSession: String,
  val delayClass: String,
  val symbol: String,
  val eventTime: Instant,
  val ingestionTime: Instant,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val final: Boolean,
  val open: Double,
  val high: Double,
  val low: Double,
  val close: Double,
  val volume: Double,
  val vwap: Double?,
  val tradeCount: Long?,
  val schemaVersion: Int,
) : Serializable

data class IntradayQuoteRecord(
  val provider: String,
  val universeId: String,
  val universeSymbolHash: String,
  val feed: String,
  val marketSession: String,
  val delayClass: String,
  val symbol: String,
  val eventTime: Instant,
  val ingestionTime: Instant,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val bidPrice: Double,
  val bidSize: Double,
  val askPrice: Double,
  val askSize: Double,
  val schemaVersion: Int,
) : Serializable

data class IntradayTradeRecord(
  val provider: String,
  val universeId: String,
  val universeSymbolHash: String,
  val feed: String,
  val marketSession: String,
  val delayClass: String,
  val symbol: String,
  val eventTime: Instant,
  val ingestionTime: Instant,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val price: Double,
  val size: Double,
  val schemaVersion: Int,
) : Serializable

fun main() {
  val config = MarketDataArchiveConfig.fromEnv()
  val environment = StreamExecutionEnvironment.getExecutionEnvironment()
  environment.setParallelism(config.parallelism)
  environment.enableCheckpointing(config.checkpointIntervalMs)

  val barRoutes = config.routes.filterValues { it.kind == ArchiveRecordKind.Bar }
  val barSource =
    environment
      .fromSource(
        archiveKafkaSource(config, barRoutes.keys, config.groupId, "${config.clientId}-bars"),
        WatermarkStrategy.noWatermarks(),
        "market-data-bars-source",
      )

  barSource
    .flatMap(ParseArchiveBar(barRoutes))
    .returns(TypeInformation.of(IntradayBarRecord::class.java))
    .sinkTo(archiveClickhouseSink(config))
    .name("signal-intraday-bars-archive")
    .uid("signal-intraday-bars-archive-v1")

  val eventRoutes = config.routes.filterValues { it.kind != ArchiveRecordKind.Bar }
  if (eventRoutes.isNotEmpty()) {
    val eventSource =
      environment.fromSource(
        archiveKafkaSource(
          config,
          eventRoutes.keys,
          requireNotNull(config.eventGroupId),
          "${config.clientId}-events",
        ),
        WatermarkStrategy.noWatermarks(),
        "market-data-events-source",
      )

    eventSource
      .flatMap(ParseArchiveQuote(eventRoutes))
      .returns(TypeInformation.of(IntradayQuoteRecord::class.java))
      .sinkTo(archiveQuoteClickhouseSink(config))
      .name("signal-intraday-quotes-archive")
      .uid("signal-intraday-quotes-archive-v1")

    eventSource
      .flatMap(ParseArchiveTrade(eventRoutes))
      .returns(TypeInformation.of(IntradayTradeRecord::class.java))
      .sinkTo(archiveTradeClickhouseSink(config))
      .name("signal-intraday-trades-archive")
      .uid("signal-intraday-trades-archive-v1")
  }

  environment.execute("Bayn market-data archive")
}

internal class ArchiveKafkaRecordDeserializer : KafkaRecordDeserializationSchema<ArchiveKafkaRecord> {
  override fun deserialize(
    record: ConsumerRecord<ByteArray, ByteArray>,
    out: Collector<ArchiveKafkaRecord>,
  ) {
    val value = record.value() ?: return
    out.collect(
      ArchiveKafkaRecord(
        topic = record.topic(),
        partition = record.partition(),
        offset = record.offset(),
        value = value.decodeToString(),
      ),
    )
  }

  override fun getProducedType(): TypeInformation<ArchiveKafkaRecord> = TypeInformation.of(ArchiveKafkaRecord::class.java)
}

internal class ParseArchiveBar(
  private val routeByTopic: Map<String, ArchiveRoute>,
) : RichFlatMapFunction<ArchiveKafkaRecord, IntradayBarRecord>(),
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  @Transient
  private lateinit var json: Json

  @Transient
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    json = Json { ignoreUnknownKeys = true }
    rejected = runtimeContext.metricGroup.counter("market_data_archive_rejected_total")
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<IntradayBarRecord>,
  ) {
    if (routeByTopic[value.topic]?.kind != ArchiveRecordKind.Bar) return
    runCatching { decodeArchiveBar(value, routeByTopic, json) }
      .onSuccess(out::collect)
      .onFailure { cause ->
        rejected.inc()
        LoggerFactory.getLogger("market-data-archive").warn(
          "Rejected archive bar topic={} partition={} offset={}",
          value.topic,
          value.partition,
          value.offset,
          cause,
        )
      }
  }
}

internal fun decodeArchiveBar(
  record: ArchiveKafkaRecord,
  routeByTopic: Map<String, ArchiveRoute>,
  json: Json = Json { ignoreUnknownKeys = true },
): IntradayBarRecord {
  val route = routeByTopic[record.topic] ?: error("unexpected archive topic: ${record.topic}")
  require(route.kind == ArchiveRecordKind.Bar) { "archive topic is not configured for bars" }
  val expectedFeed = route.feed
  val universe = route.universe
  require(record.partition >= 0) { "archive source partition must be non-negative" }
  require(record.offset >= 0) { "archive source offset must be non-negative" }
  val envelope = json.decodeFromString(Envelope.serializer(AlpacaBarPayload.serializer()), record.value)
  require(envelope.provider == "alpaca") { "archive envelope provider must be alpaca" }
  require(envelope.feed == expectedFeed) { "archive envelope feed does not match its source topic" }
  require(envelope.channel in supportedChannels) { "archive envelope channel must be bars or updatedBars" }
  val marketSession = requireNotNull(envelope.marketSession) { "archive envelope marketSession is required" }
  require(marketSession in supportedSessions) { "unsupported archive marketSession: $marketSession" }
  val delayClass = requireNotNull(envelope.delayClass) { "archive envelope delayClass is required" }
  require(delayClass == expectedDelayClass(expectedFeed, envelope.channel)) {
    "archive envelope delayClass does not match feed and channel"
  }
  require(envelope.version >= 2) { "archive envelope version must include feed metadata" }
  require(envelope.symbol.isNotBlank()) { "archive envelope symbol is required" }
  require(envelope.symbol in universe.symbols) { "archive envelope symbol is outside the configured universe" }
  require(Instant.parse(envelope.payload.timestamp) == envelope.eventTs) { "bar payload timestamp must match event time" }

  val payload = envelope.payload
  require(listOf(payload.open, payload.high, payload.low, payload.close, payload.volume).all { it.isFinite() }) {
    "bar OHLCV must be finite"
  }
  require(payload.open > 0 && payload.high > 0 && payload.low > 0 && payload.close > 0) { "bar OHLC must be positive" }
  require(payload.high >= maxOf(payload.open, payload.close, payload.low)) { "bar high is inconsistent" }
  require(payload.low <= minOf(payload.open, payload.close, payload.high)) { "bar low is inconsistent" }
  require(payload.volume >= 0) { "bar volume must be non-negative" }
  require(payload.vwap?.let { it.isFinite() && it > 0 } != false) { "bar VWAP must be positive and finite" }
  require(payload.tradeCount?.let { it >= 0 } != false) { "bar trade count must be non-negative" }

  return IntradayBarRecord(
    provider = "alpaca",
    universeId = universe.id,
    universeSymbolHash = universe.symbolHash,
    feed = expectedFeed,
    channel = envelope.channel,
    marketSession = marketSession,
    delayClass = delayClass,
    symbol = envelope.symbol,
    eventTime = envelope.eventTs,
    ingestionTime = envelope.ingestTs,
    sourceTopic = record.topic,
    sourcePartition = record.partition,
    sourceOffset = record.offset,
    final = envelope.isFinal,
    open = payload.open,
    high = payload.high,
    low = payload.low,
    close = payload.close,
    volume = payload.volume,
    vwap = payload.vwap,
    tradeCount = payload.tradeCount,
    schemaVersion = ARCHIVE_SCHEMA_VERSION,
  )
}

internal class ParseArchiveQuote(
  private val routeByTopic: Map<String, ArchiveRoute>,
) : RichFlatMapFunction<ArchiveKafkaRecord, IntradayQuoteRecord>(),
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  @Transient
  private lateinit var json: Json

  @Transient
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    json = Json { ignoreUnknownKeys = true }
    rejected = runtimeContext.metricGroup.counter("market_data_quote_archive_rejected_total")
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<IntradayQuoteRecord>,
  ) {
    if (routeByTopic[value.topic]?.kind != ArchiveRecordKind.Quote) return
    runCatching { decodeArchiveQuote(value, routeByTopic, json) }
      .onSuccess(out::collect)
      .onFailure { cause ->
        rejected.inc()
        LoggerFactory.getLogger("market-data-archive").warn(
          "Rejected archive quote topic={} partition={} offset={}",
          value.topic,
          value.partition,
          value.offset,
          cause,
        )
      }
  }
}

internal class ParseArchiveTrade(
  private val routeByTopic: Map<String, ArchiveRoute>,
) : RichFlatMapFunction<ArchiveKafkaRecord, IntradayTradeRecord>(),
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  @Transient
  private lateinit var json: Json

  @Transient
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    json = Json { ignoreUnknownKeys = true }
    rejected = runtimeContext.metricGroup.counter("market_data_trade_archive_rejected_total")
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<IntradayTradeRecord>,
  ) {
    if (routeByTopic[value.topic]?.kind != ArchiveRecordKind.Trade) return
    runCatching { decodeArchiveTrade(value, routeByTopic, json) }
      .onSuccess(out::collect)
      .onFailure { cause ->
        rejected.inc()
        LoggerFactory.getLogger("market-data-archive").warn(
          "Rejected archive trade topic={} partition={} offset={}",
          value.topic,
          value.partition,
          value.offset,
          cause,
        )
      }
  }
}

private data class DecodedArchiveEnvelope<Payload>(
  val route: ArchiveRoute,
  val envelope: Envelope<Payload>,
)

private fun <Payload> decodeArchiveEnvelope(
  record: ArchiveKafkaRecord,
  routeByTopic: Map<String, ArchiveRoute>,
  kind: ArchiveRecordKind,
  channel: String,
  serializer: kotlinx.serialization.KSerializer<Payload>,
  json: Json,
): DecodedArchiveEnvelope<Payload> {
  val route = routeByTopic[record.topic] ?: error("unexpected archive topic: ${record.topic}")
  require(route.kind == kind) { "archive topic is not configured for ${channel}s" }
  require(record.partition >= 0) { "archive source partition must be non-negative" }
  require(record.offset >= 0) { "archive source offset must be non-negative" }
  val envelope = json.decodeFromString(Envelope.serializer(serializer), record.value)
  require(envelope.provider == "alpaca") { "archive envelope provider must be alpaca" }
  require(envelope.feed == route.feed) { "archive envelope feed does not match its source topic" }
  require(envelope.channel == channel) { "archive envelope channel must be $channel" }
  val marketSession = requireNotNull(envelope.marketSession) { "archive envelope marketSession is required" }
  require(marketSession in supportedSessions) { "unsupported archive marketSession: $marketSession" }
  val delayClass = requireNotNull(envelope.delayClass) { "archive envelope delayClass is required" }
  require(delayClass == expectedDelayClass(route.feed, channel)) {
    "archive envelope delayClass does not match feed and channel"
  }
  require(envelope.version >= 2) { "archive envelope version must include feed metadata" }
  require(envelope.symbol.isNotBlank()) { "archive envelope symbol is required" }
  require(envelope.symbol in route.universe.symbols) { "archive envelope symbol is outside the configured universe" }
  return DecodedArchiveEnvelope(route, envelope)
}

internal fun decodeArchiveQuote(
  record: ArchiveKafkaRecord,
  routeByTopic: Map<String, ArchiveRoute>,
  json: Json = Json { ignoreUnknownKeys = true },
): IntradayQuoteRecord {
  val decoded =
    decodeArchiveEnvelope(
      record,
      routeByTopic,
      ArchiveRecordKind.Quote,
      "quotes",
      QuotePayload.serializer(),
      json,
    )
  val route = decoded.route
  val envelope = decoded.envelope
  val payload = envelope.payload
  require(payload.t == envelope.eventTs) { "quote payload timestamp must match event time" }
  require(listOf(payload.bp, payload.bs, payload.ap, payload.`as`).all { it.isFinite() }) {
    "quote prices and sizes must be finite"
  }
  require(payload.bp > 0 && payload.ap > 0 && payload.bp <= payload.ap) { "quote market must be positive and uncrossed" }
  require(payload.bs >= 0 && payload.`as` >= 0) { "quote sizes must be non-negative" }
  return IntradayQuoteRecord(
    provider = "alpaca",
    universeId = route.universe.id,
    universeSymbolHash = route.universe.symbolHash,
    feed = route.feed,
    marketSession = requireNotNull(envelope.marketSession),
    delayClass = requireNotNull(envelope.delayClass),
    symbol = envelope.symbol,
    eventTime = envelope.eventTs,
    ingestionTime = envelope.ingestTs,
    sourceTopic = record.topic,
    sourcePartition = record.partition,
    sourceOffset = record.offset,
    bidPrice = payload.bp,
    bidSize = payload.bs,
    askPrice = payload.ap,
    askSize = payload.`as`,
    schemaVersion = ARCHIVE_SCHEMA_VERSION,
  )
}

internal fun decodeArchiveTrade(
  record: ArchiveKafkaRecord,
  routeByTopic: Map<String, ArchiveRoute>,
  json: Json = Json { ignoreUnknownKeys = true },
): IntradayTradeRecord {
  val decoded =
    decodeArchiveEnvelope(
      record,
      routeByTopic,
      ArchiveRecordKind.Trade,
      "trades",
      TradePayload.serializer(),
      json,
    )
  val route = decoded.route
  val envelope = decoded.envelope
  val payload = envelope.payload
  require(payload.t == envelope.eventTs) { "trade payload timestamp must match event time" }
  require(payload.p.isFinite() && payload.p > 0) { "trade price must be positive and finite" }
  require(payload.s.isFinite() && payload.s > 0) { "trade size must be positive and finite" }
  return IntradayTradeRecord(
    provider = "alpaca",
    universeId = route.universe.id,
    universeSymbolHash = route.universe.symbolHash,
    feed = route.feed,
    marketSession = requireNotNull(envelope.marketSession),
    delayClass = requireNotNull(envelope.delayClass),
    symbol = envelope.symbol,
    eventTime = envelope.eventTs,
    ingestionTime = envelope.ingestTs,
    sourceTopic = record.topic,
    sourcePartition = record.partition,
    sourceOffset = record.offset,
    price = payload.p,
    size = payload.s,
    schemaVersion = ARCHIVE_SCHEMA_VERSION,
  )
}

private fun canonicalSymbolHash(symbols: Collection<String>): String =
  MessageDigest
    .getInstance("SHA-256")
    .digest(symbols.joinToString(",").toByteArray(StandardCharsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private fun expectedDelayClass(
  feed: String,
  channel: String,
): String =
  when (feed) {
    "iex" -> "real_time_exchange_only"
    "sip" -> "real_time_consolidated"
    "delayed_sip" -> "delayed_15m_consolidated"
    "overnight" -> if (channel == "bars" || channel == "updatedBars") "derived" else error("unsupported overnight channel")
    else -> error("unsupported archive feed: $feed")
  }

private fun archiveKafkaSource(
  config: MarketDataArchiveConfig,
  topics: Set<String>,
  groupId: String,
  clientId: String,
): KafkaSource<ArchiveKafkaRecord> {
  require(topics.isNotEmpty()) { "archive Kafka source must have at least one topic" }
  val builder =
    KafkaSource
      .builder<ArchiveKafkaRecord>()
      .setBootstrapServers(config.bootstrapServers)
      .setTopics(topics.sorted())
      .setClientIdPrefix(clientId)
      .setGroupId(groupId)
      .setDeserializer(ArchiveKafkaRecordDeserializer())
      .setStartingOffsets(OffsetsInitializer.committedOffsets(config.offsetResetStrategy))
      .setProperty("auto.offset.reset", config.offsetResetStrategy.name.lowercase())
      .setProperty("isolation.level", "read_committed")
      .setProperty("enable.auto.commit", "false")
  applyArchiveKafkaSecurity(builder, config)
  return builder.build()
}

private fun applyArchiveKafkaSecurity(
  builder: KafkaSourceBuilder<ArchiveKafkaRecord>,
  config: MarketDataArchiveConfig,
) {
  builder.setProperty("security.protocol", config.securityProtocol)
  builder.setProperty("sasl.mechanism", config.saslMechanism)
  config.saslPassword?.let { password ->
    val escapedUsername = config.saslUsername.replace("\\", "\\\\").replace("\"", "\\\"")
    val escapedPassword = password.replace("\\", "\\\\").replace("\"", "\\\"")
    builder.setProperty(
      "sasl.jaas.config",
      "org.apache.kafka.common.security.scram.ScramLoginModule required " +
        "username=\"$escapedUsername\" password=\"$escapedPassword\";",
    )
  }
}

private fun archiveClickhouseSink(config: MarketDataArchiveConfig): JdbcSink<IntradayBarRecord> {
  val sql =
    """
    INSERT INTO signal.intraday_bars_1m_v2 (
      provider, universe_id, universe_symbol_hash, feed, channel, market_session, delay_class, symbol, event_ts, ingest_ts,
      source_topic, source_partition, source_offset, is_final,
      open, high, low, close, volume, vwap, trade_count, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()
  val statement =
    JdbcStatementBuilder<IntradayBarRecord> { prepared, bar ->
      prepared.setString(1, bar.provider)
      prepared.setString(2, bar.universeId)
      prepared.setString(3, bar.universeSymbolHash)
      prepared.setString(4, bar.feed)
      prepared.setString(5, bar.channel)
      prepared.setString(6, bar.marketSession)
      prepared.setString(7, bar.delayClass)
      prepared.setString(8, bar.symbol)
      prepared.setTimestamp(9, Timestamp.from(bar.eventTime))
      prepared.setTimestamp(10, Timestamp.from(bar.ingestionTime))
      prepared.setString(11, bar.sourceTopic)
      prepared.setInt(12, bar.sourcePartition)
      prepared.setLong(13, bar.sourceOffset)
      prepared.setInt(14, if (bar.final) 1 else 0)
      prepared.setDouble(15, bar.open)
      prepared.setDouble(16, bar.high)
      prepared.setDouble(17, bar.low)
      prepared.setDouble(18, bar.close)
      prepared.setDouble(19, bar.volume)
      if (bar.vwap == null) prepared.setNull(20, java.sql.Types.DOUBLE) else prepared.setDouble(20, bar.vwap)
      if (bar.tradeCount == null) prepared.setNull(21, java.sql.Types.BIGINT) else prepared.setLong(21, bar.tradeCount)
      prepared.setInt(22, bar.schemaVersion)
    }
  val execution =
    JdbcExecutionOptions
      .builder()
      .withBatchSize(config.clickhouseBatchSize)
      .withBatchIntervalMs(config.clickhouseFlushMs)
      .withMaxRetries(config.clickhouseMaxRetries)
      .build()
  val connection =
    JdbcConnectionOptions
      .JdbcConnectionOptionsBuilder()
      .withUrl(config.clickhouseUrl)
      .withDriverName("com.clickhouse.jdbc.ClickHouseDriver")
      .withUsername(config.clickhouseUsername)
      .apply { config.clickhousePassword?.let(::withPassword) }
      .build()
  return JdbcSink
    .builder<IntradayBarRecord>()
    .withQueryStatement(sql, statement)
    .withExecutionOptions(execution)
    .buildAtLeastOnce(connection)
}

private fun archiveQuoteClickhouseSink(config: MarketDataArchiveConfig): JdbcSink<IntradayQuoteRecord> {
  val sql =
    """
    INSERT INTO signal.intraday_quotes_v1 (
      provider, universe_id, universe_symbol_hash, feed, market_session, delay_class, symbol, event_ts, ingest_ts,
      source_topic, source_partition, source_offset, bid_price, bid_size, ask_price, ask_size, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()
  val statement =
    JdbcStatementBuilder<IntradayQuoteRecord> { prepared, quote ->
      prepared.setString(1, quote.provider)
      prepared.setString(2, quote.universeId)
      prepared.setString(3, quote.universeSymbolHash)
      prepared.setString(4, quote.feed)
      prepared.setString(5, quote.marketSession)
      prepared.setString(6, quote.delayClass)
      prepared.setString(7, quote.symbol)
      prepared.setTimestamp(8, Timestamp.from(quote.eventTime))
      prepared.setTimestamp(9, Timestamp.from(quote.ingestionTime))
      prepared.setString(10, quote.sourceTopic)
      prepared.setInt(11, quote.sourcePartition)
      prepared.setLong(12, quote.sourceOffset)
      prepared.setDouble(13, quote.bidPrice)
      prepared.setDouble(14, quote.bidSize)
      prepared.setDouble(15, quote.askPrice)
      prepared.setDouble(16, quote.askSize)
      prepared.setInt(17, quote.schemaVersion)
    }
  return JdbcSink
    .builder<IntradayQuoteRecord>()
    .withQueryStatement(sql, statement)
    .withExecutionOptions(archiveJdbcExecutionOptions(config))
    .buildAtLeastOnce(archiveJdbcConnectionOptions(config))
}

private fun archiveTradeClickhouseSink(config: MarketDataArchiveConfig): JdbcSink<IntradayTradeRecord> {
  val sql =
    """
    INSERT INTO signal.intraday_trades_v1 (
      provider, universe_id, universe_symbol_hash, feed, market_session, delay_class, symbol, event_ts, ingest_ts,
      source_topic, source_partition, source_offset, price, size, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()
  val statement =
    JdbcStatementBuilder<IntradayTradeRecord> { prepared, trade ->
      prepared.setString(1, trade.provider)
      prepared.setString(2, trade.universeId)
      prepared.setString(3, trade.universeSymbolHash)
      prepared.setString(4, trade.feed)
      prepared.setString(5, trade.marketSession)
      prepared.setString(6, trade.delayClass)
      prepared.setString(7, trade.symbol)
      prepared.setTimestamp(8, Timestamp.from(trade.eventTime))
      prepared.setTimestamp(9, Timestamp.from(trade.ingestionTime))
      prepared.setString(10, trade.sourceTopic)
      prepared.setInt(11, trade.sourcePartition)
      prepared.setLong(12, trade.sourceOffset)
      prepared.setDouble(13, trade.price)
      prepared.setDouble(14, trade.size)
      prepared.setInt(15, trade.schemaVersion)
    }
  return JdbcSink
    .builder<IntradayTradeRecord>()
    .withQueryStatement(sql, statement)
    .withExecutionOptions(archiveJdbcExecutionOptions(config))
    .buildAtLeastOnce(archiveJdbcConnectionOptions(config))
}

private fun archiveJdbcExecutionOptions(config: MarketDataArchiveConfig): JdbcExecutionOptions =
  JdbcExecutionOptions
    .builder()
    .withBatchSize(config.clickhouseBatchSize)
    .withBatchIntervalMs(config.clickhouseFlushMs)
    .withMaxRetries(config.clickhouseMaxRetries)
    .build()

private fun archiveJdbcConnectionOptions(config: MarketDataArchiveConfig): JdbcConnectionOptions =
  JdbcConnectionOptions
    .JdbcConnectionOptionsBuilder()
    .withUrl(config.clickhouseUrl)
    .withDriverName("com.clickhouse.jdbc.ClickHouseDriver")
    .withUsername(config.clickhouseUsername)
    .apply { config.clickhousePassword?.let(::withPassword) }
    .build()
