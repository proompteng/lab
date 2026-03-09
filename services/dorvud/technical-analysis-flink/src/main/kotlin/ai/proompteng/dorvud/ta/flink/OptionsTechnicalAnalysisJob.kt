package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.producer.OptionsAvroSerde
import ai.proompteng.dorvud.ta.stream.OptionsContractBarPayload
import ai.proompteng.dorvud.ta.stream.OptionsContractFeaturePayload
import ai.proompteng.dorvud.ta.stream.OptionsQuotePayload
import ai.proompteng.dorvud.ta.stream.OptionsSnapshotPayload
import ai.proompteng.dorvud.ta.stream.OptionsSurfaceFeaturePayload
import ai.proompteng.dorvud.ta.stream.OptionsTaStatusPayload
import ai.proompteng.dorvud.ta.stream.OptionsTradePayload
import ai.proompteng.dorvud.ta.stream.parseOptionsContractIdentity
import kotlinx.serialization.builtins.serializer
import org.apache.flink.api.common.eventtime.SerializableTimestampAssigner
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
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
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.functions.KeyedProcessFunction
import org.apache.flink.util.Collector
import org.apache.kafka.clients.consumer.OffsetResetStrategy
import org.apache.kafka.clients.producer.ProducerRecord
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.io.Serializable
import java.net.URI
import java.nio.charset.StandardCharsets
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.Timestamp
import java.sql.Types
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.Properties
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sqrt

private const val OPTIONS_TA_STATUS_SYMBOL = "options-ta"

fun main() {
  val config = OptionsTaConfig.fromEnv()
  val serde = OptionsAvroSerde()
  applyOptionsS3SystemProperties(config)
  val env = StreamExecutionEnvironment.getExecutionEnvironment()

  configureOptionsEnvironment(env, config)

  val trades =
    env
      .fromSource(
        optionsKafkaSource(config, config.tradesTopic),
        WatermarkStrategy.noWatermarks(),
        "options-ta-trades-source",
      ).flatMap(ParseEnvelopeFlatMap(SerializerFactory { OptionsTradePayload.serializer() }))
      .returns(object : TypeHint<Envelope<OptionsTradePayload>>() {})
      .map { OptionsInput(trade = it) }
      .returns(object : TypeHint<OptionsInput>() {})

  val quotes =
    env
      .fromSource(
        optionsKafkaSource(config, config.quotesTopic),
        WatermarkStrategy.noWatermarks(),
        "options-ta-quotes-source",
      ).flatMap(ParseEnvelopeFlatMap(SerializerFactory { OptionsQuotePayload.serializer() }))
      .returns(object : TypeHint<Envelope<OptionsQuotePayload>>() {})
      .map { OptionsInput(quote = it) }
      .returns(object : TypeHint<OptionsInput>() {})

  val snapshots =
    env
      .fromSource(
        optionsKafkaSource(config, config.snapshotsTopic),
        WatermarkStrategy.noWatermarks(),
        "options-ta-snapshots-source",
      ).flatMap(ParseEnvelopeFlatMap(SerializerFactory { OptionsSnapshotPayload.serializer() }))
      .returns(object : TypeHint<Envelope<OptionsSnapshotPayload>>() {})
      .map { OptionsInput(snapshot = it) }
      .returns(object : TypeHint<OptionsInput>() {})

  val inputs =
    trades
      .union(quotes, snapshots)
      .assignTimestampsAndWatermarks(
        WatermarkStrategy
          .forBoundedOutOfOrderness<OptionsInput>(Duration.ofMillis(config.maxOutOfOrderMs))
          .withTimestampAssigner(
            SerializableTimestampAssigner { value, _ ->
              value.eventTs.toEpochMilli()
            },
          ),
      )

  val analytics =
    inputs
      .keyBy { it.symbol }
      .process(OptionsContractAnalyticsProcessFunction(config))
      .name("options-ta-contract-analytics")
      .uid("options-ta-contract-analytics")

  val contractBars =
    analytics
      .flatMap(ExtractContractBarsFlatMap())
      .returns(object : TypeHint<Envelope<OptionsContractBarPayload>>() {})
      .name("options-ta-contract-bars")
      .uid("options-ta-contract-bars")

  val contractFeatures =
    analytics
      .flatMap(ExtractContractFeaturesFlatMap())
      .returns(object : TypeHint<Envelope<OptionsContractFeaturePayload>>() {})
      .name("options-ta-contract-features")
      .uid("options-ta-contract-features")

  val surfaceFeatures =
    contractFeatures
      .keyBy { it.payload.underlyingSymbol }
      .process(OptionsSurfaceFeatureProcessFunction(config.feed))
      .name("options-ta-surface-features")
      .uid("options-ta-surface-features")

  val status =
    inputs
      .keyBy { OPTIONS_TA_STATUS_SYMBOL }
      .process(OptionsStatusHeartbeatProcessFunction(config.feed, config.checkpointIntervalMs, config.watermarkLagTargetMs))
      .name("options-ta-status")
      .uid("options-ta-status")

  contractBars.sinkTo(optionsContractBarSink(config, serde)).name("sink-options-contract-bars")
  contractFeatures.sinkTo(optionsContractFeatureSink(config, serde)).name("sink-options-contract-features")
  surfaceFeatures.sinkTo(optionsSurfaceFeatureSink(config, serde)).name("sink-options-surface-features")
  status.sinkTo(optionsStatusSink(config, serde)).name("sink-options-status")
  applyOptionsClickhouseSinks(config, contractBars, contractFeatures, surfaceFeatures)

  env.execute("torghut-options-technical-analysis-flink")
}

private fun configureOptionsEnvironment(
  env: StreamExecutionEnvironment,
  config: OptionsTaConfig,
) {
  env.setParallelism(config.parallelism)
  env.enableCheckpointing(config.checkpointIntervalMs)
  val checkpointConfig = env.checkpointConfig
  checkpointConfig.checkpointTimeout = config.checkpointTimeoutMs
  checkpointConfig.minPauseBetweenCheckpoints = config.minPauseBetweenCheckpointsMs
  env.config.setAutoWatermarkInterval(1_000)
}

