package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.MicrostructureSignalV1
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.TaStatusPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import ai.proompteng.dorvud.ta.stream.toMicroBarPayload
import ai.proompteng.dorvud.ta.stream.withPayload
import kotlinx.serialization.KSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.apache.flink.api.common.eventtime.SerializableTimestampAssigner
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.functions.RichFlatMapFunction
import org.apache.flink.api.common.serialization.SimpleStringSchema
import org.apache.flink.api.common.state.ListState
import org.apache.flink.api.common.state.ListStateDescriptor
import org.apache.flink.api.common.state.MapState
import org.apache.flink.api.common.state.MapStateDescriptor
import org.apache.flink.api.common.state.ValueState
import org.apache.flink.api.common.state.ValueStateDescriptor
import org.apache.flink.api.common.typeinfo.TypeHint
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.connector.base.DeliveryGuarantee
import org.apache.flink.connector.jdbc.JdbcConnectionOptions
import org.apache.flink.connector.jdbc.JdbcExecutionOptions
import org.apache.flink.connector.jdbc.JdbcStatementBuilder
import org.apache.flink.connector.jdbc.core.datastream.sink.JdbcSink
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema
import org.apache.flink.connector.kafka.sink.KafkaSink
import org.apache.flink.connector.kafka.sink.KafkaSinkBuilder
import org.apache.flink.connector.kafka.source.KafkaSource
import org.apache.flink.connector.kafka.source.KafkaSourceBuilder
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer
import org.apache.flink.connector.kafka.source.reader.deserializer.KafkaRecordDeserializationSchema
import org.apache.flink.metrics.Counter
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.functions.KeyedProcessFunction
import org.apache.flink.streaming.api.functions.co.KeyedCoProcessFunction
import org.apache.flink.streaming.api.graph.StreamGraph
import org.apache.flink.streaming.api.graph.StreamGraphHasherV2
import org.apache.flink.util.Collector
import org.apache.kafka.clients.consumer.OffsetResetStrategy
import org.apache.kafka.clients.producer.ProducerRecord
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.io.Serializable
import java.net.URI
import java.nio.charset.StandardCharsets
import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.Timestamp
import java.sql.Types
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Properties

fun main() {
  val config = FlinkTaConfig.fromEnv()
  applyS3SystemProperties(config)
  val env = StreamExecutionEnvironment.getExecutionEnvironment()

  configureEnvironment(env, config)
  val graph = configureTechnicalAnalysisJob(env, config, RollingMarketFeatureConfig.fromEnv())
  if (!config.clickhouseUrl.isNullOrBlank()) ensureClickhouseSchema(config)
  graph.jobName = "torghut-technical-analysis-flink"
  env.execute(graph)
}

internal fun configureTechnicalAnalysisJob(
  env: StreamExecutionEnvironment,
  config: FlinkTaConfig,
  features: RollingMarketFeatureConfig? = null,
): StreamGraph {
  val serde = AvroSerde()
  val trades =
    env
      .fromSource(
        kafkaSource(config, config.tradesTopic, ArchiveKafkaRecordDeserializer()),
        WatermarkStrategy.noWatermarks(),
        "ta-trades-source",
      ).flatMap(ParseRecordedTrade())
      .returns(TypeInformation.of(RecordedTrade::class.java))
      .assignTimestampsAndWatermarks(
        WatermarkStrategy
          .forBoundedOutOfOrderness<RecordedTrade>(Duration.ofMillis(config.maxOutOfOrderMs))
          .withIdleness(Duration.ofMillis(config.watermarkIdleTimeoutMs))
          .withTimestampAssigner(SerializableTimestampAssigner<RecordedTrade> { event, _ -> event.envelope.eventTs.toEpochMilli() }),
      )

  val quotesStream =
    if (config.quotesTopic != null) {
      val parsedQuotes =
        env
          .fromSource(
            kafkaSource(config, config.quotesTopic),
            WatermarkStrategy.noWatermarks(),
            "ta-quotes-source",
          ).flatMap(
            ParseEnvelopeFlatMap(
              serializerFactory = SerializerFactory { QuotePayload.serializer() },
              failureMetricName = "quotes_parse_failures",
            ),
          )
      parsedQuotes
        .returns(object : TypeHint<Envelope<QuotePayload>>() {})
        .assignTimestampsAndWatermarks(watermarkStrategy(config))
    } else {
      emptyQuoteStream(env)
    }

  val bars1mStream =
    if (config.bars1mTopic != null) {
      env
        .fromSource(
          kafkaSource(config, config.bars1mTopic),
          WatermarkStrategy.noWatermarks(),
          "ta-bars1m-source",
        ).flatMap(ParseMicroBarCompatFlatMap())
        .returns(object : TypeHint<Envelope<MicroBarPayload>>() {})
        .assignTimestampsAndWatermarks(watermarkStrategy(config))
    } else {
      emptyBars1mStream(env)
    }

  val microBars =
    trades
      .keyBy { it.envelope.symbol }
      .process(MicrobarProcessFunction())
      .name("ta-microbars")
      .uid("ta-microbars")

  val microbarSignals =
    microBars
      .keyBy { it.symbol }
      .connect(quotesStream.keyBy { it.symbol })
      .process(
        TaSignalsFunction(
          config,
          Duration.ofSeconds(1),
          SignalBarTimestampAnchor.END,
          config.resetLegacyOneSecondSignalState,
        ),
      ).name("ta-signals")
      .uid("ta-signals")

  val signals =
    if (config.bars1mTopic != null) {
      val minuteSignals =
        bars1mStream
          .keyBy { it.symbol }
          .connect(quotesStream.keyBy { it.symbol })
          .process(
            TaSignalsFunction(
              config,
              Duration.ofMinutes(1),
              SignalBarTimestampAnchor.START,
              resetLegacyOneSecondState = false,
            ),
          ).name("ta-signals-1m")
          .uid("ta-signals-1m")
      microbarSignals.union(minuteSignals)
    } else {
      microbarSignals
    }

  val barsForStatus =
    if (config.bars1mTopic != null) {
      microBars.union(bars1mStream)
    } else {
      microBars
    }

  if (config.statusTopic != null) {
    val statusIntervalMs = config.checkpointIntervalMs.coerceAtLeast(1_000)
    val statusInputType = TypeInformation.of(object : TypeHint<StatusHeartbeatInput>() {})
    val microbarStatusInputs =
      barsForStatus
        .map { envelope: Envelope<MicroBarPayload> -> StatusHeartbeatInput.MicroBar(envelope) as StatusHeartbeatInput }
        .returns(statusInputType)
    val signalStatusInputs =
      signals
        .map { envelope: Envelope<TaSignalsPayload> -> StatusHeartbeatInput.Signal(envelope) as StatusHeartbeatInput }
        .returns(statusInputType)
    val startupStatusTick =
      env.fromData(
        listOf(StatusHeartbeatInput.StartupTick(Instant.now().toEpochMilli())),
        statusInputType,
      )
    val statusHeartbeats =
      microbarStatusInputs
        .union(signalStatusInputs, startupStatusTick)
        .keyBy { STATUS_SYMBOL }
        .process(
          StatusHeartbeatProcessFunction(
            intervalMs = statusIntervalMs,
            clickhouseSinkEnabled = !config.clickhouseUrl.isNullOrBlank(),
            sourceLagDegradedAfterMs = config.sourceLagDegradedAfterMs,
            marketHolidays = config.marketHolidays,
          ),
        )
    statusHeartbeats
      .name("ta-status")
      .uid("ta-status")
      .sinkTo(statusSink(config, serde))
      .name("sink-status")
  }

  microBars.sinkTo(microBarSink(config, serde)).name("sink-microbars")
  signals.sinkTo(signalSink(config, serde)).name("sink-signals")
  applyClickhouseSinks(config, microBars, signals)

  if (features == null) return env.streamGraph

  // New sources change generated sink IDs; retain the legacy graph identities for savepoint restoration.
  val previous = env.getStreamGraph(false)
  val rollingGraph = configureRollingMarketFeatures(env, config, features)
  val extended = env.streamGraph
  // Checkpoints contain generated IDs from the immediately preceding executable topology, not its restore aliases.
  preserveExistingOperatorIds(rollingGraph ?: previous, extended)
  return extended
}

