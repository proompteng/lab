package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.CRYPTO_DELAY_CLASS
import ai.proompteng.dorvud.platform.CRYPTO_LOCATIONS
import ai.proompteng.dorvud.platform.CRYPTO_SESSION
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.decodeCryptoMarketData
import ai.proompteng.dorvud.platform.isCryptoPair
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
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

data class CryptoArchiveConfig(
  val topic: String,
  val location: String,
  val symbols: Set<String>,
) : Serializable {
  companion object {
    fun fromEnv(env: Map<String, String>): CryptoArchiveConfig? {
      val topic = env["ARCHIVE_CRYPTO_TOPIC"]?.trim()?.takeIf { it.isNotEmpty() }
      if (topic == null) {
        require(env["ARCHIVE_CRYPTO_SYMBOLS"] == null && env["ARCHIVE_CRYPTO_LOCATION"] == null) { "crypto archive topic is required" }
        return null
      }
      val location = env["ARCHIVE_CRYPTO_LOCATION"]?.trim() ?: "us"
      require(location in CRYPTO_LOCATIONS) { "unsupported crypto archive location" }
      val symbols = requireNotNull(env["ARCHIVE_CRYPTO_SYMBOLS"]) { "crypto archive symbols are required" }.split(",").map { it.trim() }
      require(
        symbols.isNotEmpty() && symbols.all(::isCryptoPair) && symbols.distinct().size == symbols.size,
      ) { "invalid crypto archive pairs" }
      return CryptoArchiveConfig(topic, location, symbols.toSet())
    }
  }
}

internal data class ArchivedCryptoMarketData(
  val location: String,
  val channel: String,
  val symbol: String,
  val eventTs: String,
  val ingestTs: String,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val sequence: Long,
  val payload: String,
) : Serializable

internal fun decodeArchivedCryptoMarketData(
  record: ArchiveKafkaRecord,
  config: CryptoArchiveConfig,
): ArchivedCryptoMarketData {
  require(record.topic == config.topic && record.partition >= 0 && record.offset >= 0) { "invalid crypto source coordinates" }
  val envelope = Json.decodeFromString(Envelope.serializer(JsonElement.serializer()), record.value)
  require(envelope.version == 2 && envelope.provider == "alpaca" && envelope.source == "ws") { "invalid crypto envelope provenance" }
  require(envelope.feed == config.location && envelope.marketSession == CRYPTO_SESSION && envelope.delayClass == CRYPTO_DELAY_CLASS) {
    "invalid crypto feed identity"
  }
  require(envelope.seq > 0) { "invalid crypto event sequence" }
  val event = decodeCryptoMarketData(envelope.payload as? JsonObject ?: error("crypto payload must be an object"))
  require(event.symbol == envelope.symbol && event.symbol in config.symbols) { "crypto symbol is outside the configured source" }
  require(event.eventTs == envelope.eventTs && event.channel.subscription == envelope.channel) { "crypto payload and envelope disagree" }
  return ArchivedCryptoMarketData(
    location = config.location,
    channel = envelope.channel,
    symbol = event.symbol,
    eventTs = event.eventTs.toString(),
    ingestTs = envelope.ingestTs.toString(),
    sourceTopic = record.topic,
    sourcePartition = record.partition,
    sourceOffset = record.offset,
    sequence = envelope.seq,
    payload = event.payload.toString(),
  )
}

private class ParseArchiveCrypto(
  private val config: CryptoArchiveConfig,
) : RichFlatMapFunction<ArchiveKafkaRecord, ArchivedCryptoMarketData>() {
  @Transient
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    rejected = runtimeContext.metricGroup.counter("crypto_market_data_archive_rejected_total")
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<ArchivedCryptoMarketData>,
  ) {
    runCatching { decodeArchivedCryptoMarketData(value, config) }
      .onSuccess(out::collect)
      .onFailure { cause ->
        rejected.inc()
        LoggerFactory.getLogger("crypto-market-data-archive").warn(
          "Rejected crypto event topic={} partition={} offset={}",
          value.topic,
          value.partition,
          value.offset,
          cause,
        )
      }
  }
}

internal fun configureCryptoMarketDataArchive(
  environment: StreamExecutionEnvironment,
  config: MarketDataArchiveConfig,
  crypto: CryptoArchiveConfig,
) {
  environment
    .fromSource(
      archiveKafkaSource(
        config.copy(
          groupId = "${config.groupId}-crypto-v1",
          clientId = "${config.clientId}-crypto",
          offsetResetStrategy = OffsetResetStrategy.EARLIEST,
        ),
        listOf(crypto.topic),
      ),
      WatermarkStrategy.noWatermarks(),
      "crypto-market-data-source",
    ).uid("crypto-market-data-source-v1")
    .flatMap(ParseArchiveCrypto(crypto))
    .returns(TypeInformation.of(ArchivedCryptoMarketData::class.java))
    .name("crypto-market-data-decode")
    .uid("crypto-market-data-decode-v1")
    .keyBy { ArchiveSourcePartition(it.sourceTopic, it.sourcePartition) }
    .sinkTo(
      JdbcSink
        .builder<ArchivedCryptoMarketData>()
        .withQueryStatement(cryptoMarketDataInsertSql(), cryptoMarketDataStatement())
        .withExecutionOptions(archiveJdbcExecutionOptions(config))
        .buildAtLeastOnce(archiveJdbcConnectionOptions(config)),
    ).name("crypto-market-data-archive")
    .uid("crypto-market-data-archive-v1")
}

internal fun cryptoMarketDataInsertSql(): String =
  """
  INSERT INTO signal.crypto_market_events_v1 (
    provider, location, channel, symbol, event_ts, ingest_ts,
    source_topic, source_partition, source_offset, sequence, payload, schema_version
  ) VALUES ('alpaca', ?, ?, ?, parseDateTime64BestEffort(?, 9, 'UTC'), parseDateTime64BestEffort(?, 9, 'UTC'), ?, ?, ?, ?, ?, 1)
  """.trimIndent()

internal fun cryptoMarketDataStatement(): JdbcStatementBuilder<ArchivedCryptoMarketData> =
  JdbcStatementBuilder<ArchivedCryptoMarketData> { prepared, event ->
    prepared.setString(1, event.location)
    prepared.setString(2, event.channel)
    prepared.setString(3, event.symbol)
    prepared.setString(4, event.eventTs)
    prepared.setString(5, event.ingestTs)
    prepared.setString(6, event.sourceTopic)
    prepared.setInt(7, event.sourcePartition)
    prepared.setLong(8, event.sourceOffset)
    prepared.setLong(9, event.sequence)
    prepared.setString(10, event.payload)
  }