private fun applyOptionsS3SystemProperties(config: OptionsTaConfig) {
  System.setProperty("fs.s3a.endpoint", config.s3Endpoint)
  System.setProperty("fs.s3a.path.style.access", config.s3PathStyle.toString())
  System.setProperty("fs.s3a.connection.ssl.enabled", config.s3Secure.toString())
  System.setProperty("fs.s3a.fast.upload", "true")
  config.s3AccessKey?.let { System.setProperty("fs.s3a.access.key", it) }
  config.s3SecretKey?.let { System.setProperty("fs.s3a.secret.key", it) }
}

private fun optionsKafkaSource(
  config: OptionsTaConfig,
  topic: String,
): KafkaSource<String> {
  val offsetResetStrategy =
    when (config.autoOffsetReset.trim().lowercase()) {
      "earliest" -> OffsetResetStrategy.EARLIEST
      "latest" -> OffsetResetStrategy.LATEST
      "none" -> OffsetResetStrategy.NONE
      else -> OffsetResetStrategy.LATEST
    }

  val builder =
    KafkaSource
      .builder<String>()
      .setBootstrapServers(config.bootstrapServers)
      .setTopics(topic)
      .setClientIdPrefix(config.clientId)
      .setGroupId(config.groupId)
      .setValueOnlyDeserializer(SimpleStringSchema())
      .setStartingOffsets(OffsetsInitializer.committedOffsets(offsetResetStrategy))

  builder.setProperty("auto.offset.reset", config.autoOffsetReset)
  builder.setProperty("isolation.level", "read_committed")
  builder.setProperty("enable.auto.commit", "false")
  applyOptionsKafkaSecurity(builder, config)
  return builder.build()
}

private fun applyOptionsKafkaSecurity(
  builder: KafkaSourceBuilder<String>,
  config: OptionsTaConfig,
) {
  builder.setProperty("security.protocol", config.securityProtocol)
  config.saslMechanism?.let { builder.setProperty("sasl.mechanism", it) }
  if (!config.saslUsername.isNullOrBlank() && !config.saslPassword.isNullOrBlank()) {
    builder.setProperty("sasl.jaas.config", optionsKafkaJaas(config))
  }
}

private fun optionsKafkaJaas(config: OptionsTaConfig): String =
  """org.apache.kafka.common.security.scram.ScramLoginModule required username="${config.saslUsername}" password="${config.saslPassword}";"""

private fun <T> KafkaSinkBuilder<T>.setKafkaSecurity(config: OptionsTaConfig): KafkaSinkBuilder<T> {
  setProperty("security.protocol", config.securityProtocol)
  config.saslMechanism?.let { setProperty("sasl.mechanism", it) }
  if (!config.saslUsername.isNullOrBlank() && !config.saslPassword.isNullOrBlank()) {
    setProperty("sasl.jaas.config", optionsKafkaJaas(config))
  }
  return this
}

private fun optionsContractBarSink(
  config: OptionsTaConfig,
  serde: OptionsAvroSerde,
): KafkaSink<Envelope<OptionsContractBarPayload>> {
  val builder =
    KafkaSink
      .builder<Envelope<OptionsContractBarPayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    builder.setTransactionalIdPrefix("${config.clientId}-options-contract-bars")
    builder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  builder.setRecordSerializer(OptionsContractBarSerializationSchema(config.contractBarsTopic, serde))
  builder.setKafkaSecurity(config)
  return builder.build()
}

private fun optionsContractFeatureSink(
  config: OptionsTaConfig,
  serde: OptionsAvroSerde,
): KafkaSink<Envelope<OptionsContractFeaturePayload>> {
  val builder =
    KafkaSink
      .builder<Envelope<OptionsContractFeaturePayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    builder.setTransactionalIdPrefix("${config.clientId}-options-contract-features")
    builder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  builder.setRecordSerializer(OptionsContractFeatureSerializationSchema(config.contractFeaturesTopic, serde))
  builder.setKafkaSecurity(config)
  return builder.build()
}

private fun optionsSurfaceFeatureSink(
  config: OptionsTaConfig,
  serde: OptionsAvroSerde,
): KafkaSink<Envelope<OptionsSurfaceFeaturePayload>> {
  val builder =
    KafkaSink
      .builder<Envelope<OptionsSurfaceFeaturePayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    builder.setTransactionalIdPrefix("${config.clientId}-options-surface-features")
    builder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  builder.setRecordSerializer(OptionsSurfaceFeatureSerializationSchema(config.surfaceFeaturesTopic, serde))
  builder.setKafkaSecurity(config)
  return builder.build()
}

private fun optionsStatusSink(
  config: OptionsTaConfig,
  serde: OptionsAvroSerde,
): KafkaSink<Envelope<OptionsTaStatusPayload>> {
  val builder =
    KafkaSink
      .builder<Envelope<OptionsTaStatusPayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    builder.setTransactionalIdPrefix("${config.clientId}-options-status")
    builder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  builder.setRecordSerializer(OptionsStatusSerializationSchema(config.statusTopic, serde))
  builder.setKafkaSecurity(config)
  return builder.build()
}

private fun applyOptionsClickhouseSinks(
  config: OptionsTaConfig,
  contractBars: org.apache.flink.streaming.api.datastream.DataStream<Envelope<OptionsContractBarPayload>>,
  contractFeatures: org.apache.flink.streaming.api.datastream.DataStream<Envelope<OptionsContractFeaturePayload>>,
  surfaceFeatures: org.apache.flink.streaming.api.datastream.DataStream<Envelope<OptionsSurfaceFeaturePayload>>,
) {
  if (config.clickhouseUrl.isNullOrBlank()) {
    LoggerFactory.getLogger("options-ta-clickhouse").info("ClickHouse sink disabled (OPTIONS_TA_CLICKHOUSE_URL not set).")
    return
  }

  ensureOptionsClickhouseSchema(config)
  contractBars.sinkTo(optionsClickhouseContractBarSink(config)).name("sink-options-contract-bars-clickhouse")
  contractFeatures.sinkTo(optionsClickhouseContractFeatureSink(config)).name("sink-options-contract-features-clickhouse")
  surfaceFeatures.sinkTo(optionsClickhouseSurfaceFeatureSink(config)).name("sink-options-surface-features-clickhouse")
}

