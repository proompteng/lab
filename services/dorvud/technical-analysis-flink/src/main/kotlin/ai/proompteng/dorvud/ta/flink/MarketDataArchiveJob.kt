package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
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

data class ArchiveUniverse(
  val id: String,
  val symbolHash: String,
  val symbols: Set<String>,
) : Serializable

data class MarketDataArchiveConfig(
  val bootstrapServers: String,
  val topics: Map<String, String>,
  val universe: ArchiveUniverse,
  val groupId: String,
  val clientId: String,
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

      val topics =
        linkedMapOf(
          required("ARCHIVE_IEX_BARS_TOPIC") to "iex",
          required("ARCHIVE_DELAYED_SIP_BARS_TOPIC") to "delayed_sip",
          required("ARCHIVE_OVERNIGHT_BARS_TOPIC") to "overnight",
        )
      if (topics.size != 3) error("archive bar topics must be unique")
      val universeSymbols =
        required("UNIVERSE_SYMBOLS")
          .split(",")
          .map { it.trim().uppercase() }
          .filter { it.isNotEmpty() }
      require(universeSymbols.isNotEmpty()) { "UNIVERSE_SYMBOLS must contain at least one symbol" }
      require(universeSymbols == universeSymbols.distinct().sorted()) {
        "UNIVERSE_SYMBOLS must be unique and canonically sorted"
      }
      val universeId = required("UNIVERSE_ID")
      require(universeId.matches(Regex("^[a-z0-9]+(?:[.-][a-z0-9]+)*$"))) {
        "UNIVERSE_ID must be a versioned lowercase identifier"
      }
      val universeSymbolHash = required("UNIVERSE_SYMBOL_HASH")
      require(universeSymbolHash == canonicalSymbolHash(universeSymbols)) {
        "UNIVERSE_SYMBOL_HASH does not match canonical UNIVERSE_SYMBOLS"
      }

      val checkpointIntervalMs = env["ARCHIVE_CHECKPOINT_INTERVAL_MS"]?.toLongOrNull() ?: 60_000
      val parallelism = env["ARCHIVE_PARALLELISM"]?.toIntOrNull() ?: 3
      val batchSize = env["ARCHIVE_CLICKHOUSE_BATCH_SIZE"]?.toIntOrNull() ?: 100
      val flushMs = env["ARCHIVE_CLICKHOUSE_FLUSH_MS"]?.toLongOrNull() ?: 1_000
      val maxRetries = env["ARCHIVE_CLICKHOUSE_MAX_RETRIES"]?.toIntOrNull() ?: 3
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
        topics = topics,
        universe = ArchiveUniverse(universeId, universeSymbolHash, universeSymbols.toSet()),
        groupId = env["ARCHIVE_GROUP_ID"] ?: "bayn-market-data-archive-v1",
        clientId = env["ARCHIVE_CLIENT_ID"] ?: "bayn-market-data-archive",
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

fun main() {
  val config = MarketDataArchiveConfig.fromEnv()
  val environment = StreamExecutionEnvironment.getExecutionEnvironment()
  environment.setParallelism(config.parallelism)
  environment.enableCheckpointing(config.checkpointIntervalMs)

  environment
    .fromSource(archiveKafkaSource(config), WatermarkStrategy.noWatermarks(), "market-data-bars-source")
    .flatMap(ParseArchiveBar(config.topics, config.universe))
    .returns(TypeInformation.of(IntradayBarRecord::class.java))
    .sinkTo(archiveClickhouseSink(config))
    .name("signal-intraday-bars-archive")
    .uid("signal-intraday-bars-archive-v1")

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
  private val expectedFeedByTopic: Map<String, String>,
  private val universe: ArchiveUniverse,
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
    runCatching { decodeArchiveBar(value, expectedFeedByTopic, universe, json) }
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
  expectedFeedByTopic: Map<String, String>,
  universe: ArchiveUniverse,
  json: Json = Json { ignoreUnknownKeys = true },
): IntradayBarRecord {
  val expectedFeed = expectedFeedByTopic[record.topic] ?: error("unexpected archive topic: ${record.topic}")
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
    "delayed_sip" -> "delayed_15m_consolidated"
    "overnight" -> if (channel == "bars" || channel == "updatedBars") "derived" else error("unsupported overnight channel")
    else -> error("unsupported archive feed: $feed")
  }

private fun archiveKafkaSource(config: MarketDataArchiveConfig): KafkaSource<ArchiveKafkaRecord> {
  val builder =
    KafkaSource
      .builder<ArchiveKafkaRecord>()
      .setBootstrapServers(config.bootstrapServers)
      .setTopics(config.topics.keys.toList())
      .setClientIdPrefix(config.clientId)
      .setGroupId(config.groupId)
      .setDeserializer(ArchiveKafkaRecordDeserializer())
      .setStartingOffsets(OffsetsInitializer.committedOffsets(OffsetResetStrategy.LATEST))
      .setProperty("auto.offset.reset", "latest")
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
    INSERT INTO signal.intraday_bars_1m_v1 (
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
