package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.CRYPTO_DELAY_CLASS
import ai.proompteng.dorvud.platform.CRYPTO_SESSION
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.functions.RichFlatMapFunction
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.connector.jdbc.JdbcStatementBuilder
import org.apache.flink.connector.jdbc.core.datastream.sink.JdbcSink
import org.apache.flink.metrics.Counter
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.util.Collector
import org.apache.kafka.clients.consumer.OffsetResetStrategy
import org.slf4j.LoggerFactory
import java.io.Serializable
import java.time.DateTimeException
import java.time.Instant

internal data class ArchivedCryptoMarketFeature(
  val feature: CryptoMarketFeature,
  val archivedAtMs: Long,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val payload: String,
) : Serializable

internal fun decodeArchivedCryptoMarketFeature(
  record: ArchiveKafkaRecord,
  source: CryptoArchiveConfig,
  topic: String,
  archivedAtMs: Long,
): ArchivedCryptoMarketFeature {
  require(record.topic == topic && record.partition >= 0 && record.offset >= 0) { "invalid crypto feature source coordinates" }
  val document = Json.parseToJsonElement(record.value).jsonObject
  val feature = Json.decodeFromJsonElement(CryptoMarketFeature.serializer(), document)
  val material = feature.material
  require(
    material.schemaVersion == CRYPTO_FEATURE_SCHEMA && material.definitionId == CRYPTO_FEATURE_DEFINITION &&
      material.definitionHash == cryptoFeatureDefinitionHash(),
  ) { "unknown crypto feature definition" }
  require(feature.featureId == featureHash(document.getValue("material"))) { "crypto feature hash mismatch" }
  require(
    material.provider == "alpaca" && material.location == source.location && material.symbol in source.symbols &&
      material.marketSession == CRYPTO_SESSION && material.delayClass == CRYPTO_DELAY_CLASS,
  ) { "crypto feature source identity mismatch" }
  val hash = Regex("[0-9a-f]{64}")
  require(feature.producerRevision.matches(Regex("[0-9a-f]{40}"))) { "invalid crypto feature producer revision" }
  require(material.historyPrefixHash.matches(hash) && material.historyHash.matches(hash)) { "invalid crypto feature history hash" }
  require(material.inputs.size in 1..CRYPTO_FEATURE_HISTORY) { "invalid crypto feature input count" }
  require(material.windowStartMs % 60_000 == 0L && material.windowEndMs % 60_000 == 0L) { "unaligned crypto feature window" }
  require(material.windowEndMs > material.windowStartMs) { "invalid crypto feature window" }
  val start = material.windowStartMs.toBigInteger() * 1_000_000.toBigInteger()
  val end = material.windowEndMs.toBigInteger() * 1_000_000.toBigInteger()
  val minute = 60_000_000_000.toBigInteger()
  val skew = FEATURE_MAX_CLOCK_SKEW_MS.toBigInteger() * 1_000_000.toBigInteger()
  var previousTime = start - minute
  val coordinates = mutableSetOf<Pair<Int, String>>()
  for (input in material.inputs) {
    require(input.sourceTopic == source.topic && input.sourcePartition >= 0 && input.sourceOffset.toLong() >= 0) {
      "invalid crypto feature raw coordinates"
    }
    require(coordinates.add(input.sourcePartition to input.sourceOffset)) { "duplicate crypto feature input" }
    require(input.contentHash.matches(hash)) { "invalid crypto feature raw hash" }
    val event = input.eventTimeNanos.toBigInteger()
    val ingestion = input.ingestionTimeNanos.toBigInteger()
    require(event >= start && event < end && event % minute == java.math.BigInteger.ZERO && event > previousTime) {
      "unordered crypto feature input window"
    }
    require(ingestion + skew >= event + minute) { "crypto feature raw minute was incomplete" }
    require(
      feature.computedAtMs.toBigInteger() * 1_000_000.toBigInteger() + skew >= ingestion,
    ) { "crypto feature precedes input availability" }
    previousTime = event
  }
  require(
    material.inputs
      .first()
      .eventTimeNanos
      .toBigInteger() == start && previousTime + minute == end,
  ) {
    "crypto feature window does not bind its raw inputs"
  }
  require(
    cryptoHistoryHash(material.historyPrefixHash, material.inputs) == material.historyHash,
  ) { "crypto feature history chain mismatch" }
  require(Math.addExact(feature.computedAtMs, FEATURE_MAX_CLOCK_SKEW_MS) >= material.windowEndMs) { "crypto feature minute is incomplete" }
  require(
    Math.addExact(archivedAtMs, FEATURE_MAX_CLOCK_SKEW_MS) >= feature.computedAtMs,
  ) { "crypto feature is unavailable at archive time" }
  material.priceWindow.let { values ->
    val prices = listOf(values.referencePrice, values.rangeHighPrice, values.rangeLowPrice, values.lastClosePrice).map(String::toBigDecimal)
    require(prices.all { it.signum() > 0 } && values.totalVolume.toBigDecimal().signum() >= 0) { "invalid crypto rolling values" }
    require(prices[1] >= maxOf(prices[0], prices[3]) && prices[2] <= minOf(prices[0], prices[3])) { "inconsistent crypto rolling range" }
  }
  val scalars = Json.encodeToJsonElement(CryptoTechnicalValues.serializer(), material.technical).jsonObject.values
  for (element in scalars) {
    val scalar = Json.decodeFromJsonElement(TechnicalFeatureValue.serializer(), element)
    require((scalar.status == TechnicalReadiness.READY) == (scalar.value != null)) { "crypto technical readiness and values disagree" }
    scalar.value?.let {
      require(it.toLong().toBigInteger().abs() <= 9_007_199_254_740_991L.toBigInteger()) { "crypto technical scalar exceeds exact range" }
    }
  }
  return ArchivedCryptoMarketFeature(feature, archivedAtMs, record.topic, record.partition, record.offset, record.value)
}