private fun ensureOptionsClickhouseSchema(config: OptionsTaConfig) {
  val logger = LoggerFactory.getLogger("options-ta-clickhouse")
  val url =
    requireNotNull(config.clickhouseUrl) {
      "OPTIONS_TA_CLICKHOUSE_URL must be set when ClickHouse sinks are enabled."
    }
  val adminUrl = optionsClickhouseAdminUrl(url)
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

  executeWithRetry(
    maxAttempts = config.clickhouseSchemaInitMaxRetries.coerceAtLeast(0) + 1,
    retryDelayMs = config.clickhouseSchemaInitRetryDelayMs.coerceAtLeast(0),
    strict = config.clickhouseSchemaInitStrict,
    logger = logger,
    operationName = "options ClickHouse schema",
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
    }
  }
}

private fun optionsClickhouseAdminUrl(url: String): String =
  try {
    val uri = URI(url.removePrefix("jdbc:"))
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

private fun optionsClickhouseConnectionOptions(config: OptionsTaConfig): JdbcConnectionOptions {
  val url =
    requireNotNull(config.clickhouseUrl) {
      "OPTIONS_TA_CLICKHOUSE_URL must be set when ClickHouse sinks are enabled."
    }
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

private fun optionsClickhouseExecutionOptions(config: OptionsTaConfig): JdbcExecutionOptions =
  JdbcExecutionOptions
    .builder()
    .withBatchSize(config.clickhouseInsertBatchSize)
    .withBatchIntervalMs(config.clickhouseInsertFlushMs)
    .withMaxRetries(config.clickhouseInsertMaxRetries)
    .build()

private fun optionsClickhouseContractBarSink(config: OptionsTaConfig): JdbcSink<Envelope<OptionsContractBarPayload>> {
  val sql =
    """
    INSERT INTO options_contract_bars_1s (
      contract_symbol,
      underlying_symbol,
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
      expiration_date,
      strike_price,
      option_type,
      dte,
      o,
      h,
      l,
      c,
      v,
      count,
      bid_close,
      ask_close,
      mid_close,
      mark_close,
      spread_abs,
      spread_bps,
      bid_size_close,
      ask_size_close
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()

  return JdbcSink
    .builder<Envelope<OptionsContractBarPayload>>()
    .withQueryStatement(sql, optionsContractBarStatementBuilder())
    .withExecutionOptions(optionsClickhouseExecutionOptions(config))
    .buildAtLeastOnce(optionsClickhouseConnectionOptions(config))
}

private fun optionsClickhouseContractFeatureSink(config: OptionsTaConfig): JdbcSink<Envelope<OptionsContractFeaturePayload>> {
  val sql =
    """
    INSERT INTO options_contract_features (
      contract_symbol,
      underlying_symbol,
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
      expiration_date,
      strike_price,
      option_type,
      dte,
      moneyness,
      spread_abs,
      spread_bps,
      bid_size,
      ask_size,
      quote_imbalance,
      trade_count_w60s,
      notional_w60s,
      quote_updates_w60s,
      realized_vol_w60s,
      implied_volatility,
      iv_change_w60s,
      delta,
      delta_change_w60s,
      gamma,
      theta,
      vega,
      rho,
      mid_price,
      mark_price,
      mid_change_w60s,
      mark_change_w60s,
      stale_quote,
      stale_snapshot,
      feature_quality_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()

  return JdbcSink
    .builder<Envelope<OptionsContractFeaturePayload>>()
    .withQueryStatement(sql, optionsContractFeatureStatementBuilder())
    .withExecutionOptions(optionsClickhouseExecutionOptions(config))
    .buildAtLeastOnce(optionsClickhouseConnectionOptions(config))
}

private fun optionsClickhouseSurfaceFeatureSink(config: OptionsTaConfig): JdbcSink<Envelope<OptionsSurfaceFeaturePayload>> {
  val sql =
    """
    INSERT INTO options_surface_features (
      underlying_symbol,
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
      asof_contract_count,
      atm_iv,
      atm_call_iv,
      atm_put_iv,
      call_put_skew_25d,
      call_put_skew_10d,
      term_slope_front_back,
      term_slope_front_mid,
      surface_breadth,
      hot_contract_coverage_ratio,
      snapshot_coverage_ratio,
      feature_quality_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """.trimIndent()

  return JdbcSink
    .builder<Envelope<OptionsSurfaceFeaturePayload>>()
    .withQueryStatement(sql, optionsSurfaceFeatureStatementBuilder())
    .withExecutionOptions(optionsClickhouseExecutionOptions(config))
    .buildAtLeastOnce(optionsClickhouseConnectionOptions(config))
}

private fun optionsContractBarStatementBuilder(): JdbcStatementBuilder<Envelope<OptionsContractBarPayload>> =
  JdbcStatementBuilder { statement, envelope ->
    val payload = envelope.payload
    val window = envelope.window
    statement.setString(1, envelope.symbol)
    statement.setString(2, payload.underlyingSymbol)
    statement.setTimestamp(3, Timestamp.from(envelope.eventTs))
    statement.setLong(4, envelope.seq)
    statement.setTimestamp(5, Timestamp.from(envelope.ingestTs))
    statement.setInt(6, if (envelope.isFinal) 1 else 0)
    setNullableString(statement, 7, envelope.source)
    setNullableString(statement, 8, window?.size)
    setNullableString(statement, 9, window?.step)
    setNullableTimestamp(statement, 10, optionsParseInstant(window?.start))
    setNullableTimestamp(statement, 11, optionsParseInstant(window?.end))
    statement.setInt(12, envelope.version)
    statement.setDate(13, java.sql.Date.valueOf(payload.expirationDate))
    statement.setDouble(14, payload.strikePrice)
    statement.setString(15, payload.optionType)
    statement.setInt(16, payload.dte)
    statement.setDouble(17, payload.o)
    statement.setDouble(18, payload.h)
    statement.setDouble(19, payload.l)
    statement.setDouble(20, payload.c)
    statement.setDouble(21, payload.v)
    statement.setLong(22, payload.count)
    setNullableDouble(statement, 23, payload.bidClose)
    setNullableDouble(statement, 24, payload.askClose)
    setNullableDouble(statement, 25, payload.midClose)
    setNullableDouble(statement, 26, payload.markClose)
    setNullableDouble(statement, 27, payload.spreadAbs)
    setNullableDouble(statement, 28, payload.spreadBps)
    setNullableDouble(statement, 29, payload.bidSizeClose)
    setNullableDouble(statement, 30, payload.askSizeClose)
  }

private fun optionsContractFeatureStatementBuilder(): JdbcStatementBuilder<Envelope<OptionsContractFeaturePayload>> =
  JdbcStatementBuilder { statement, envelope ->
    val payload = envelope.payload
    val window = envelope.window
    statement.setString(1, envelope.symbol)
    statement.setString(2, payload.underlyingSymbol)
    statement.setTimestamp(3, Timestamp.from(envelope.eventTs))
    statement.setLong(4, envelope.seq)
    statement.setTimestamp(5, Timestamp.from(envelope.ingestTs))
    statement.setInt(6, if (envelope.isFinal) 1 else 0)
    setNullableString(statement, 7, envelope.source)
    setNullableString(statement, 8, window?.size)
    setNullableString(statement, 9, window?.step)
    setNullableTimestamp(statement, 10, optionsParseInstant(window?.start))
    setNullableTimestamp(statement, 11, optionsParseInstant(window?.end))
    statement.setInt(12, envelope.version)
    statement.setDate(13, java.sql.Date.valueOf(payload.expirationDate))
    statement.setDouble(14, payload.strikePrice)
    statement.setString(15, payload.optionType)
    statement.setInt(16, payload.dte)
    setNullableDouble(statement, 17, payload.moneyness)
    setNullableDouble(statement, 18, payload.spreadAbs)
    setNullableDouble(statement, 19, payload.spreadBps)
    setNullableDouble(statement, 20, payload.bidSize)
    setNullableDouble(statement, 21, payload.askSize)
    setNullableDouble(statement, 22, payload.quoteImbalance)
    setNullableLong(statement, 23, payload.tradeCountW60s)
    setNullableDouble(statement, 24, payload.notionalW60s)
    setNullableLong(statement, 25, payload.quoteUpdatesW60s)
    setNullableDouble(statement, 26, payload.realizedVolW60s)
    setNullableDouble(statement, 27, payload.impliedVolatility)
    setNullableDouble(statement, 28, payload.ivChangeW60s)
    setNullableDouble(statement, 29, payload.delta)
    setNullableDouble(statement, 30, payload.deltaChangeW60s)
    setNullableDouble(statement, 31, payload.gamma)
    setNullableDouble(statement, 32, payload.theta)
    setNullableDouble(statement, 33, payload.vega)
    setNullableDouble(statement, 34, payload.rho)
    setNullableDouble(statement, 35, payload.midPrice)
    setNullableDouble(statement, 36, payload.markPrice)
    setNullableDouble(statement, 37, payload.midChangeW60s)
    setNullableDouble(statement, 38, payload.markChangeW60s)
    statement.setInt(39, if (payload.staleQuote) 1 else 0)
    statement.setInt(40, if (payload.staleSnapshot) 1 else 0)
    statement.setString(41, payload.featureQualityStatus)
  }

private fun optionsSurfaceFeatureStatementBuilder(): JdbcStatementBuilder<Envelope<OptionsSurfaceFeaturePayload>> =
  JdbcStatementBuilder { statement, envelope ->
    val payload = envelope.payload
    val window = envelope.window
    statement.setString(1, payload.underlyingSymbol)
    statement.setTimestamp(2, Timestamp.from(envelope.eventTs))
    statement.setLong(3, envelope.seq)
    statement.setTimestamp(4, Timestamp.from(envelope.ingestTs))
    statement.setInt(5, if (envelope.isFinal) 1 else 0)
    setNullableString(statement, 6, envelope.source)
    setNullableString(statement, 7, window?.size)
    setNullableString(statement, 8, window?.step)
    setNullableTimestamp(statement, 9, optionsParseInstant(window?.start))
    setNullableTimestamp(statement, 10, optionsParseInstant(window?.end))
    statement.setInt(11, envelope.version)
    statement.setInt(12, payload.asofContractCount)
    setNullableDouble(statement, 13, payload.atmIv)
    setNullableDouble(statement, 14, payload.atmCallIv)
    setNullableDouble(statement, 15, payload.atmPutIv)
    setNullableDouble(statement, 16, payload.callPutSkew25d)
    setNullableDouble(statement, 17, payload.callPutSkew10d)
    setNullableDouble(statement, 18, payload.termSlopeFrontBack)
    setNullableDouble(statement, 19, payload.termSlopeFrontMid)
    setNullableDouble(statement, 20, payload.surfaceBreadth)
    setNullableDouble(statement, 21, payload.hotContractCoverageRatio)
    setNullableDouble(statement, 22, payload.snapshotCoverageRatio)
    statement.setString(23, payload.featureQualityStatus)
  }

data class OptionsInput(
  val trade: Envelope<OptionsTradePayload>? = null,
  val quote: Envelope<OptionsQuotePayload>? = null,
  val snapshot: Envelope<OptionsSnapshotPayload>? = null,
) : Serializable {
  val symbol: String
    get() = trade?.symbol ?: quote?.symbol ?: snapshot?.symbol ?: "UNKNOWN"

  val eventTs: Instant
    get() = trade?.eventTs ?: quote?.eventTs ?: snapshot?.eventTs ?: Instant.EPOCH
}

data class OptionsAnalyticsEmission(
  val bar: Envelope<OptionsContractBarPayload>? = null,
  val feature: Envelope<OptionsContractFeaturePayload>? = null,
) : Serializable

data class OptionsOccContract(
  val underlyingSymbol: String,
  val expirationDate: LocalDate,
  val strikePrice: Double,
  val optionType: String,
) : Serializable

data class OptionsBarAccumulator(
  val windowStartMs: Long,
  val windowEndMs: Long,
  var underlyingSymbol: String,
  var open: Double? = null,
  var high: Double = Double.NEGATIVE_INFINITY,
  var low: Double = Double.POSITIVE_INFINITY,
  var close: Double? = null,
  var volume: Double = 0.0,
  var count: Long = 0L,
  var sawQuote: Boolean = false,
) : Serializable {
  fun updateTrade(value: OptionsTradePayload) {
    underlyingSymbol = value.underlyingSymbol
    if (open == null) {
      open = value.price
      high = value.price
      low = value.price
      close = value.price
    } else {
      high = maxOf(high, value.price)
      low = minOf(low, value.price)
      close = value.price
    }
    volume += value.size
    count += 1
  }

  fun markQuote(value: OptionsQuotePayload) {
    underlyingSymbol = value.underlyingSymbol
    sawQuote = true
  }
}

data class OptionsQuoteState(
  val eventMs: Long,
  val bidPrice: Double,
  val bidSize: Double,
  val askPrice: Double,
  val askSize: Double,
  val underlyingSymbol: String,
) : Serializable {
  fun midPrice(): Double? =
    if (bidPrice > 0.0 && askPrice > 0.0) {
      (bidPrice + askPrice) / 2.0
    } else {
      null
    }
}

data class OptionsSnapshotState(
  val eventMs: Long,
  val impliedVolatility: Double?,
  val delta: Double?,
  val gamma: Double?,
  val theta: Double?,
  val vega: Double?,
  val rho: Double?,
  val markPrice: Double?,
  val midPrice: Double?,
  val underlyingSymbol: String,
) : Serializable

data class OptionsBarHistoryEntry(
  val eventMs: Long,
  val close: Double,
  val count: Long,
  val notional: Double,
  val midClose: Double?,
  val markClose: Double?,
  val impliedVolatility: Double?,
  val delta: Double?,
) : Serializable

data class OptionsFeatureSnapshot(
  val contractSymbol: String,
  val eventMs: Long,
  val payload: OptionsContractFeaturePayload,
) : Serializable

private class OptionsContractAnalyticsProcessFunction(
  private val config: OptionsTaConfig,
) : KeyedProcessFunction<String, OptionsInput, OptionsAnalyticsEmission>() {
  private lateinit var bucketState: MapState<Long, OptionsBarAccumulator>
  private lateinit var quoteHistoryState: ListState<OptionsQuoteState>
  private lateinit var snapshotHistoryState: ListState<OptionsSnapshotState>
  private lateinit var barHistoryState: ListState<OptionsBarHistoryEntry>
  private lateinit var seqState: ValueState<Long>

  override fun open(openContext: OpenContext) {
    bucketState =
      runtimeContext.getMapState(
        MapStateDescriptor(
          "options-buckets",
          Long::class.javaObjectType,
          OptionsBarAccumulator::class.java,
        ),
      )
    quoteHistoryState = runtimeContext.getListState(ListStateDescriptor("options-quotes", OptionsQuoteState::class.java))
    snapshotHistoryState =
      runtimeContext.getListState(ListStateDescriptor("options-snapshots", OptionsSnapshotState::class.java))
    barHistoryState = runtimeContext.getListState(ListStateDescriptor("options-bars", OptionsBarHistoryEntry::class.java))
    seqState = runtimeContext.getState(ValueStateDescriptor("options-seq", Long::class.javaObjectType))
  }

  override fun processElement(
    value: OptionsInput,
    ctx: Context,
    out: Collector<OptionsAnalyticsEmission>,
  ) {
    val eventTs = value.eventTs
    val windowStart = eventTs.truncatedTo(ChronoUnit.SECONDS)
    val windowStartMs = windowStart.toEpochMilli()
    val windowEndMs = windowStartMs + 1_000

    value.trade?.let { envelope ->
      val trade = envelope.payload
      val existing = bucketState.get(windowStartMs) ?: OptionsBarAccumulator(windowStartMs, windowEndMs, trade.underlyingSymbol)
      existing.updateTrade(trade)
      bucketState.put(windowStartMs, existing)
      ctx.timerService().registerEventTimeTimer(windowEndMs)
    }

    value.quote?.let { envelope ->
      val quote = envelope.payload
      val existing = bucketState.get(windowStartMs) ?: OptionsBarAccumulator(windowStartMs, windowEndMs, quote.underlyingSymbol)
      existing.markQuote(quote)
      bucketState.put(windowStartMs, existing)
      ctx.timerService().registerEventTimeTimer(windowEndMs)
      val quotes = quoteHistoryState.get().toMutableList()
      quotes.add(
        OptionsQuoteState(
          eventMs = envelope.eventTs.toEpochMilli(),
          bidPrice = quote.bidPrice,
          bidSize = quote.bidSize,
          askPrice = quote.askPrice,
          askSize = quote.askSize,
          underlyingSymbol = quote.underlyingSymbol,
        ),
      )
      quoteHistoryState.update(pruneQuotes(quotes, windowEndMs))
    }

    value.snapshot?.let { envelope ->
      val snapshot = envelope.payload
      val snapshots = snapshotHistoryState.get().toMutableList()
      snapshots.add(
        OptionsSnapshotState(
          eventMs = envelope.eventTs.toEpochMilli(),
          impliedVolatility = snapshot.impliedVolatility,
          delta = snapshot.delta,
          gamma = snapshot.gamma,
          theta = snapshot.theta,
          vega = snapshot.vega,
          rho = snapshot.rho,
          markPrice = snapshot.markPrice,
          midPrice = snapshot.midPrice,
          underlyingSymbol = snapshot.underlyingSymbol,
        ),
      )
      snapshotHistoryState.update(pruneSnapshots(snapshots, envelope.eventTs.toEpochMilli()))
    }
  }

  override fun onTimer(
    timestamp: Long,
    ctx: OnTimerContext,
    out: Collector<OptionsAnalyticsEmission>,
  ) {
    val windowStartMs = timestamp - 1_000
    val bucket = bucketState.get(windowStartMs) ?: return
    bucketState.remove(windowStartMs)

    val symbol = ctx.currentKey
    val occ = parseOptionsContract(symbol) ?: return
    val quotes = pruneQuotes(quoteHistoryState.get().toMutableList(), timestamp)
    quoteHistoryState.update(quotes)
    val snapshots = pruneSnapshots(snapshotHistoryState.get().toMutableList(), timestamp)
    snapshotHistoryState.update(snapshots)
    val existingBars = pruneBars(barHistoryState.get().toMutableList(), timestamp)

    val currentQuote = quotes.lastOrNull { it.eventMs <= timestamp }
    val currentSnapshot = snapshots.lastOrNull { it.eventMs <= timestamp }
    val eventTs = Instant.ofEpochMilli(timestamp)
    val midClose = currentQuote?.midPrice() ?: currentSnapshot?.midPrice
    val markClose = currentSnapshot?.markPrice ?: midClose

    val barPrice =
      when {
        bucket.open != null -> bucket.close
        midClose != null -> midClose
        markClose != null -> markClose
        else -> null
      } ?: return

    val barPayload =
      OptionsContractBarPayload(
        underlyingSymbol = bucket.underlyingSymbol.ifBlank { occ.underlyingSymbol },
        expirationDate = occ.expirationDate.toString(),
        strikePrice = occ.strikePrice,
        optionType = occ.optionType,
        dte = ChronoUnit.DAYS.between(eventTs.atZone(ZoneOffset.UTC).toLocalDate(), occ.expirationDate).toInt(),
        o = bucket.open ?: barPrice,
        h = if (bucket.high.isFinite()) bucket.high else barPrice,
        l = if (bucket.low.isFinite()) bucket.low else barPrice,
        c = bucket.close ?: barPrice,
        v = bucket.volume,
        count = bucket.count,
        bidClose = currentQuote?.bidPrice,
        askClose = currentQuote?.askPrice,
        midClose = midClose,
        markClose = markClose,
        spreadAbs =
          currentQuote
            ?.let { quote ->
              if (quote.bidPrice > 0.0 && quote.askPrice > 0.0) {
                quote.askPrice - quote.bidPrice
              } else {
                null
              }
            },
        spreadBps =
          currentQuote
            ?.midPrice()
            ?.takeIf { it > 0.0 }
            ?.let { mid ->
              val spread =
                (currentQuote.askPrice - currentQuote.bidPrice).takeIf {
                  currentQuote.bidPrice > 0.0 &&
                    currentQuote.askPrice > 0.0
                }
              spread?.div(mid)?.times(10_000.0)
            },
        bidSizeClose = currentQuote?.bidSize,
        askSizeClose = currentQuote?.askSize,
      )

    val historyWithCurrent =
      (
        existingBars +
          OptionsBarHistoryEntry(
            eventMs = timestamp,
            close = barPayload.c,
            count = barPayload.count,
            notional = barPayload.c * barPayload.v,
            midClose = barPayload.midClose,
            markClose = barPayload.markClose,
            impliedVolatility = currentSnapshot?.impliedVolatility,
            delta = currentSnapshot?.delta,
          )
      ).sortedBy { it.eventMs }
    val within60s = historyWithCurrent.filter { it.eventMs >= timestamp - 60_000 }
    val firstWithin60s = within60s.firstOrNull()

    val quoteUpdatesW60s = quotes.count { it.eventMs >= timestamp - 60_000 }.toLong()
    val tradeCountW60s = within60s.sumOf { it.count }
    val notionalW60s = within60s.sumOf { it.notional }
    val realizedVolW60s = realizedVolatility(within60s.map { it.close })
    val staleQuote = currentQuote == null || (timestamp - currentQuote.eventMs) > config.quoteStaleAfterMs
    val staleSnapshot = currentSnapshot == null || (timestamp - currentSnapshot.eventMs) > config.snapshotStaleAfterMs
    val featureQualityStatus =
      when {
        staleQuote && staleSnapshot -> "stale_quote_and_snapshot"
        staleQuote -> "stale_quote"
        staleSnapshot -> "stale_snapshot"
        within60s.size < 2 -> "limited_history"
        else -> "ok"
      }

    val featurePayload =
      OptionsContractFeaturePayload(
        underlyingSymbol = barPayload.underlyingSymbol,
        expirationDate = barPayload.expirationDate,
        strikePrice = barPayload.strikePrice,
        optionType = barPayload.optionType,
        dte = barPayload.dte,
        moneyness = null,
        spreadAbs = barPayload.spreadAbs,
        spreadBps = barPayload.spreadBps,
        bidSize = currentQuote?.bidSize,
        askSize = currentQuote?.askSize,
        quoteImbalance =
          currentQuote?.let { quote ->
            val denom = quote.bidSize + quote.askSize
            if (denom > 0.0) {
              (quote.bidSize - quote.askSize) / denom
            } else {
              null
            }
          },
        tradeCountW60s = tradeCountW60s,
        notionalW60s = notionalW60s,
        quoteUpdatesW60s = quoteUpdatesW60s,
        realizedVolW60s = realizedVolW60s,
        impliedVolatility = currentSnapshot?.impliedVolatility,
        ivChangeW60s =
          currentSnapshot?.impliedVolatility?.let { current ->
            firstWithin60s?.impliedVolatility?.let { baseline -> current - baseline }
          },
        delta = currentSnapshot?.delta,
        deltaChangeW60s =
          currentSnapshot?.delta?.let { current ->
            firstWithin60s?.delta?.let { baseline -> current - baseline }
          },
        gamma = currentSnapshot?.gamma,
        theta = currentSnapshot?.theta,
        vega = currentSnapshot?.vega,
        rho = currentSnapshot?.rho,
        midPrice = midClose,
        markPrice = markClose,
        midChangeW60s = midClose?.let { current -> firstWithin60s?.midClose?.let { baseline -> current - baseline } },
        markChangeW60s = markClose?.let { current -> firstWithin60s?.markClose?.let { baseline -> current - baseline } },
        staleQuote = staleQuote,
        staleSnapshot = staleSnapshot,
        featureQualityStatus = featureQualityStatus,
      )

    val seq = nextSeq()
    val window =
      Window(
        size = "PT1S",
        step = "PT1S",
        start = Instant.ofEpochMilli(windowStartMs).toString(),
        end = eventTs.toString(),
      )

    out.collect(
      OptionsAnalyticsEmission(
        bar =
          Envelope(
            ingestTs = Instant.now(),
            eventTs = eventTs,
            feed = config.feed,
            channel = "contract-bars",
            symbol = symbol,
            seq = seq,
            payload = barPayload,
            isFinal = true,
            source = "flink",
            window = window,
            version = 1,
          ),
        feature =
          Envelope(
            ingestTs = Instant.now(),
            eventTs = eventTs,
            feed = config.feed,
            channel = "contract-features",
            symbol = symbol,
            seq = seq,
            payload = featurePayload,
            isFinal = true,
            source = "flink",
            window = window,
            version = 1,
          ),
      ),
    )

    barHistoryState.update(pruneBars(historyWithCurrent.toMutableList(), timestamp))
  }

  private fun nextSeq(): Long {
    val next = (seqState.value() ?: 0L) + 1L
    seqState.update(next)
    return next
  }
}

private class OptionsSurfaceFeatureProcessFunction(
  private val feed: String,
) : KeyedProcessFunction<String, Envelope<OptionsContractFeaturePayload>, Envelope<OptionsSurfaceFeaturePayload>>() {
  private lateinit var featureState: MapState<String, OptionsFeatureSnapshot>
  private lateinit var seqState: ValueState<Long>

  override fun open(openContext: OpenContext) {
    featureState =
      runtimeContext.getMapState(
        MapStateDescriptor(
          "options-feature-state",
          String::class.java,
          OptionsFeatureSnapshot::class.java,
        ),
      )
    seqState = runtimeContext.getState(ValueStateDescriptor("options-surface-seq", Long::class.javaObjectType))
  }

  override fun processElement(
    value: Envelope<OptionsContractFeaturePayload>,
    ctx: Context,
    out: Collector<Envelope<OptionsSurfaceFeaturePayload>>,
  ) {
    featureState.put(
      value.symbol,
      OptionsFeatureSnapshot(
        contractSymbol = value.symbol,
        eventMs = value.eventTs.toEpochMilli(),
        payload = value.payload,
      ),
    )

    val cutoff = value.eventTs.toEpochMilli() - 300_000
    val entries = featureState.entries().toList()
    val snapshots =
      entries
        .map { it.value }
        .filter { snapshot -> snapshot.eventMs >= cutoff }
    entries
      .map { it.value }
      .filter { snapshot -> snapshot.eventMs < cutoff }
      .forEach { snapshot ->
        featureState.remove(snapshot.contractSymbol)
      }

    if (snapshots.isEmpty()) return

    val payloads = snapshots.map { it.payload }
    val surfacePayload = buildOptionsSurfaceFeaturePayload(ctx.currentKey, payloads) ?: return
    val seq = (seqState.value() ?: 0L) + 1L
    seqState.update(seq)

    out.collect(
      Envelope(
        ingestTs = Instant.now(),
        eventTs = value.eventTs,
        feed = feed,
        channel = "surface-features",
        symbol = ctx.currentKey,
        seq = seq,
        payload = surfacePayload,
        isFinal = true,
        source = "flink",
        window = value.window,
        version = 1,
      ),
    )
  }
}

private class OptionsStatusHeartbeatProcessFunction(
  private val feed: String,
  private val intervalMs: Long,
  private val watermarkLagTargetMs: Long,
) : KeyedProcessFunction<String, OptionsInput, Envelope<OptionsTaStatusPayload>>() {
  private lateinit var lastEventMsState: ValueState<Long>
  private lateinit var seqState: ValueState<Long>
  private lateinit var nextTimerState: ValueState<Long>

  override fun open(openContext: OpenContext) {
    lastEventMsState = runtimeContext.getState(ValueStateDescriptor("options-status-last-event-ms", Long::class.javaObjectType))
    seqState = runtimeContext.getState(ValueStateDescriptor("options-status-seq", Long::class.javaObjectType))
    nextTimerState = runtimeContext.getState(ValueStateDescriptor("options-status-next-timer-ms", Long::class.javaObjectType))
  }

  override fun processElement(
    value: OptionsInput,
    ctx: Context,
    out: Collector<Envelope<OptionsTaStatusPayload>>,
  ) {
    val eventMs = value.eventTs.toEpochMilli()
    val last = lastEventMsState.value()
    if (last == null || eventMs > last) {
      lastEventMsState.update(eventMs)
    }
    val current = nextTimerState.value()
    val now = ctx.timerService().currentProcessingTime()
    if (current == null || current <= now) {
      val next = now + intervalMs
      ctx.timerService().registerProcessingTimeTimer(next)
      nextTimerState.update(next)
    }
  }

  override fun onTimer(
    timestamp: Long,
    ctx: OnTimerContext,
    out: Collector<Envelope<OptionsTaStatusPayload>>,
  ) {
    val now = Instant.now()
    val watermark = ctx.timerService().currentWatermark()
    val lagMs =
      if (watermark == Long.MIN_VALUE) {
        null
      } else {
        (now.toEpochMilli() - watermark).coerceAtLeast(0)
      }
    val lastEventMs = lastEventMsState.value()
    val seq = (seqState.value() ?: 0L) + 1L
    seqState.update(seq)
    val status = if (lagMs != null && lagMs > watermarkLagTargetMs) "degraded" else "ok"
    out.collect(
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = feed,
        channel = "status",
        symbol = ctx.currentKey,
        seq = seq,
        payload =
          OptionsTaStatusPayload(
            component = "options-ta",
            status = status,
            watermarkLagMs = lagMs,
            lastEventTs = lastEventMs?.let { Instant.ofEpochMilli(it).toString() },
            checkpointAgeMs = intervalMs,
            inputBacklog = 0L,
            schemaVersion = 1,
          ),
        isFinal = true,
        source = "flink",
        window = null,
        version = 1,
      ),
    )
    val next = timestamp + intervalMs
    ctx.timerService().registerProcessingTimeTimer(next)
    nextTimerState.update(next)
  }
}

internal class OptionsContractBarSerializationSchema(
  private val topic: String,
  private val serde: OptionsAvroSerde,
) : KafkaRecordSerializationSchema<Envelope<OptionsContractBarPayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<OptionsContractBarPayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    return ProducerRecord(
      topic,
      null,
      timestamp ?: System.currentTimeMillis(),
      element.symbol.toByteArray(StandardCharsets.UTF_8),
      serde.encodeContractBar(element, topic),
    )
  }
}

