package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.functions.RichFlatMapFunction
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.connector.jdbc.JdbcConnectionOptions
import org.apache.flink.connector.jdbc.JdbcExecutionOptions
import org.apache.flink.connector.jdbc.JdbcStatementBuilder
import org.apache.flink.connector.jdbc.core.datastream.sink.JdbcSink
import org.apache.flink.connector.kafka.source.KafkaSource
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer
import org.apache.flink.metrics.Counter
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.util.Collector
import org.slf4j.LoggerFactory
import java.io.Serializable
import java.sql.Timestamp
import java.time.Instant
import java.time.ZoneId

internal data class ArchivedMarketFeature(
  val featureId: String,
  val universeId: String,
  val universeSymbolHash: String,
  val feed: String,
  val symbol: String,
  val windowEndMs: Long,
  val computedAtMs: Long,
  val archivedAtMs: Long,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val payload: String,
) : Serializable

internal fun decodeArchivedMarketFeature(
  record: ArchiveKafkaRecord,
  routes: Map<String, ArchiveRoute>,
  archivedAtMs: Long,
): ArchivedMarketFeature {
  val json = Json { encodeDefaults = true }
  val document = json.parseToJsonElement(record.value)
  require(document is JsonObject) { "feature document must be an object" }
  val suppliedMaterial = document["material"]
  require(suppliedMaterial is JsonObject) { "feature material must be an object" }
  require(listOf("schemaVersion", "definitionId", "definitionHash", "sessionPolicy").all { it in suppliedMaterial }) {
    "feature contract fields must be explicit"
  }
  val feature = json.decodeFromJsonElement(RollingMarketFeature.serializer(), document)
  val material = feature.material
  require(
    material.schemaVersion == ROLLING_FEATURE_SCHEMA && material.definitionId == ROLLING_FEATURE_DEFINITION &&
      material.definitionHash == rollingFeatureDefinitionHash(),
  ) { "unknown feature contract" }
  require(
    feature.featureId == featureHash(json.encodeToJsonElement(RollingMarketFeatureMaterial.serializer(), material)),
  ) {
    "feature content hash mismatch"
  }
  require(
    material.provider == "alpaca" && material.feed == "iex" && material.delayClass == "real_time_exchange_only" &&
      material.sessionPolicy == FEATURE_SESSION_POLICY,
  ) { "unsupported feature identity" }
  require(feature.producerRevision.isNotBlank()) { "missing feature producer revision" }
  require(record.partition >= 0 && record.offset >= 0) { "invalid feature source coordinates" }
  require(
    material.windowStartMs in 0..253_402_300_799_999L && material.windowEndMs in 0..253_402_300_799_999L &&
      material.windowStartMs % 60_000 == 0L && material.windowEndMs - material.windowStartMs == 1_800_000L,
  ) {
    "invalid feature window"
  }
  require(
    material.inputs.size == FEATURE_LOOKBACK_MINUTES &&
      feature.computedAtMs in (material.windowEndMs - FEATURE_MAX_CLOCK_SKEW_MS)..253_402_300_799_999L &&
      feature.computedAtMs <= archivedAtMs + FEATURE_MAX_CLOCK_SKEW_MS,
  ) {
    "invalid feature availability"
  }
  require(
    material.sessionDate ==
      Instant
        .ofEpochMilli(material.windowStartMs)
        .atZone(ZoneId.of("America/New_York"))
        .toLocalDate()
        .toString(),
  ) {
    "feature session mismatch"
  }
  require(
    material.sessionDate ==
      Instant
        .ofEpochMilli(material.windowEndMs - 1)
        .atZone(ZoneId.of("America/New_York"))
        .toLocalDate()
        .toString(),
  ) {
    "feature window spans sessions"
  }
  val coordinates = mutableSetOf<String>()
  for ((index, input) in material.inputs.withIndex()) {
    require(
      input.eventTimeNanos == ((material.windowStartMs + index * 60_000).toBigInteger() * 1_000_000L.toBigInteger()).toString(),
    ) { "feature inputs are not contiguous" }
    require(input.ingestionTimeNanos.matches(Regex("0|[1-9][0-9]*"))) { "invalid input availability timestamp" }
    require(
      input.ingestionTimeNanos.toBigInteger() + FEATURE_MAX_CLOCK_SKEW_MS.toBigInteger() * 1_000_000L.toBigInteger() >=
        input.eventTimeNanos.toBigInteger() + 60_000_000_000L.toBigInteger(),
    ) {
      "premature feature input"
    }
    require(
      input.ingestionTimeNanos.toBigInteger() <=
        (feature.computedAtMs + FEATURE_MAX_CLOCK_SKEW_MS).toBigInteger() * 1_000_000L.toBigInteger() + 999_999L.toBigInteger(),
    ) {
      "feature computation precedes input"
    }
    require(
      input.sourcePartition >= 0 && input.sourceOffset.matches(Regex("0|[1-9][0-9]*")) &&
        input.sourceOffset.toLongOrNull()?.let { it >= 0 } == true && input.contentHash.matches(Regex("[0-9a-f]{64}")),
    ) {
      "invalid feature provenance"
    }
    require(coordinates.add("${input.sourceTopic}:${input.sourcePartition}:${input.sourceOffset}")) { "duplicate feature input" }
    val route = requireNotNull(routes[input.sourceTopic]) { "unknown feature input topic" }
    require(
      route.kind == ArchiveRecordKind.Bar && route.feed == material.feed && route.universe.id == material.universeId &&
        route.universe.symbolHash == material.universeSymbolHash &&
        material.symbol in route.universe.symbols,
    ) { "feature universe does not match archive route" }
  }
  require(
    material.inputs
      .map { it.sourceTopic }
      .distinct()
      .size == 1,
  ) { "mixed feature source topics" }
  val prices =
    with(material.values) {
      listOf(referencePriceMicros, rangeHighPriceMicros, rangeLowPriceMicros, lastClosePriceMicros)
    }.map {
      require(it.matches(Regex("[1-9][0-9]*"))) { "feature prices must be canonical positive integers" }
      it.toLong()
    }
  require(prices.all { it in 1..9_007_199_254_740_991L }) { "invalid feature price" }
  require(prices[1] >= maxOf(prices[0], prices[2], prices[3]) && prices[2] <= minOf(prices[0], prices[3])) { "inconsistent feature range" }
  require(material.values.totalVolumeMicros.matches(Regex("0|[1-9][0-9]*"))) { "invalid feature volume" }
  return ArchivedMarketFeature(
    feature.featureId,
    material.universeId,
    material.universeSymbolHash,
    material.feed,
    material.symbol,
    material.windowEndMs,
    feature.computedAtMs,
    archivedAtMs,
    record.topic,
    record.partition,
    record.offset,
    record.value,
  )
}

