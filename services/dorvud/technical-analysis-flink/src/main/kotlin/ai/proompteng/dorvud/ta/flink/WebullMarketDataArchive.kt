package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.WEBULL_BARS_PATH
import ai.proompteng.dorvud.platform.WebullBarRequest
import ai.proompteng.dorvud.platform.WebullBarRequestState
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.decodeWebullCapture
import ai.proompteng.dorvud.platform.inspectWebullCapture
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.MapFunction
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.connector.jdbc.JdbcStatementBuilder
import org.apache.flink.connector.jdbc.core.datastream.sink.JdbcSink
import org.apache.flink.connector.kafka.source.KafkaSource
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import java.io.Serializable

internal data class ArchivedWebullMarketData(
  val captureId: String,
  val channel: String,
  val receivedAt: String,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val payloadSha256: String,
  val symbolsJson: String,
  val sourceTimesJson: String,
  val validationStatus: String,
  val validationError: String,
  val capture: String,
  val minuteBarsJson: String,
  val barRequestsJson: String,
) : Serializable

internal fun decodeArchivedWebullMarketData(
  record: ArchiveKafkaRecord,
  topic: String,
): ArchivedWebullMarketData {
  require(record.topic == topic && record.partition >= 0 && record.offset >= 0) { "invalid Webull archive source coordinates" }
  val capture = decodeWebullCapture(record.value)
  val inspected = runCatching { inspectWebullCapture(capture) }
  val parsed = inspected.getOrNull()
  val sourceChannel =
    when (val source = capture.source) {
      is WebullSource.Mqtt -> source.topic
      is WebullSource.Http -> source.endpoint
      is WebullSource.Collector -> source.operation
    }
  val requests =
    parsed?.barRequests ?: when (val source = capture.source) {
      is WebullSource.Http ->
        if (source.endpoint == WEBULL_BARS_PATH) {
          source.requestedSymbols.map { WebullBarRequest(it, WebullBarRequestState.REJECTED, 0, 0) }
        } else {
          emptyList()
        }
      else -> emptyList()
    }
  return ArchivedWebullMarketData(
    capture.captureId,
    parsed?.channel ?: sourceChannel,
    capture.receivedAt,
    record.topic,
    record.partition,
    record.offset,
    capture.payloadSha256,
    JsonArray(parsed?.observations.orEmpty().map { JsonPrimitive(it.symbol) }).toString(),
    JsonArray(parsed?.observations.orEmpty().map { JsonPrimitive(it.sourceTime) }).toString(),
    if (parsed == null) "REJECTED" else "VALID",
    inspected.exceptionOrNull()?.javaClass?.simpleName ?: "",
    record.value,
    JsonArray(
      parsed?.minuteBars.orEmpty().map { bar ->
        buildJsonArray {
          add(JsonPrimitive(bar.symbol))
          add(JsonPrimitive(bar.startMillis))
          add(JsonPrimitive(bar.session.name))
          listOf(bar.open, bar.high, bar.low, bar.close, bar.volume).forEach { add(JsonPrimitive(it)) }
        }
      },
    ).toString(),
    JsonArray(
      requests.map { request ->
        buildJsonArray {
          add(JsonPrimitive(request.symbol))
          add(JsonPrimitive(request.state.name))
          add(JsonPrimitive(request.observations))
          add(JsonPrimitive(request.excluded))
        }
      },
    ).toString(),
  )
}

internal fun configureWebullMarketDataArchive(
  environment: StreamExecutionEnvironment,
  config: MarketDataArchiveConfig,
  topic: String,
) {
  require(
    topic !in config.routes &&
      topic !in listOfNotNull(config.featuresTopic, config.technicalFeaturesTopic, config.crypto?.topic, config.cryptoFeaturesTopic),
  ) { "Webull archive topic must be independent" }
  val builder =
    KafkaSource
      .builder<ArchiveKafkaRecord>()
      .setBootstrapServers(config.bootstrapServers)
      .setTopics(topic)
      .setGroupId("${config.groupId}-webull-v1")
      .setClientIdPrefix("${config.clientId}-webull")
      .setDeserializer(ArchiveKafkaRecordDeserializer())
      .setStartingOffsets(OffsetsInitializer.earliest())
      .setProperty("isolation.level", "read_committed")
      .setProperty("enable.auto.commit", "false")
      .setProperty("max.partition.fetch.bytes", (8 * 1024 * 1024).toString())
  applyArchiveKafkaSecurity(builder, config)
  environment
    .fromSource(builder.build(), WatermarkStrategy.noWatermarks(), "webull-market-data-source")
    .uid("webull-market-data-source-v1")
    .map(MapFunction<ArchiveKafkaRecord, ArchivedWebullMarketData> { decodeArchivedWebullMarketData(it, topic) })
    .returns(TypeInformation.of(ArchivedWebullMarketData::class.java))
    .name("webull-market-data-decode")
    .uid("webull-market-data-decode-v1")
    .keyBy { ArchiveSourcePartition(it.sourceTopic, it.sourcePartition) }
    .sinkTo(
      JdbcSink
        .builder<ArchivedWebullMarketData>()
        .withQueryStatement(webullMarketDataInsertSql(), webullMarketDataStatement())
        .withExecutionOptions(archiveJdbcExecutionOptions(config))
        .buildAtLeastOnce(archiveJdbcConnectionOptions(config)),
    ).name("webull-market-data-archive")
    .uid("webull-market-data-archive-v1")
}

internal fun webullMarketDataInsertSql(): String =
  """
  INSERT INTO signal.webull_market_events_v1 (
    provider, feed, capture_id, channel, received_at,
    source_topic, source_partition, source_offset, payload_sha256,
    symbols, source_times, validation_status, validation_error, capture, minute_bars, bar_requests
  ) VALUES ('webull', 'nasdaq_basic', ?, ?, parseDateTime64BestEffort(?, 9, 'UTC'), ?, ?, ?, ?,
    JSONExtract(?, 'Array(String)'), JSONExtract(?, 'Array(String)'), ?, ?, ?,
    JSONExtract(?, 'Array(Tuple(String, Int64, String, String, String, String, String, String))'),
    JSONExtract(?, 'Array(Tuple(String, String, UInt32, UInt32))'))
  """.trimIndent()

internal fun webullMarketDataStatement(): JdbcStatementBuilder<ArchivedWebullMarketData> =
  JdbcStatementBuilder<ArchivedWebullMarketData> { prepared, event ->
    prepared.setString(1, event.captureId)
    prepared.setString(2, event.channel)
    prepared.setString(3, event.receivedAt)
    prepared.setString(4, event.sourceTopic)
    prepared.setInt(5, event.sourcePartition)
    prepared.setLong(6, event.sourceOffset)
    prepared.setString(7, event.payloadSha256)
    prepared.setString(8, event.symbolsJson)
    prepared.setString(9, event.sourceTimesJson)
    prepared.setString(10, event.validationStatus)
    prepared.setString(11, event.validationError)
    prepared.setString(12, event.capture)
    prepared.setString(13, event.minuteBarsJson)
    prepared.setString(14, event.barRequestsJson)
  }