internal class OptionsContractFeatureSerializationSchema(
  private val topic: String,
  private val serde: OptionsAvroSerde,
) : KafkaRecordSerializationSchema<Envelope<OptionsContractFeaturePayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<OptionsContractFeaturePayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    return ProducerRecord(
      topic,
      null,
      timestamp ?: System.currentTimeMillis(),
      element.symbol.toByteArray(StandardCharsets.UTF_8),
      serde.encodeContractFeature(element, topic),
    )
  }
}

internal class OptionsSurfaceFeatureSerializationSchema(
  private val topic: String,
  private val serde: OptionsAvroSerde,
) : KafkaRecordSerializationSchema<Envelope<OptionsSurfaceFeaturePayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<OptionsSurfaceFeaturePayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    return ProducerRecord(
      topic,
      null,
      timestamp ?: System.currentTimeMillis(),
      element.symbol.toByteArray(StandardCharsets.UTF_8),
      serde.encodeSurfaceFeature(element, topic),
    )
  }
}

internal class OptionsStatusSerializationSchema(
  private val topic: String,
  private val serde: OptionsAvroSerde,
) : KafkaRecordSerializationSchema<Envelope<OptionsTaStatusPayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<OptionsTaStatusPayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    return ProducerRecord(
      topic,
      null,
      timestamp ?: System.currentTimeMillis(),
      element.symbol.toByteArray(StandardCharsets.UTF_8),
      serde.encodeStatus(element, topic),
    )
  }
}