internal fun preserveExistingOperatorIds(
  previous: StreamGraph,
  extended: StreamGraph,
) {
  val previousHashes = StreamGraphHasherV2().traverseStreamGraphAndGenerateHashes(previous)
  for (node in previous.streamNodes) {
    val retained =
      extended.getStreamNode(node.id) ?: extended.streamNodes.singleOrNull {
        it.operatorName == node.operatorName &&
          (node.operatorName.endsWith(": Writer") || node.operatorName.endsWith(": Committer"))
      }
    requireNotNull(retained) { "Existing savepoint operator is missing or ambiguous: ${node.operatorName}" }
    require(retained.operatorName == node.operatorName) { "Existing savepoint operator identity changed: ${node.operatorName}" }
    retained.userHash = node.userHash ?: previousHashes.getValue(node.id).joinToString("") { "%02x".format(it) }
  }
}

private const val STATUS_SYMBOL = "ta"
private const val MARKET_SESSION_REGULAR = "regular"
private const val MARKET_SESSION_OUTSIDE_REGULAR = "outside_regular_session"
private const val ZERO_CURRENT_RECORDS_REASON = "zero_current_records_during_regular_session"
private const val SOURCE_LAG_MISSING_REASON = "source_lag_missing_during_regular_session"
private const val SOURCE_LAG_STALE_REASON = "source_lag_stale_during_regular_session"
private val EQUITY_MARKET_ZONE: ZoneId = ZoneId.of("America/New_York")
private val REGULAR_SESSION_OPEN: LocalTime = LocalTime.of(9, 30)
private val REGULAR_SESSION_CLOSE: LocalTime = LocalTime.of(16, 0)

internal sealed class StatusHeartbeatInput : Serializable {
  data class MicroBar(
    val envelope: Envelope<MicroBarPayload>,
  ) : StatusHeartbeatInput()

  data class Signal(
    val envelope: Envelope<TaSignalsPayload>,
  ) : StatusHeartbeatInput()

  data class StartupTick(
    val createdAtEpochMs: Long,
  ) : StatusHeartbeatInput()
}

private fun applyClickhouseSinks(
  config: FlinkTaConfig,
  microBars: org.apache.flink.streaming.api.datastream.DataStream<Envelope<MicroBarPayload>>,
  signals: org.apache.flink.streaming.api.datastream.DataStream<Envelope<TaSignalsPayload>>,
) {
  if (config.clickhouseUrl.isNullOrBlank()) {
    LoggerFactory.getLogger("ta-clickhouse").info("ClickHouse sink disabled (TA_CLICKHOUSE_URL not set).")
    return
  }

  microBars
    .sinkTo(clickhouseMicrobarSink(config))
    .name("sink-microbars-clickhouse")
    .setParallelism(config.clickhouseSinkParallelism)
  signals
    .sinkTo(clickhouseSignalSink(config))
    .name("sink-signals-clickhouse")
    .setParallelism(config.clickhouseSinkParallelism)
}

private fun ensureClickhouseSchema(config: FlinkTaConfig) {
  val logger = LoggerFactory.getLogger("ta-clickhouse")
  val url = requireNotNull(config.clickhouseUrl) { "TA_CLICKHOUSE_URL must be set when ClickHouse sinks are enabled." }
  val adminUrl = clickhouseAdminUrl(url)
  val sinkDatabase = clickhouseDatabaseName(url)
  val schemaSql =
    object {}
      .javaClass
      .getResourceAsStream("/ta-schema.sql")
      ?.bufferedReader(StandardCharsets.UTF_8)
      ?.use { it.readText() }

  if (schemaSql.isNullOrBlank()) {
    logger.warn("ClickHouse schema SQL resource not found; skipping schema init.")
    return
  }

  val statements =
    schemaSql
      .splitToSequence(';')
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .toList()

  if (statements.isEmpty()) {
    logger.warn("ClickHouse schema SQL resource is empty; skipping schema init.")
    return
  }

  val maxAttempts = (config.clickhouseSchemaInitMaxRetries.coerceAtLeast(0)) + 1
  val retryDelayMs = config.clickhouseSchemaInitRetryDelayMs.coerceAtLeast(0)

  executeWithRetry(
    maxAttempts = maxAttempts,
    retryDelayMs = retryDelayMs,
    strict = config.clickhouseSchemaInitStrict,
    logger = logger,
    operationName = "ClickHouse schema",
  ) {
    val properties = Properties()
    config.clickhouseUsername?.let { properties["user"] = it }
    config.clickhousePassword?.let { properties["password"] = it }
    val connection =
      if (properties.isEmpty) {
        DriverManager.getConnection(adminUrl)
      } else {
        DriverManager.getConnection(adminUrl, properties)
      }

    connection.use { conn ->
      conn.createStatement().use { statement ->
        statements.forEach { statement.execute(it) }
      }
      if (config.clickhouseRequireReplicatedTables) {
        validateClickhouseTaTableEngines(loadClickhouseTaTableEngines(conn, sinkDatabase))
      }
    }
  }

  logger.info("ClickHouse schema ensured.")
}

private val requiredClickhouseTaTableEngines =
  mapOf(
    "ta_microbars" to "ReplicatedReplacingMergeTree",
    "ta_signals" to "ReplicatedReplacingMergeTree",
  )

private fun loadClickhouseTaTableEngines(
  connection: Connection,
  database: String,
): Map<String, String> {
  val tables = requiredClickhouseTaTableEngines.keys.joinToString(",") { "'$it'" }
  val sql = "SELECT name, engine FROM system.tables WHERE database = '${clickhouseSqlString(database)}' AND name IN ($tables)"
  val engines = mutableMapOf<String, String>()

  connection.createStatement().use { statement ->
    statement.executeQuery(sql).use { resultSet ->
      while (resultSet.next()) {
        engines[resultSet.getString("name")] = resultSet.getString("engine")
      }
    }
  }

  return engines
}

internal fun clickhouseDatabaseName(url: String): String {
  val raw = if (url.startsWith("jdbc:")) url.removePrefix("jdbc:") else url
  return try {
    val uri = URI(raw)
    val queryDatabase =
      uri.rawQuery
        ?.split('&')
        ?.mapNotNull {
          val parts = it.split('=', limit = 2)
          if (parts.size == 2 && (parts[0] == "database" || parts[0] == "db")) parts[1] else null
        }?.firstOrNull()
        ?.takeIf { it.isNotBlank() }
    val pathDatabase = uri.path.trim('/').takeIf { it.isNotBlank() }
    queryDatabase ?: pathDatabase ?: "default"
  } catch (_: Exception) {
    "default"
  }
}

private fun clickhouseSqlString(value: String): String = value.replace("'", "''")

internal fun validateClickhouseTaTableEngines(engineByTable: Map<String, String>) {
  val issues = mutableListOf<String>()
  for ((table, expectedEngine) in requiredClickhouseTaTableEngines.toSortedMap()) {
    val actualEngine = engineByTable[table]
    if (actualEngine == null) {
      issues += "$table=missing"
    } else if (actualEngine != expectedEngine) {
      issues += "$table=$actualEngine"
    }
  }

  if (issues.isNotEmpty()) {
    throw IllegalStateException(
      "ClickHouse TA tables must use ReplicatedReplacingMergeTree before TA sinks start: ${issues.joinToString(", ")}",
    )
  }
}

internal fun executeWithRetry(
  maxAttempts: Int,
  retryDelayMs: Long,
  strict: Boolean,
  logger: Logger,
  operationName: String,
  sleep: (Long) -> Unit = Thread::sleep,
  operation: () -> Unit,
) {
  val attempts = maxAttempts.coerceAtLeast(1)
  val delayMs = retryDelayMs.coerceAtLeast(0)
  var attempt = 1
  while (true) {
    try {
      operation()
      return
    } catch (ex: Exception) {
      if (attempt >= attempts) {
        val message = "Failed to ensure $operationName after $attempt attempts."
        if (strict) {
          logger.error("$message Aborting startup because strict mode is enabled.", ex)
          throw IllegalStateException(message, ex)
        }
        logger.error("$message Continuing startup because strict mode is disabled.", ex)
        return
      }

      logger.warn("$operationName init failed (attempt $attempt/$attempts); retrying in ${delayMs}ms.", ex)
      if (delayMs > 0) {
        sleep(delayMs)
      }
      attempt += 1
    }
  }
}