internal fun configureCryptoMarketFeatureArchive(
  env: StreamExecutionEnvironment,
  config: MarketDataArchiveConfig,
  source: CryptoArchiveConfig,
  topic: String,
) {
  require(topic !in config.routes && topic !in setOfNotNull(source.topic, config.featuresTopic, config.technicalFeaturesTopic)) {
    "crypto feature archive topic must be distinct"
  }
  env
    .fromSource(
      archiveKafkaSource(
        config.copy(
          groupId = "${config.groupId}-crypto-features-v1",
          clientId = "${config.clientId}-crypto-features-v1",
          offsetResetStrategy = OffsetResetStrategy.EARLIEST,
        ),
        listOf(topic),
      ),
      WatermarkStrategy.noWatermarks(),
      "crypto-feature-archive-source",
    ).uid("crypto-feature-archive-source-v1")
    .flatMap(ParseCryptoMarketFeatureArchive(source, topic))
    .returns(TypeInformation.of(ArchivedCryptoMarketFeature::class.java))
    .keyBy { ArchiveSourcePartition(it.sourceTopic, it.sourcePartition) }
    .sinkTo(
      JdbcSink
        .builder<ArchivedCryptoMarketFeature>()
        .withQueryStatement(cryptoMarketFeatureInsertSql(), cryptoMarketFeatureStatement())
        .withExecutionOptions(archiveJdbcExecutionOptions(config))
        .buildAtLeastOnce(archiveJdbcConnectionOptions(config)),
    ).name("crypto-market-features-archive")
    .uid("crypto-market-features-archive-v1")
}

internal class ParseCryptoMarketFeatureArchive(
  private val source: CryptoArchiveConfig,
  private val topic: String,
) : RichFlatMapFunction<ArchiveKafkaRecord, ArchivedCryptoMarketFeature>() {
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    rejected = runtimeContext.metricGroup.counter("crypto_feature_archive_rejected_total")
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<ArchivedCryptoMarketFeature>,
  ) {
    val parsed =
      runCatching { decodeArchivedCryptoMarketFeature(value, source, topic, System.currentTimeMillis()) }.getOrElse { error ->
        if (error !is IllegalArgumentException && error !is IllegalStateException && error !is DateTimeException &&
          error !is ArithmeticException
        ) {
          throw error
        }
        rejected.inc()
        LoggerFactory.getLogger("crypto-market-feature-archive").warn(
          "Rejected crypto feature topic={} partition={} offset={}",
          value.topic,
          value.partition,
          value.offset,
          error,
        )
        return
      }
    out.collect(parsed)
  }
}

internal fun cryptoMarketFeatureInsertSql(): String =
  """
  INSERT INTO signal.crypto_market_features_v1 (
    feature_id, location, symbol, window_start, window_end, computed_at, archived_at,
    source_topic, source_partition, source_offset, payload
   ) VALUES (
    ?, ?, ?, parseDateTime64BestEffort(?, 3, 'UTC'), parseDateTime64BestEffort(?, 3, 'UTC'),
    parseDateTime64BestEffort(?, 3, 'UTC'), parseDateTime64BestEffort(?, 3, 'UTC'), ?, ?, ?, ?
  )
  """.trimIndent()

internal fun cryptoMarketFeatureStatement(): JdbcStatementBuilder<ArchivedCryptoMarketFeature> =
  JdbcStatementBuilder { prepared, row ->
    prepared.setString(1, row.feature.featureId)
    prepared.setString(2, row.feature.material.location)
    prepared.setString(3, row.feature.material.symbol)
    prepared.setString(4, Instant.ofEpochMilli(row.feature.material.windowStartMs).toString())
    prepared.setString(5, Instant.ofEpochMilli(row.feature.material.windowEndMs).toString())
    prepared.setString(6, Instant.ofEpochMilli(row.feature.computedAtMs).toString())
    prepared.setString(7, Instant.ofEpochMilli(row.archivedAtMs).toString())
    prepared.setString(8, row.sourceTopic)
    prepared.setInt(9, row.sourcePartition)
    prepared.setLong(10, row.sourceOffset)
    prepared.setString(11, row.payload)
  }