private class ExtractContractBarsFlatMap :
  org.apache.flink.api.common.functions.RichFlatMapFunction<OptionsAnalyticsEmission, Envelope<OptionsContractBarPayload>>() {
  override fun flatMap(
    value: OptionsAnalyticsEmission,
    out: Collector<Envelope<OptionsContractBarPayload>>,
  ) {
    value.bar?.let(out::collect)
  }
}

private class ExtractContractFeaturesFlatMap :
  org.apache.flink.api.common.functions.RichFlatMapFunction<OptionsAnalyticsEmission, Envelope<OptionsContractFeaturePayload>>() {
  override fun flatMap(
    value: OptionsAnalyticsEmission,
    out: Collector<Envelope<OptionsContractFeaturePayload>>,
  ) {
    value.feature?.let(out::collect)
  }
}

private fun parseOptionsContract(symbol: String): OptionsOccContract? {
  val identity = parseOptionsContractIdentity(symbol) ?: return null
  return OptionsOccContract(
    underlyingSymbol = identity.underlyingSymbol,
    expirationDate = identity.expirationDate,
    strikePrice = identity.strikePrice,
    optionType = identity.optionType,
  )
}

private fun pruneQuotes(
  quotes: MutableList<OptionsQuoteState>,
  watermarkMs: Long,
): MutableList<OptionsQuoteState> = quotes.filterTo(mutableListOf()) { it.eventMs >= watermarkMs - 60_000 }