private fun clickhouseAdminUrl(url: String): String {
  val jdbcPrefix = "jdbc:"
  if (!url.startsWith(jdbcPrefix)) {
    return url
  }

  val raw = url.removePrefix(jdbcPrefix)
  return try {
    val uri = URI(raw)
    val scheme = uri.scheme
    val host = uri.host
    if (scheme == null || host == null) {
      url
    } else {
      val port = if (uri.port == -1) "" else ":${uri.port}"
      val filteredQuery =
        uri.rawQuery
          ?.split('&')
          ?.filter { it.isNotBlank() }
          ?.filterNot { it.startsWith("database=") || it.startsWith("db=") }
          ?.joinToString("&")
          ?.takeIf { it.isNotBlank() }
      val base = "jdbc:$scheme://$host$port/default"
      if (filteredQuery != null) "$base?$filteredQuery" else base
    }
  } catch (_: Exception) {
    url
  }
}

private fun configureEnvironment(
  env: StreamExecutionEnvironment,
  config: FlinkTaConfig,
) {
  env.setParallelism(config.parallelism)
  env.enableCheckpointing(config.checkpointIntervalMs)
  val checkpointConfig = env.checkpointConfig
  checkpointConfig.checkpointTimeout = config.checkpointTimeoutMs
  checkpointConfig.minPauseBetweenCheckpoints = config.minPauseBetweenCheckpointsMs
  env.config.setAutoWatermarkInterval(1_000)
}

private fun applyS3SystemProperties(config: FlinkTaConfig) {
  System.setProperty("fs.s3a.endpoint", config.s3Endpoint)
  System.setProperty("fs.s3a.path.style.access", config.s3PathStyle.toString())
  System.setProperty("fs.s3a.connection.ssl.enabled", config.s3Secure.toString())
  System.setProperty("fs.s3a.fast.upload", "true")
  config.s3AccessKey?.let { System.setProperty("fs.s3a.access.key", it) }
  config.s3SecretKey?.let { System.setProperty("fs.s3a.secret.key", it) }
}

private fun <T> watermarkStrategy(config: FlinkTaConfig): WatermarkStrategy<Envelope<T>> =
  WatermarkStrategy
    .forBoundedOutOfOrderness<Envelope<T>>(Duration.ofMillis(config.maxOutOfOrderMs))
    .withIdleness(Duration.ofMillis(config.watermarkIdleTimeoutMs))
    .withTimestampAssigner(SerializableTimestampAssigner<Envelope<T>> { event, _ -> event.eventTs.toEpochMilli() })

private fun <T> emptyWatermarks(): WatermarkStrategy<T> = WatermarkStrategy.noWatermarks()

internal fun emptyQuoteStream(env: StreamExecutionEnvironment) =
  env
    .fromData(
      emptyList<Envelope<QuotePayload>>(),
      TypeInformation.of(object : TypeHint<Envelope<QuotePayload>>() {}),
    ).assignTimestampsAndWatermarks(emptyWatermarks())

internal fun emptyBars1mStream(env: StreamExecutionEnvironment) =
  env
    .fromData(
      emptyList<Envelope<MicroBarPayload>>(),
      TypeInformation.of(object : TypeHint<Envelope<MicroBarPayload>>() {}),
    ).assignTimestampsAndWatermarks(emptyWatermarks())

private fun kafkaSource(
  config: FlinkTaConfig,
  topic: String,
): KafkaSource<String> = kafkaSource(config, topic, KafkaRecordDeserializationSchema.valueOnly(SimpleStringSchema()))

private fun <T> kafkaSource(
  config: FlinkTaConfig,
  topic: String,
  deserializer: KafkaRecordDeserializationSchema<T>,
): KafkaSource<T> {
  val offsetResetStrategy =
    when (config.autoOffsetReset.trim().lowercase()) {
      "earliest" -> OffsetResetStrategy.EARLIEST
      "latest" -> OffsetResetStrategy.LATEST
      "none" -> OffsetResetStrategy.NONE
      else -> OffsetResetStrategy.LATEST
    }

  val builder =
    KafkaSource
      .builder<T>()
      .setBootstrapServers(config.bootstrapServers)
      .setTopics(topic)
      .setClientIdPrefix(config.clientId)
      .setGroupId(config.groupId)
      .setDeserializer(deserializer)
      .setStartingOffsets(OffsetsInitializer.committedOffsets(offsetResetStrategy))

  builder.setProperty("auto.offset.reset", config.autoOffsetReset)
  builder.setProperty("isolation.level", "read_committed")
  builder.setProperty("enable.auto.commit", "false")
  applyKafkaSecurity(builder, config)
  return builder.build()
}

internal fun <T> applyKafkaSecurity(
  builder: KafkaSourceBuilder<T>,
  config: FlinkTaConfig,
) {
  builder.setProperty("security.protocol", config.securityProtocol)
  config.saslMechanism?.let { builder.setProperty("sasl.mechanism", it) }
  if (!config.saslUsername.isNullOrBlank() && !config.saslPassword.isNullOrBlank()) {
    val jaas = kafkaJaas(config)
    builder.setProperty("sasl.jaas.config", jaas)
  }
}

private fun microBarSink(
  config: FlinkTaConfig,
  serde: AvroSerde,
): KafkaSink<Envelope<MicroBarPayload>> {
  val sinkBuilder =
    KafkaSink
      .builder<Envelope<MicroBarPayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    sinkBuilder.setTransactionalIdPrefix("${config.clientId}-microbars")
    sinkBuilder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  sinkBuilder.setRecordSerializer(MicroBarSerializationSchema(config.microBarsTopic, serde))
  sinkBuilder.setKafkaSecurity(config)
  return sinkBuilder.build()
}

private fun signalSink(
  config: FlinkTaConfig,
  serde: AvroSerde,
): KafkaSink<Envelope<TaSignalsPayload>> {
  val sinkBuilder =
    KafkaSink
      .builder<Envelope<TaSignalsPayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    sinkBuilder.setTransactionalIdPrefix("${config.clientId}-signals")
    sinkBuilder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  sinkBuilder.setRecordSerializer(SignalSerializationSchema(config.signalsTopic, serde))
  sinkBuilder.setKafkaSecurity(config)
  return sinkBuilder.build()
}

private fun statusSink(
  config: FlinkTaConfig,
  serde: AvroSerde,
): KafkaSink<Envelope<TaStatusPayload>> {
  val topic = requireNotNull(config.statusTopic) { "TA_STATUS_TOPIC must be set to enable status sink." }
  val sinkBuilder =
    KafkaSink
      .builder<Envelope<TaStatusPayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    sinkBuilder.setTransactionalIdPrefix("${config.clientId}-status")
    sinkBuilder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  sinkBuilder.setRecordSerializer(StatusSerializationSchema(topic, serde))
  sinkBuilder.setKafkaSecurity(config)
  return sinkBuilder.build()
}