internal fun configureMarketFeatureArchive(
  env: StreamExecutionEnvironment,
  config: MarketDataArchiveConfig,
  topic: String,
) {
  require(topic !in config.routes) { "feature archive topic must differ from raw topics" }
  val source =
    KafkaSource
      .builder<ArchiveKafkaRecord>()
      .setBootstrapServers(config.bootstrapServers)
      .setTopics(topic)
      .setGroupId("${config.groupId}-features-v1")
      .setClientIdPrefix("${config.clientId}-features-v1")
      .setDeserializer(ArchiveKafkaRecordDeserializer())
      .setStartingOffsets(OffsetsInitializer.earliest())
      .setProperty("isolation.level", "read_committed")
      .setProperty("enable.auto.commit", "false")
  applyArchiveKafkaSecurity(source, config)
  val connection =
    JdbcConnectionOptions
      .JdbcConnectionOptionsBuilder()
      .withUrl(config.clickhouseUrl)
      .withDriverName("com.clickhouse.jdbc.ClickHouseDriver")
      .withUsername(config.clickhouseUsername)
      .apply { config.clickhousePassword?.let(::withPassword) }
      .build()
  val statement =
    JdbcStatementBuilder<ArchivedMarketFeature> { prepared, row ->
      prepared.setString(1, row.featureId)
      prepared.setString(2, row.universeId)
      prepared.setString(3, row.universeSymbolHash)
      prepared.setString(4, row.feed)
      prepared.setString(5, row.symbol)
      prepared.setTimestamp(6, Timestamp(row.windowEndMs))
      prepared.setTimestamp(7, Timestamp(row.computedAtMs))
      prepared.setTimestamp(8, Timestamp(row.archivedAtMs))
      prepared.setString(9, row.sourceTopic)
      prepared.setInt(10, row.sourcePartition)
      prepared.setLong(11, row.sourceOffset)
      prepared.setString(12, row.payload)
    }
  val sink =
    JdbcSink
      .builder<ArchivedMarketFeature>()
      .withQueryStatement(
        "INSERT INTO signal.intraday_features_v1 (feature_id, universe_id, universe_symbol_hash, feed, symbol, window_end, computed_at, archived_at, source_topic, source_partition, source_offset, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        statement,
      ).withExecutionOptions(
        JdbcExecutionOptions
          .builder()
          .withBatchSize(
            config.clickhouseBatchSize,
          ).withBatchIntervalMs(config.clickhouseFlushMs)
          .withMaxRetries(config.clickhouseMaxRetries)
          .build(),
      ).buildAtLeastOnce(connection)
  env
    .fromSource(source.build(), WatermarkStrategy.noWatermarks(), "market-feature-archive-source")
    .uid("market-feature-archive-source-v1")
    .flatMap(ParseMarketFeatureArchive(config.routes))
    .returns(TypeInformation.of(ArchivedMarketFeature::class.java))
    .keyBy { ArchiveSourcePartition(it.sourceTopic, it.sourcePartition) }
    .sinkTo(sink)
    .name("signal-intraday-features-archive")
    .uid("signal-intraday-features-archive-v1")
}

internal class ParseMarketFeatureArchive(
  private val routes: Map<String, ArchiveRoute>,
) : RichFlatMapFunction<ArchiveKafkaRecord, ArchivedMarketFeature>() {
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    rejected = runtimeContext.metricGroup.counter("market_feature_archive_rejected_total")
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<ArchivedMarketFeature>,
  ) {
    try {
      out.collect(decodeArchivedMarketFeature(value, routes, System.currentTimeMillis()))
    } catch (cause: IllegalArgumentException) {
      rejected.inc()
      val reason =
        if (cause is SerializationException) {
          "invalid feature schema"
        } else {
          cause.message
            .orEmpty()
            .replace(
              Regex("[\\r\\n]"),
              " ",
            ).take(240)
        }
      LoggerFactory.getLogger("market-feature-archive").warn(
        "Rejected feature topic={} partition={} offset={} error={} reason={}",
        value.topic,
        value.partition,
        value.offset,
        cause.javaClass.simpleName,
        reason,
      )
    }
  }
}