private fun pruneSnapshots(
  snapshots: MutableList<OptionsSnapshotState>,
  watermarkMs: Long,
): MutableList<OptionsSnapshotState> = snapshots.filterTo(mutableListOf()) { it.eventMs >= watermarkMs - 300_000 }

private fun pruneBars(
  bars: MutableList<OptionsBarHistoryEntry>,
  watermarkMs: Long,
): MutableList<OptionsBarHistoryEntry> = bars.filterTo(mutableListOf()) { it.eventMs >= watermarkMs - 60_000 }

private fun realizedVolatility(closes: List<Double>): Double? {
  if (closes.size < 2) return null
  val returns =
    closes
      .zipWithNext()
      .mapNotNull { (previous, current) ->
        if (previous > 0.0 && current > 0.0) {
          ln(current / previous)
        } else {
          null
        }
      }
  if (returns.size < 2) return null
  val mean = returns.average()
  val variance = returns.sumOf { (it - mean).pow(2) } / returns.size.toDouble()
  return sqrt(variance)
}

private fun closestByDelta(
  payloads: List<OptionsContractFeaturePayload>,
  targetAbsDelta: Double,
): OptionsContractFeaturePayload? =
  payloads
    .filter { it.delta != null }
    .minByOrNull { payload ->
      abs(abs(payload.delta ?: 0.0) - targetAbsDelta)
    }