private fun clickhouseMicrobarSink(config: FlinkTaConfig): JdbcSink<Envelope<MicroBarPayload>> {
  val sql =
    """
    INSERT INTO ta_microbars (
      symbol,
      event_ts,
      seq,
      ingest_ts,
      is_final,
      source,
      window_size,
      window_step,
      window_start,
      window_end,
      version,
      o,
      h,
      l,
      c,
      v,
      vwap,
      count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()

  return JdbcSink
    .builder<Envelope<MicroBarPayload>>()
    .withQueryStatement(sql, microbarStatementBuilder())
    .withExecutionOptions(clickhouseExecutionOptions(config))
    .buildAtLeastOnce(clickhouseConnectionOptions(config))
}

private fun clickhouseSignalSink(config: FlinkTaConfig): JdbcSink<Envelope<TaSignalsPayload>> {
  val sql = clickhouseSignalsInsertSql()

  return JdbcSink
    .builder<Envelope<TaSignalsPayload>>()
    .withQueryStatement(sql, signalsStatementBuilder())
    .withExecutionOptions(clickhouseExecutionOptions(config))
    .buildAtLeastOnce(clickhouseConnectionOptions(config))
}

private fun clickhouseConnectionOptions(config: FlinkTaConfig): JdbcConnectionOptions {
  val url = requireNotNull(config.clickhouseUrl) { "TA_CLICKHOUSE_URL must be set when ClickHouse sinks are enabled." }
  val builder =
    JdbcConnectionOptions
      .JdbcConnectionOptionsBuilder()
      .withUrl(url)
      .withDriverName("com.clickhouse.jdbc.ClickHouseDriver")
      .withConnectionCheckTimeoutSeconds(config.clickhouseConnectionTimeoutSeconds)

  config.clickhouseUsername?.let { builder.withUsername(it) }
  config.clickhousePassword?.let { builder.withPassword(it) }

  return builder.build()
}

private fun clickhouseExecutionOptions(config: FlinkTaConfig): JdbcExecutionOptions =
  JdbcExecutionOptions
    .builder()
    .withBatchSize(config.clickhouseInsertBatchSize)
    .withBatchIntervalMs(config.clickhouseInsertFlushMs)
    .withMaxRetries(config.clickhouseInsertMaxRetries)
    .build()

private fun microbarStatementBuilder(): JdbcStatementBuilder<Envelope<MicroBarPayload>> =
  JdbcStatementBuilder { statement, envelope ->
    val payload = envelope.payload
    val window = envelope.window

    statement.setString(1, envelope.symbol)
    statement.setTimestamp(2, Timestamp.from(envelope.eventTs))
    statement.setLong(3, envelope.seq)
    statement.setTimestamp(4, Timestamp.from(envelope.ingestTs))
    statement.setInt(5, if (envelope.isFinal) 1 else 0)
    setNullableString(statement, 6, envelope.source)
    setNullableString(statement, 7, window?.size)
    setNullableString(statement, 8, window?.step)
    setNullableTimestamp(statement, 9, parseInstant(window?.start))
    setNullableTimestamp(statement, 10, parseInstant(window?.end))
    statement.setInt(11, envelope.version)
    statement.setDouble(12, payload.o)
    statement.setDouble(13, payload.h)
    statement.setDouble(14, payload.l)
    statement.setDouble(15, payload.c)
    statement.setDouble(16, payload.v)
    setNullableDouble(statement, 17, payload.vwap)
    statement.setLong(18, payload.count)
  }

private fun signalsStatementBuilder(): JdbcStatementBuilder<Envelope<TaSignalsPayload>> =
  JdbcStatementBuilder { statement, envelope ->
    val payload = envelope.payload
    val window = envelope.window

    statement.setString(1, envelope.symbol)
    statement.setTimestamp(2, Timestamp.from(envelope.eventTs))
    statement.setLong(3, envelope.seq)
    statement.setTimestamp(4, Timestamp.from(envelope.ingestTs))
    statement.setInt(5, if (envelope.isFinal) 1 else 0)
    setNullableString(statement, 6, envelope.source)
    setNullableString(statement, 7, window?.size)
    setNullableString(statement, 8, window?.step)
    setNullableTimestamp(statement, 9, parseInstant(window?.start))
    setNullableTimestamp(statement, 10, parseInstant(window?.end))
    statement.setInt(11, envelope.version)

    setNullableDouble(statement, 12, payload.macd?.macd)
    setNullableDouble(statement, 13, payload.macd?.signal)
    setNullableDouble(statement, 14, payload.macd?.hist)
    setNullableDouble(statement, 15, payload.ema?.ema12)
    setNullableDouble(statement, 16, payload.ema?.ema26)
    setNullableDouble(statement, 17, payload.rsi14)
    setNullableDouble(statement, 18, payload.boll?.mid)
    setNullableDouble(statement, 19, payload.boll?.upper)
    setNullableDouble(statement, 20, payload.boll?.lower)
    setNullableDouble(statement, 21, payload.vwap?.session)
    setNullableDouble(statement, 22, payload.vwap?.w5m)
    setNullableDouble(statement, 23, payload.imbalance?.spread)
    setNullableDouble(statement, 24, payload.imbalance?.bid_px)
    setNullableDouble(statement, 25, payload.imbalance?.ask_px)
    setNullableLong(statement, 26, payload.imbalance?.bid_sz?.toLong())
    setNullableLong(statement, 27, payload.imbalance?.ask_sz?.toLong())
    setNullableDouble(statement, 28, payload.vol_realized?.w60s)
    setNullableString(statement, 29, serializeMicrostructureSignalV1(payload.microstructureSignalV1))
  }

internal fun clickhouseSignalsInsertSql(): String =
  """
  INSERT INTO ta_signals (
    symbol,
    event_ts,
    seq,
    ingest_ts,
    is_final,
    source,
    window_size,
    window_step,
    window_start,
    window_end,
    version,
    macd,
    macd_signal,
    macd_hist,
    ema12,
    ema26,
    rsi14,
    boll_mid,
    boll_upper,
    boll_lower,
    vwap_session,
    vwap_w5m,
    imbalance_spread,
    imbalance_bid_px,
    imbalance_ask_px,
    imbalance_bid_sz,
    imbalance_ask_sz,
    vol_realized_w60s,
    microstructure_signal_v1
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  """.trimIndent()

private val microstructureSignalJson = Json { encodeDefaults = false }

internal fun serializeMicrostructureSignalV1(signal: MicrostructureSignalV1?): String? =
  signal?.let { microstructureSignalJson.encodeToString(it) }

private fun parseInstant(value: String?): Instant? = value?.let { runCatching { Instant.parse(it) }.getOrNull() }

private fun setNullableTimestamp(
  statement: PreparedStatement,
  index: Int,
  value: Instant?,
) {
  if (value == null) {
    statement.setNull(index, Types.TIMESTAMP)
  } else {
    statement.setTimestamp(index, Timestamp.from(value))
  }
}

private fun setNullableString(
  statement: PreparedStatement,
  index: Int,
  value: String?,
) {
  if (value == null) {
    statement.setNull(index, Types.VARCHAR)
  } else {
    statement.setString(index, value)
  }
}

private fun setNullableDouble(
  statement: PreparedStatement,
  index: Int,
  value: Double?,
) {
  val finite = value?.takeIf { !it.isNaN() && !it.isInfinite() }
  if (finite == null) {
    statement.setNull(index, Types.DOUBLE)
  } else {
    statement.setDouble(index, finite)
  }
}

private fun setNullableLong(
  statement: PreparedStatement,
  index: Int,
  value: Long?,
) {
  if (value == null) {
    statement.setNull(index, Types.BIGINT)
  } else {
    statement.setLong(index, value)
  }
}

internal class MicroBarSerializationSchema(
  private val topic: String,
  private val serde: AvroSerde,
) : KafkaRecordSerializationSchema<Envelope<MicroBarPayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<MicroBarPayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    val key = element.symbol.toByteArray(StandardCharsets.UTF_8)
    val value = serde.encodeMicroBar(element, topic)
    return ProducerRecord(topic, null, timestamp ?: System.currentTimeMillis(), key, value)
  }
}

internal class SignalSerializationSchema(
  private val topic: String,
  private val serde: AvroSerde,
) : KafkaRecordSerializationSchema<Envelope<TaSignalsPayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<TaSignalsPayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    val key = element.symbol.toByteArray(StandardCharsets.UTF_8)
    val value = serde.encodeSignals(element, topic)
    return ProducerRecord(topic, null, timestamp ?: System.currentTimeMillis(), key, value)
  }
}

internal class StatusSerializationSchema(
  private val topic: String,
  private val serde: AvroSerde,
) : KafkaRecordSerializationSchema<Envelope<TaStatusPayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<TaStatusPayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    val key = element.symbol.toByteArray(StandardCharsets.UTF_8)
    val value = serde.encodeStatus(element, topic)
    return ProducerRecord(topic, null, timestamp ?: System.currentTimeMillis(), key, value)
  }
}

internal fun interface SerializerFactory<T> : Serializable {
  fun serializer(): KSerializer<T>
}

internal class ParseEnvelopeFlatMap<T>(
  private val serializerFactory: SerializerFactory<T>,
  private val failureMetricName: String = "parse_envelope_failures",
) : RichFlatMapFunction<String, Envelope<T>>(),
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  @Transient
  private lateinit var json: Json

  @Transient
  private lateinit var payloadSerializer: KSerializer<T>

  @Transient
  private lateinit var failureCounter: Counter

  override fun open(openContext: OpenContext) {
    json = Json { ignoreUnknownKeys = true }
    payloadSerializer = serializerFactory.serializer()
    failureCounter = runtimeContext.metricGroup.counter(failureMetricName)
  }

  override fun flatMap(
    value: String,
    out: Collector<Envelope<T>>,
  ) {
    runCatching { json.decodeFromString(Envelope.serializer(payloadSerializer), value) }
      .onSuccess { out.collect(it) }
      .onFailure {
        failureCounter.inc()
        LoggerFactory.getLogger("parse-envelope").warn("Failed to decode envelope", it)
      }
  }
}

internal class ParseMicroBarCompatFlatMap :
  RichFlatMapFunction<String, Envelope<MicroBarPayload>>(),
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  @Transient
  private lateinit var json: Json

  @Transient
  private lateinit var microSerializer: KSerializer<MicroBarPayload>

  @Transient
  private lateinit var alpacaSerializer: KSerializer<AlpacaBarPayload>

  @Transient
  private lateinit var decodeFailureCounter: Counter

  @Transient
  private lateinit var mappingFailureCounter: Counter

  override fun open(openContext: OpenContext) {
    json = Json { ignoreUnknownKeys = true }
    microSerializer = MicroBarPayload.serializer()
    alpacaSerializer = AlpacaBarPayload.serializer()
    decodeFailureCounter = runtimeContext.metricGroup.counter("bars1m_parse_failures")
    mappingFailureCounter = runtimeContext.metricGroup.counter("bars1m_mapping_failures")
  }

  override fun flatMap(
    value: String,
    out: Collector<Envelope<MicroBarPayload>>,
  ) {
    val microResult = runCatching { json.decodeFromString(Envelope.serializer(microSerializer), value) }
    if (microResult.isSuccess) {
      out.collect(microResult.getOrThrow())
      return
    }

    val alpacaResult = runCatching { json.decodeFromString(Envelope.serializer(alpacaSerializer), value) }
    if (alpacaResult.isSuccess) {
      val alpacaEnv = alpacaResult.getOrThrow()
      runCatching { alpacaEnv.withPayload(alpacaEnv.payload.toMicroBarPayload()) }
        .onSuccess { out.collect(it) }
        .onFailure {
          mappingFailureCounter.inc()
          LoggerFactory.getLogger("parse-bars1m").warn("Failed to map Alpaca bar payload", it)
        }
      return
    }

    decodeFailureCounter.inc()
    val logger = LoggerFactory.getLogger("parse-bars1m")
    val microError = microResult.exceptionOrNull()
    val alpacaError = alpacaResult.exceptionOrNull()
    val combined = alpacaError ?: microError
    if (combined != null && microError != null && microError !== combined) {
      combined.addSuppressed(microError)
    }
    if (combined != null) {
      logger.warn("Failed to decode bars1m envelope", combined)
    } else {
      logger.warn("Failed to decode bars1m envelope (unknown error)")
    }
  }
}

internal fun <T> KafkaSinkBuilder<T>.setKafkaSecurity(config: FlinkTaConfig): KafkaSinkBuilder<T> {
  setProperty("security.protocol", config.securityProtocol)
  config.saslMechanism?.let { setProperty("sasl.mechanism", it) }
  if (!config.saslUsername.isNullOrBlank() && !config.saslPassword.isNullOrBlank()) {
    val jaas = kafkaJaas(config)
    setProperty("sasl.jaas.config", jaas)
  }
  setProperty("enable.idempotence", "true")
  setProperty("acks", "all")
  return this
}

private fun kafkaJaas(config: FlinkTaConfig): String {
  val username = requireNotNull(config.saslUsername) { "saslUsername missing" }
  val password = requireNotNull(config.saslPassword) { "saslPassword missing" }
  return buildString {
    append("org.apache.kafka.common.security.scram.ScramLoginModule required ")
    append("username=\"")
    append(username)
    append("\" password=\"")
    append(password)
    append("\";")
  }
}

private typealias MicroBarEnvelope = Envelope<MicroBarPayload>

internal class MicrobarProcessFunction : KeyedProcessFunction<String, RecordedTrade, MicroBarEnvelope>() {
  private lateinit var legacyBucket: ValueState<BucketState>
  private lateinit var buckets: MapState<Long, EventTimeTradeBucket>
  private lateinit var seqState: ValueState<Long>
  private lateinit var late: Counter
  private lateinit var discardedLegacy: Counter

  override fun open(openContext: OpenContext) {
    legacyBucket = runtimeContext.getState(ValueStateDescriptor("bucket", BucketState::class.java))
    buckets = runtimeContext.getMapState(MapStateDescriptor("event-time-buckets-v2", Long::class.java, EventTimeTradeBucket::class.java))
    seqState = runtimeContext.getState(ValueStateDescriptor("seq", Long::class.java))
    late = runtimeContext.metricGroup.counter("microbar_late_trades_total")
    discardedLegacy = runtimeContext.metricGroup.counter("microbar_legacy_buckets_discarded_total")
  }

  private fun retireLegacyBucket() {
    // The old aggregate cannot recover event-time ordering or source identities.
    if (legacyBucket.value() != null) {
      discardedLegacy.inc()
      legacyBucket.clear()
    }
  }

  override fun processElement(
    value: RecordedTrade,
    ctx: Context,
    out: Collector<MicroBarEnvelope>,
  ) {
    retireLegacyBucket()
    val windowEnd = Math.multiplyExact(Math.addExact(value.envelope.payload.t.epochSecond, 1), 1_000L)
    if (windowEnd <= ctx.timerService().currentWatermark()) {
      late.inc()
      ctx.output(lateTradeOutput, value)
      LoggerFactory.getLogger("microbars").warn(
        "Quarantined late trade topic={} partition={} offset={} windowEnd={} watermark={}",
        value.topic,
        value.partition,
        value.offset,
        windowEnd,
        ctx.timerService().currentWatermark(),
      )
      return
    }
    buckets.put(windowEnd, (buckets.get(windowEnd) ?: EventTimeTradeBucket()).add(value))
    ctx.timerService().registerEventTimeTimer(windowEnd)
  }

  override fun onTimer(
    timestamp: Long,
    ctx: OnTimerContext,
    out: Collector<MicroBarEnvelope>,
  ) {
    retireLegacyBucket()
    val bucket = buckets.get(timestamp) ?: return
    val payload = bucket.payload()
    val input = bucket.trades.first().envelope
    val seq = (seqState.value() ?: 0L) + 1
    seqState.update(seq)
    out.collect(
      input
        .withPayload(
          payload,
          window = Window("PT1S", "PT1S", payload.t.minusSeconds(1).toString(), payload.t.toString()),
          seqOverride = seq,
        ).copy(
          ingestTs = Instant.ofEpochMilli(ctx.timerService().currentProcessingTime()),
          eventTs = payload.t,
          source = "ta",
          isFinal = true,
          version = 2,
        ),
    )
    buckets.remove(timestamp)
  }

  companion object {
    val lateTradeOutput =
      org.apache.flink.util
        .OutputTag("microbar-late-trades-v2", TypeInformation.of(RecordedTrade::class.java))
  }
}

private class StatusHeartbeatProcessFunction(
  private val intervalMs: Long,
  private val clickhouseSinkEnabled: Boolean,
  private val sourceLagDegradedAfterMs: Long,
  private val marketHolidays: Set<LocalDate>,
) : KeyedProcessFunction<String, StatusHeartbeatInput, Envelope<TaStatusPayload>>() {
  private lateinit var lastInputEventMsState: ValueState<Long>
  private lateinit var lastOutputEventMsState: ValueState<Long>
  private lateinit var inputEventCountState: ValueState<Long>
  private lateinit var outputEventCountState: ValueState<Long>
  private lateinit var lastHeartbeatInputCountState: ValueState<Long>
  private lateinit var lastHeartbeatOutputCountState: ValueState<Long>
  private lateinit var lastHeartbeatMsState: ValueState<Long>
  private lateinit var perSymbolLatestEventMsState: MapState<String, Long>
  private lateinit var seqState: ValueState<Long>
  private lateinit var nextTimerState: ValueState<Long>

  override fun open(openContext: OpenContext) {
    lastInputEventMsState =
      runtimeContext.getState(ValueStateDescriptor("status-last-event-ms", Long::class.javaObjectType))
    lastOutputEventMsState =
      runtimeContext.getState(ValueStateDescriptor("status-last-output-event-ms", Long::class.javaObjectType))
    inputEventCountState =
      runtimeContext.getState(ValueStateDescriptor("status-event-count", Long::class.javaObjectType))
    outputEventCountState =
      runtimeContext.getState(ValueStateDescriptor("status-output-event-count", Long::class.javaObjectType))
    lastHeartbeatInputCountState =
      runtimeContext.getState(ValueStateDescriptor("status-last-heartbeat-event-count", Long::class.javaObjectType))
    lastHeartbeatOutputCountState =
      runtimeContext.getState(ValueStateDescriptor("status-last-heartbeat-output-count", Long::class.javaObjectType))
    lastHeartbeatMsState =
      runtimeContext.getState(ValueStateDescriptor("status-last-heartbeat-ms", Long::class.javaObjectType))
    perSymbolLatestEventMsState =
      runtimeContext.getMapState(
        MapStateDescriptor(
          "status-per-symbol-latest-event-ms",
          String::class.java,
          Long::class.javaObjectType,
        ),
      )
    seqState = runtimeContext.getState(ValueStateDescriptor("status-seq", Long::class.javaObjectType))
    nextTimerState = runtimeContext.getState(ValueStateDescriptor("status-next-timer-ms", Long::class.javaObjectType))
  }

  override fun processElement(
    value: StatusHeartbeatInput,
    ctx: Context,
    out: Collector<Envelope<TaStatusPayload>>,
  ) {
    when (value) {
      is StatusHeartbeatInput.MicroBar -> {
        recordInputEvent(value.envelope.symbol, value.envelope.eventTs.toEpochMilli())
        scheduleTimerIfNeeded(ctx)
      }
      is StatusHeartbeatInput.Signal -> {
        recordOutputEvent(value.envelope.symbol, value.envelope.eventTs.toEpochMilli())
        scheduleTimerIfNeeded(ctx)
      }
      is StatusHeartbeatInput.StartupTick -> {
        emitHeartbeat(
          now = Instant.now(),
          watermark = ctx.timerService().currentWatermark(),
          out = out,
        )
        scheduleTimerIfNeeded(ctx)
      }
    }
  }

  private fun recordInputEvent(
    symbol: String,
    eventMs: Long,
  ) {
    val last = lastInputEventMsState.value()
    if (last == null || eventMs > last) {
      lastInputEventMsState.update(eventMs)
    }
    recordPerSymbolLatest(symbol, eventMs)
    inputEventCountState.update((inputEventCountState.value() ?: 0L) + 1L)
  }

  private fun recordOutputEvent(
    symbol: String,
    eventMs: Long,
  ) {
    val last = lastOutputEventMsState.value()
    if (last == null || eventMs > last) {
      lastOutputEventMsState.update(eventMs)
    }
    recordPerSymbolLatest(symbol, eventMs)
    outputEventCountState.update((outputEventCountState.value() ?: 0L) + 1L)
  }

  private fun recordPerSymbolLatest(
    symbol: String,
    eventMs: Long,
  ) {
    val symbolLast = perSymbolLatestEventMsState.get(symbol)
    if (symbolLast == null || eventMs > symbolLast) {
      perSymbolLatestEventMsState.put(symbol, eventMs)
    }
  }

  override fun onTimer(
    timestamp: Long,
    ctx: OnTimerContext,
    out: Collector<Envelope<TaStatusPayload>>,
  ) {
    val next = nextStatusHeartbeatTimer(timestamp, nextTimerState.value(), intervalMs) ?: return
    emitHeartbeat(
      now = Instant.now(),
      watermark = ctx.timerService().currentWatermark(),
      out = out,
    )
    ctx.timerService().registerProcessingTimeTimer(next)
    nextTimerState.update(next)
  }

  private fun emitHeartbeat(
    now: Instant,
    watermark: Long,
    out: Collector<Envelope<TaStatusPayload>>,
  ) {
    val lastInputEventMs = lastInputEventMsState.value()
    val lastOutputEventMs = lastOutputEventMsState.value()
    val inputEventCount = inputEventCountState.value() ?: 0L
    val outputEventCount = outputEventCountState.value() ?: 0L
    val lastHeartbeatInputCount = lastHeartbeatInputCountState.value() ?: 0L
    val lastHeartbeatOutputCount = lastHeartbeatOutputCountState.value() ?: 0L
    val lastHeartbeatMs = lastHeartbeatMsState.value()
    val perSymbolLatestEventTs =
      perSymbolLatestEventMsState
        .entries()
        .associate { (symbol, eventMs) -> symbol to Instant.ofEpochMilli(eventMs).toString() }
    val payload =
      taStatusPayload(
        now = now,
        watermark = watermark,
        lastInputEventMs = lastInputEventMs,
        lastOutputEventMs = lastOutputEventMs,
        inputEventCount = inputEventCount,
        outputEventCount = outputEventCount,
        lastHeartbeatInputCount = lastHeartbeatInputCount,
        lastHeartbeatOutputCount = lastHeartbeatOutputCount,
        lastHeartbeatMs = lastHeartbeatMs,
        perSymbolLatestEventTs = perSymbolLatestEventTs,
        clickhouseSinkEnabled = clickhouseSinkEnabled,
        sourceLagDegradedAfterMs = sourceLagDegradedAfterMs,
        marketHolidays = marketHolidays,
      )
    lastHeartbeatInputCountState.update(inputEventCount)
    lastHeartbeatOutputCountState.update(outputEventCount)
    lastHeartbeatMsState.update(now.toEpochMilli())
    val seq = (seqState.value() ?: 0L) + 1
    seqState.update(seq)
    val envelope =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "ta",
        channel = "status",
        symbol = STATUS_SYMBOL,
        seq = seq,
        payload = payload,
        isFinal = true,
        source = "ta",
        window = null,
        version = 1,
      )
    out.collect(envelope)
  }

  private fun scheduleTimerIfNeeded(ctx: Context) {
    val current = nextTimerState.value()
    val now = ctx.timerService().currentProcessingTime()
    if (current == null || current <= now) {
      val next = now + intervalMs
      ctx.timerService().registerProcessingTimeTimer(next)
      nextTimerState.update(next)
    }
  }
}

internal fun nextStatusHeartbeatTimer(
  firedTimestamp: Long,
  scheduledTimestamp: Long?,
  intervalMs: Long,
): Long? =
  if (firedTimestamp == scheduledTimestamp) {
    firedTimestamp + intervalMs
  } else {
    null
  }

internal fun taStatusPayload(
  now: Instant,
  watermark: Long,
  lastInputEventMs: Long?,
  lastOutputEventMs: Long?,
  inputEventCount: Long,
  outputEventCount: Long,
  lastHeartbeatInputCount: Long,
  lastHeartbeatOutputCount: Long,
  lastHeartbeatMs: Long?,
  perSymbolLatestEventTs: Map<String, String>,
  clickhouseSinkEnabled: Boolean = false,
  sourceLagDegradedAfterMs: Long = DEFAULT_TA_SOURCE_LAG_DEGRADED_AFTER_MS,
  marketHolidays: Set<LocalDate> = emptySet(),
): TaStatusPayload {
  val nowMs = now.toEpochMilli()
  val watermarkLagMs =
    if (watermark == Long.MIN_VALUE) {
      null
    } else {
      (nowMs - watermark).coerceAtLeast(0)
    }
  val inputRatePerSecond =
    ratePerSecond(
      nowMs = nowMs,
      lastHeartbeatMs = lastHeartbeatMs,
      currentCount = inputEventCount,
      previousCount = lastHeartbeatInputCount,
    )
  val currentInputEventCount = deltaSinceLastHeartbeat(inputEventCount, lastHeartbeatInputCount)
  val currentOutputEventCount = deltaSinceLastHeartbeat(outputEventCount, lastHeartbeatOutputCount)
  val currentRecordCount = currentInputEventCount + currentOutputEventCount
  val lastEventMs = maxOfNullable(lastInputEventMs, lastOutputEventMs)
  val sourceLagMs = lastEventMs?.let { (nowMs - it).coerceAtLeast(0) }
  val outputRatePerSecond =
    ratePerSecond(
      nowMs = nowMs,
      lastHeartbeatMs = lastHeartbeatMs,
      currentCount = outputEventCount,
      previousCount = lastHeartbeatOutputCount,
    )
  val marketSessionState = marketSessionState(now, marketHolidays)
  val statusReason =
    if (marketSessionState != MARKET_SESSION_REGULAR) {
      null
    } else if (sourceLagMs == null) {
      SOURCE_LAG_MISSING_REASON
    } else if (sourceLagMs > sourceLagDegradedAfterMs) {
      SOURCE_LAG_STALE_REASON
    } else if (currentRecordCount == 0L) {
      ZERO_CURRENT_RECORDS_REASON
    } else {
      null
    }
  val status = if (statusReason == null) "ok" else "degraded"
  val lastEventTs = lastEventMs?.let { Instant.ofEpochMilli(it).toString() }
  val lastInputEventTs = lastInputEventMs?.let { Instant.ofEpochMilli(it).toString() }
  val lastOutputEventTs = lastOutputEventMs?.let { Instant.ofEpochMilli(it).toString() }
  return TaStatusPayload(
    watermarkLagMs = watermarkLagMs,
    sourceLagMs = sourceLagMs,
    lastEventTs = lastEventTs,
    lastInputEventTs = lastInputEventTs,
    lastOutputEventTs = lastOutputEventTs,
    inputEventCount = inputEventCount,
    outputEventCount = outputEventCount,
    currentInputEventCount = currentInputEventCount,
    currentOutputEventCount = currentOutputEventCount,
    currentRecordCount = currentRecordCount,
    inputRatePerSecond = inputRatePerSecond,
    outputRatePerSecond = outputRatePerSecond,
    microbarEventCount = inputEventCount,
    signalEventCount = outputEventCount,
    microbarRatePerSecond = inputRatePerSecond,
    signalRatePerSecond = outputRatePerSecond,
    clickhouseSinkEnabled = clickhouseSinkEnabled,
    perSymbolLatestEventTs = perSymbolLatestEventTs,
    marketSessionState = marketSessionState,
    statusReason = statusReason,
    status = status,
    heartbeat = true,
  )
}

private fun deltaSinceLastHeartbeat(
  currentCount: Long,
  previousCount: Long,
): Long = (currentCount - previousCount).coerceAtLeast(0)

private fun marketSessionState(
  now: Instant,
  marketHolidays: Set<LocalDate> = emptySet(),
): String {
  val local = now.atZone(EQUITY_MARKET_ZONE)
  val day = local.dayOfWeek.value
  val time = local.toLocalTime()
  val isRegularSession =
    local.toLocalDate() !in marketHolidays &&
      day in 1..5 &&
      !time.isBefore(REGULAR_SESSION_OPEN) &&
      time.isBefore(REGULAR_SESSION_CLOSE)
  return if (isRegularSession) {
    MARKET_SESSION_REGULAR
  } else {
    MARKET_SESSION_OUTSIDE_REGULAR
  }
}

private fun ratePerSecond(
  nowMs: Long,
  lastHeartbeatMs: Long?,
  currentCount: Long,
  previousCount: Long,
): Double? =
  if (lastHeartbeatMs == null || nowMs <= lastHeartbeatMs) {
    null
  } else {
    val elapsedSeconds = (nowMs - lastHeartbeatMs).toDouble() / 1_000.0
    (currentCount - previousCount).coerceAtLeast(0).toDouble() / elapsedSeconds
  }

private fun maxOfNullable(
  first: Long?,
  second: Long?,
): Long? =
  when {
    first == null -> second
    second == null -> first
    else -> maxOf(first, second)
  }

internal data class BucketState(
  val windowStartMillis: Long,
  val windowEndMillis: Long,
  var open: Double,
  var high: Double,
  var low: Double,
  var close: Double,
  var volume: Double,
  var vwapNumerator: Double,
  var count: Long,
) : Serializable {
  fun update(trade: TradePayload) {
    high = kotlin.math.max(high, trade.p)
    low = kotlin.math.min(low, trade.p)
    close = trade.p
    volume += trade.s
    vwapNumerator += trade.p * trade.s
    count += 1
  }

  fun toPayload(): MicroBarPayload {
    val vwap = if (volume == 0.0) null else vwapNumerator / volume
    val end = Instant.ofEpochMilli(windowEndMillis)
    return MicroBarPayload(
      o = open,
      h = high,
      l = low,
      c = close,
      v = volume,
      vwap = vwap,
      count = count,
      t = end,
    )
  }

  companion object {
    fun fromTrade(
      windowStartMillis: Long,
      windowEndMillis: Long,
      trade: TradePayload,
    ): BucketState =
      BucketState(
        windowStartMillis = windowStartMillis,
        windowEndMillis = windowEndMillis,
        open = trade.p,
        high = trade.p,
        low = trade.p,
        close = trade.p,
        volume = trade.s,
        vwapNumerator = trade.p * trade.s,
        count = 1,
      )
  }
}

internal class TaSignalsFunction(
  private val config: FlinkTaConfig,
  private val barDuration: Duration,
  private val timestampAnchor: SignalBarTimestampAnchor,
  private val resetLegacyOneSecondState: Boolean,
) : KeyedCoProcessFunction<String, Envelope<MicroBarPayload>, Envelope<QuotePayload>, Envelope<TaSignalsPayload>>() {
  private lateinit var barsState: ListState<MicroBarPayload>
  private lateinit var quoteState: ValueState<TimedQuoteState>
  private lateinit var sessionState: ValueState<SessionAccumulatorState>
  private lateinit var canonicalBars: MapState<String, CanonicalSignalBar>
  private lateinit var sessionDate: ValueState<String>
  private lateinit var accumulator: ValueState<IndicatorAccumulator>
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    val names = signalStateDescriptorNames(barDuration, timestampAnchor, resetLegacyOneSecondState)
    barsState = runtimeContext.getListState(ListStateDescriptor(names.bars, TypeInformation.of(MicroBarPayload::class.java)))
    quoteState = runtimeContext.getState(ValueStateDescriptor(names.quote, TimedQuoteState::class.java))
    sessionState = runtimeContext.getState(ValueStateDescriptor(names.session, SessionAccumulatorState::class.java))
    val namespace = "canonical-v3-${signalStateNamespace(barDuration, timestampAnchor)}"
    canonicalBars = runtimeContext.getMapState(MapStateDescriptor("$namespace-bars", String::class.java, CanonicalSignalBar::class.java))
    sessionDate = runtimeContext.getState(ValueStateDescriptor("$namespace-date", String::class.java))
    accumulator = runtimeContext.getState(ValueStateDescriptor("$namespace-indicators", IndicatorAccumulator::class.java))
    rejected = runtimeContext.metricGroup.counter("signal_bar_rejections_total")
  }

  override fun processElement1(
    value: Envelope<MicroBarPayload>,
    ctx: Context,
    out: Collector<Envelope<TaSignalsPayload>>,
  ) {
    if (!value.isFinal) return
    val retainedBars = maxOf(61, signalHistoryLimit(config.vwapWindow, config.realizedVolWindow, barDuration))
    try {
      advanceIndicators(IndicatorAccumulator(), value.payload, barDuration, retainedBars)
    } catch (error: IllegalArgumentException) {
      rejected.inc()
      LoggerFactory.getLogger("ta-signals").warn("Rejected indicator bar symbol={} reason={}", value.symbol, error.message)
      return
    }
    val start = signalBarEndTime(value.payload.t, barDuration, timestampAnchor).minus(barDuration)
    val date = start.atZone(ZoneId.of("America/New_York")).toLocalDate().toString()
    val previousDate = sessionDate.value()
    if (previousDate != null && date < previousDate) return
    if (date != previousDate) {
      canonicalBars.clear()
      accumulator.clear()
      sessionDate.update(date)
      // Legacy retained bars cannot establish the original recursive seed or session totals.
      barsState.clear()
      sessionState.clear()
    }
    val key = value.payload.t.toString()
    val existing = canonicalBars.get(key)
    if (existing != null) {
      val revision =
        compareValues(value.ingestTs, existing.envelope.ingestTs).takeIf { it != 0 }
          ?: compareValues(value.seq, existing.envelope.seq)
      if (revision < 0) return
      if (revision == 0) {
        if (value.payload != existing.envelope.payload) rejected.inc()
        return
      }
    }
    val canonical = CanonicalSignalBar(value, if (existing == null) quoteState.value() else existing.quote)
    canonicalBars.put(key, canonical)
    if (existing?.envelope?.payload == value.payload) return
    val previous = accumulator.value() ?: IndicatorAccumulator()
    val latest = previous.recent.lastOrNull()
    if (latest == null || value.payload.t.isAfter(latest.t)) {
      val next = advanceIndicators(previous, value.payload, barDuration, retainedBars)
      accumulator.update(next)
      out.collect(computeSignals(canonical, next, ctx.timerService().currentProcessingTime()))
    } else {
      var next = IndicatorAccumulator()
      for (bar in canonicalBars.values().toList().sortedBy { it.envelope.payload.t }) {
        next = advanceIndicators(next, bar.envelope.payload, barDuration, retainedBars)
        if (!bar.envelope.payload.t
            .isBefore(value.payload.t)
        ) {
          out.collect(computeSignals(bar, next, ctx.timerService().currentProcessingTime()))
        }
      }
      accumulator.update(next)
    }
  }

  override fun processElement2(
    value: Envelope<QuotePayload>,
    ctx: Context,
    out: Collector<Envelope<TaSignalsPayload>>,
  ) {
    val current = quoteState.value()
    if (quoteStateAccepts(current, value.eventTs)) {
      quoteState.update(TimedQuoteState(eventTs = value.eventTs, payload = value.payload))
    }
  }

  private fun computeSignals(
    canonical: CanonicalSignalBar,
    state: IndicatorAccumulator,
    computedAtMs: Long,
  ): Envelope<TaSignalsPayload> {
    val envelope = canonical.envelope
    val bars = state.recent
    val macdVal = state.ema12 - state.ema26
    val rsiVal = indicatorRsi(state)
    val boll = indicatorBollinger(state, barDuration)
    val vwapSession = if (state.volume > 0) state.closeVolume / state.volume else null
    val vwap5m = rollingSignalVwap(bars, config.vwapWindow, barDuration, timestampAnchor)
    val realizedVol = indicatorVolatility(state, realizedVolWindowBars(config.realizedVolWindow, barDuration), barDuration)

    val barEndTime = signalBarEndTime(envelope.payload.t, barDuration, timestampAnchor)
    val quote = freshQuotePayloadForBar(canonical.quote, barEndTime, config.quoteStaleAfterMs)
    val imbalance =
      quote?.let {
        val spread = it.ap - it.bp
        ai.proompteng.dorvud.ta.stream.Imbalance(
          spread = spread,
          bid_px = it.bp,
          ask_px = it.ap,
          bid_sz = it.bs,
          ask_sz = it.`as`,
        )
      }

    val payload =
      TaSignalsPayload(
        macd =
          if (state.count >= 34 &&
            state.contiguous
          ) {
            ai.proompteng.dorvud.ta.stream
              .Macd(macdVal, state.macdSignal, macdVal - state.macdSignal)
          } else {
            null
          },
        ema =
          if (state.count >= 26 && state.contiguous) {
            ai.proompteng.dorvud.ta.stream
              .Ema(state.ema12, state.ema26)
          } else {
            null
          },
        rsi14 = rsiVal,
        boll = boll,
        vwap =
          vwapSession?.let {
            ai.proompteng.dorvud.ta.stream
              .Vwap(session = it, w5m = vwap5m)
          },
        imbalance = imbalance,
        vol_realized =
          realizedVol?.let {
            ai.proompteng.dorvud.ta.stream
              .RealizedVol(it)
          },
      )

    val window = envelope.window ?: fallbackSignalWindow(envelope.payload.t, barDuration, timestampAnchor)
    return envelope
      .withPayload(payload, window = window, seqOverride = envelope.seq)
      .copy(source = taSignalOutputSource(envelope.source), ingestTs = Instant.ofEpochMilli(computedAtMs), version = 2)
  }
}

internal data class CanonicalSignalBar(
  val envelope: Envelope<MicroBarPayload>,
  val quote: TimedQuoteState?,
) : Serializable

internal enum class SignalBarTimestampAnchor {
  START,
  END,
}

internal data class SignalStateDescriptorNames(
  val bars: String,
  val quote: String,
  val session: String,
)

internal fun signalStateDescriptorNames(
  barDuration: Duration,
  timestampAnchor: SignalBarTimestampAnchor,
  resetLegacyOneSecondState: Boolean,
): SignalStateDescriptorNames {
  val isLegacyOneSecondBranch =
    barDuration == Duration.ofSeconds(1) &&
      timestampAnchor == SignalBarTimestampAnchor.END
  if (isLegacyOneSecondBranch && !resetLegacyOneSecondState) {
    return SignalStateDescriptorNames(
      bars = "bars",
      quote = "quote-timed-v1",
      session = "session",
    )
  }

  val namespace = signalStateNamespace(barDuration, timestampAnchor)
  return SignalStateDescriptorNames(
    bars = "bars-$namespace",
    quote = "quote-timed-$namespace",
    session = "session-$namespace",
  )
}

internal fun signalStateNamespace(
  barDuration: Duration,
  timestampAnchor: SignalBarTimestampAnchor,
): String {
  require(!barDuration.isZero && !barDuration.isNegative) { "barDuration must be positive" }
  val durationToken = barDuration.toString().lowercase()
  return "v2-$durationToken-${timestampAnchor.name.lowercase()}"
}

internal fun signalBarEndTime(
  timestamp: Instant,
  barDuration: Duration,
  timestampAnchor: SignalBarTimestampAnchor,
): Instant =
  when (timestampAnchor) {
    SignalBarTimestampAnchor.START -> timestamp.plus(barDuration)
    SignalBarTimestampAnchor.END -> timestamp
  }

internal fun fallbackSignalWindow(
  timestamp: Instant,
  barDuration: Duration,
  timestampAnchor: SignalBarTimestampAnchor,
): Window {
  val start =
    when (timestampAnchor) {
      SignalBarTimestampAnchor.START -> timestamp
      SignalBarTimestampAnchor.END -> timestamp.minus(barDuration)
    }
  val end = signalBarEndTime(timestamp, barDuration, timestampAnchor)
  return Window(
    size = barDuration.toString(),
    step = barDuration.toString(),
    start = start.toString(),
    end = end.toString(),
  )
}

internal fun signalHistoryLimit(
  vwapWindow: Duration,
  realizedVolWindow: Int,
  barDuration: Duration,
): Int {
  require(!barDuration.isZero && !barDuration.isNegative) { "barDuration must be positive" }
  val realizedVolBars = realizedVolWindowBars(realizedVolWindow, barDuration)
  val vwapBars =
    kotlin.math
      .ceil(vwapWindow.toMillis().toDouble() / barDuration.toMillis().toDouble())
      .toInt()
  return maxOf(realizedVolBars + 5, vwapBars + 60)
}

internal fun realizedVolWindowBars(
  windowSeconds: Int,
  barDuration: Duration,
): Int {
  require(windowSeconds > 0) { "windowSeconds must be positive" }
  require(!barDuration.isZero && !barDuration.isNegative) { "barDuration must be positive" }
  val windowMillis = Duration.ofSeconds(windowSeconds.toLong()).toMillis()
  return kotlin.math
    .ceil(windowMillis.toDouble() / barDuration.toMillis().toDouble())
    .toInt()
    .coerceAtLeast(1)
}

internal fun rollingSignalVwap(
  bars: List<MicroBarPayload>,
  window: Duration,
  barDuration: Duration,
  timestampAnchor: SignalBarTimestampAnchor,
): Double? {
  val currentEnd =
    bars.lastOrNull()?.let { bar ->
      signalBarEndTime(bar.t, barDuration, timestampAnchor)
    } ?: return null
  val cutoff = currentEnd.minus(window)
  var priceVolume = 0.0
  var volume = 0.0

  bars.forEach { bar ->
    val barEnd = signalBarEndTime(bar.t, barDuration, timestampAnchor)
    if (!barEnd.isAfter(cutoff) || barEnd.isAfter(currentEnd)) return@forEach
    priceVolume += bar.c * bar.v
    volume += bar.v
  }

  return if (volume == 0.0) null else priceVolume / volume
}

internal fun taSignalOutputSource(inputSource: String): String =
  when (inputSource.lowercase()) {
    "ta", "ws" -> "ta"
    else -> inputSource
  }

data class TimedQuoteState(
  val eventTs: Instant,
  val payload: QuotePayload,
) : Serializable

internal fun quoteStateAccepts(
  current: TimedQuoteState?,
  incomingEventTs: Instant,
): Boolean = current == null || incomingEventTs.isAfter(current.eventTs)

internal fun freshQuotePayloadForBar(
  quote: TimedQuoteState?,
  barTs: Instant,
  quoteStaleAfterMs: Long,
): QuotePayload? =
  if (quote != null && isQuoteFreshForBar(quote.eventTs, barTs, quoteStaleAfterMs)) {
    quote.payload
  } else {
    null
  }

internal fun isQuoteFreshForBar(
  quoteTs: Instant,
  barTs: Instant,
  quoteStaleAfterMs: Long,
): Boolean {
  if (quoteTs.isAfter(barTs)) return false
  if (quoteStaleAfterMs <= 0) return true
  return Duration.between(quoteTs, barTs).toMillis() <= quoteStaleAfterMs
}

data class SessionAccumulatorState(
  var pv: Double = 0.0,
  var vol: Double = 0.0,
) : Serializable {
  fun value(): Double = if (vol == 0.0) 0.0 else pv / vol
}