internal fun buildOptionsSurfaceFeaturePayload(
  underlyingSymbol: String,
  payloads: List<OptionsContractFeaturePayload>,
): OptionsSurfaceFeaturePayload? {
  if (payloads.isEmpty()) {
    return null
  }

  val eligible = payloads.filter { !it.staleSnapshot && it.impliedVolatility != null }
  val atmCall = closestByDelta(eligible.filter { it.optionType == "call" }, 0.5)
  val atmPut = closestByDelta(eligible.filter { it.optionType == "put" }, 0.5)
  val atmIv =
    listOfNotNull(atmCall?.impliedVolatility, atmPut?.impliedVolatility)
      .takeIf { it.isNotEmpty() }
      ?.average()

  if (eligible.size < 4 || atmIv == null) {
    return null
  }

  val call25 = closestByDelta(eligible.filter { it.optionType == "call" }, 0.25)
  val put25 = closestByDelta(eligible.filter { it.optionType == "put" }, 0.25)
  val call10 = closestByDelta(eligible.filter { it.optionType == "call" }, 0.10)
  val put10 = closestByDelta(eligible.filter { it.optionType == "put" }, 0.10)
  val front = eligible.minByOrNull { it.dte }
  val mid = eligible.minByOrNull { abs(it.dte - 30) }
  val back = eligible.maxByOrNull { it.dte }
  val snapshotCoverageRatio = payloads.count { it.impliedVolatility != null }.toDouble() / payloads.size.toDouble()
  val surfaceBreadth = eligible.size.toDouble() / payloads.size.toDouble()
  val hotCoverageRatio = payloads.count { !it.staleQuote && !it.staleSnapshot }.toDouble() / payloads.size.toDouble()

  return OptionsSurfaceFeaturePayload(
    underlyingSymbol = underlyingSymbol,
    asofContractCount = payloads.size,
    atmIv = atmIv,
    atmCallIv = atmCall?.impliedVolatility,
    atmPutIv = atmPut?.impliedVolatility,
    callPutSkew25d = ivSpread(put25, call25),
    callPutSkew10d = ivSpread(put10, call10),
    termSlopeFrontBack = ivSpread(back, front),
    termSlopeFrontMid = ivSpread(mid, front),
    surfaceBreadth = surfaceBreadth,
    hotContractCoverageRatio = hotCoverageRatio,
    snapshotCoverageRatio = snapshotCoverageRatio,
    featureQualityStatus = "ok",
  )
}

private fun ivSpread(
  upper: OptionsContractFeaturePayload?,
  lower: OptionsContractFeaturePayload?,
): Double? = upper?.impliedVolatility?.let { upperIv -> lower?.impliedVolatility?.let { lowerIv -> upperIv - lowerIv } }

private fun optionsParseInstant(value: String?): Instant? = value?.let { runCatching { Instant.parse(it) }.getOrNull() }

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
  if (value == null) {
    statement.setNull(index, Types.DOUBLE)
  } else {
    statement.setDouble(index, value)
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
