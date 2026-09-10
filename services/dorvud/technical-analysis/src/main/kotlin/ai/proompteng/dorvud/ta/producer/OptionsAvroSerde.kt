package ai.proompteng.dorvud.ta.producer

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.OptionsContractBarPayload
import ai.proompteng.dorvud.ta.stream.OptionsContractFeaturePayload
import ai.proompteng.dorvud.ta.stream.OptionsSurfaceFeaturePayload
import ai.proompteng.dorvud.ta.stream.OptionsTaStatusPayload
import io.confluent.kafka.serializers.KafkaAvroSerializer
import org.apache.avro.Schema
import org.apache.avro.generic.GenericData
import org.apache.avro.generic.GenericDatumWriter
import org.apache.avro.io.BinaryEncoder
import org.apache.avro.io.EncoderFactory
import java.io.ByteArrayOutputStream
import java.io.Serializable

class OptionsAvroSerde(
  private val schemaRegistryUrl: String? =
    System.getenv("OPTIONS_TA_SCHEMA_REGISTRY_URL") ?: System.getenv("TA_SCHEMA_REGISTRY_URL"),
) : Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  private val barsSchema: Schema = loadSchema("schemas/options-contract-bars-1s.avsc")
  private val featuresSchema: Schema = loadSchema("schemas/options-contract-features.avsc")
  private val surfaceSchema: Schema = loadSchema("schemas/options-surface-features.avsc")
  private val statusSchema: Schema = loadSchema("schemas/options-ta-status.avsc")

  @Transient
  private var registrySerializer: KafkaAvroSerializer? = null

  fun encodeContractBar(
    env: Envelope<OptionsContractBarPayload>,
    topic: String,
  ): ByteArray = encodeWithRegistryOrFallback(topic, flattenContractBar(env), barsSchema)

  fun encodeContractFeature(
    env: Envelope<OptionsContractFeaturePayload>,
    topic: String,
  ): ByteArray = encodeWithRegistryOrFallback(topic, flattenContractFeature(env), featuresSchema)

  fun encodeSurfaceFeature(
    env: Envelope<OptionsSurfaceFeaturePayload>,
    topic: String,
  ): ByteArray = encodeWithRegistryOrFallback(topic, flattenSurfaceFeature(env), surfaceSchema)

  fun encodeStatus(
    env: Envelope<OptionsTaStatusPayload>,
    topic: String,
  ): ByteArray = encodeWithRegistryOrFallback(topic, flattenStatus(env), statusSchema)

  private fun loadSchema(resourcePath: String): Schema {
    val stream =
      javaClass.classLoader.getResourceAsStream(resourcePath)
        ?: error("Schema resource not found: $resourcePath")
    return stream.use { Schema.Parser().parse(it) }
  }

  private fun windowRecord(
    schema: Schema,
    env: Envelope<*>,
  ): GenericData.Record? {
    val window = env.window ?: return null
    val recordSchema =
      schema
        .getField("window")
        .schema()
        .types
        .first { it.type == Schema.Type.RECORD }
    return GenericData.Record(recordSchema).also { winRecord ->
      winRecord.put("size", window.size)
      winRecord.put("step", window.step)
      winRecord.put("start", window.start)
      winRecord.put("end", window.end)
    }
  }

  private fun flattenContractBar(env: Envelope<OptionsContractBarPayload>): GenericData.Record {
    val payload = env.payload
    val record = GenericData.Record(barsSchema)
    record.put("ingest_ts", env.ingestTs.toString())
    record.put("event_ts", env.eventTs.toString())
    record.put("symbol", env.symbol)
    record.put("seq", env.seq)
    record.put("is_final", env.isFinal)
    record.put("source", env.source)
    record.put("window", windowRecord(barsSchema, env))
    record.put("underlying_symbol", payload.underlyingSymbol)
    record.put("expiration_date", payload.expirationDate)
    record.put("strike_price", payload.strikePrice)
    record.put("option_type", payload.optionType)
    record.put("dte", payload.dte)
    record.put("o", payload.o)
    record.put("h", payload.h)
    record.put("l", payload.l)
    record.put("c", payload.c)
    record.put("v", payload.v)
    record.put("count", payload.count)
    record.put("bid_close", payload.bidClose)
    record.put("ask_close", payload.askClose)
    record.put("mid_close", payload.midClose)
    record.put("mark_close", payload.markClose)
    record.put("spread_abs", payload.spreadAbs)
    record.put("spread_bps", payload.spreadBps)
    record.put("bid_size_close", payload.bidSizeClose)
    record.put("ask_size_close", payload.askSizeClose)
    record.put("version", env.version)
    return record
  }

  private fun flattenContractFeature(env: Envelope<OptionsContractFeaturePayload>): GenericData.Record {
    val payload = env.payload
    val record = GenericData.Record(featuresSchema)
    record.put("ingest_ts", env.ingestTs.toString())
    record.put("event_ts", env.eventTs.toString())
    record.put("symbol", env.symbol)
    record.put("seq", env.seq)
    record.put("is_final", env.isFinal)
    record.put("source", env.source)
    record.put("window", windowRecord(featuresSchema, env))
    record.put("underlying_symbol", payload.underlyingSymbol)
    record.put("expiration_date", payload.expirationDate)
    record.put("strike_price", payload.strikePrice)
    record.put("option_type", payload.optionType)
    record.put("dte", payload.dte)
    record.put("moneyness", payload.moneyness)
    record.put("spread_abs", payload.spreadAbs)
    record.put("spread_bps", payload.spreadBps)
    record.put("bid_size", payload.bidSize)
    record.put("ask_size", payload.askSize)
    record.put("quote_imbalance", payload.quoteImbalance)
    record.put("trade_count_w60s", payload.tradeCountW60s)
    record.put("notional_w60s", payload.notionalW60s)
    record.put("quote_updates_w60s", payload.quoteUpdatesW60s)
    record.put("realized_vol_w60s", payload.realizedVolW60s)
    record.put("implied_volatility", payload.impliedVolatility)
    record.put("iv_change_w60s", payload.ivChangeW60s)
    record.put("delta", payload.delta)
    record.put("delta_change_w60s", payload.deltaChangeW60s)
    record.put("gamma", payload.gamma)
    record.put("theta", payload.theta)
    record.put("vega", payload.vega)
    record.put("rho", payload.rho)
    record.put("mid_price", payload.midPrice)
    record.put("mark_price", payload.markPrice)
    record.put("mid_change_w60s", payload.midChangeW60s)
    record.put("mark_change_w60s", payload.markChangeW60s)
    record.put("stale_quote", payload.staleQuote)
    record.put("stale_snapshot", payload.staleSnapshot)
    record.put("feature_quality_status", payload.featureQualityStatus)
    record.put("version", env.version)
    return record
  }

  private fun flattenSurfaceFeature(env: Envelope<OptionsSurfaceFeaturePayload>): GenericData.Record {
    val payload = env.payload
    val record = GenericData.Record(surfaceSchema)
    record.put("ingest_ts", env.ingestTs.toString())
    record.put("event_ts", env.eventTs.toString())
    record.put("symbol", env.symbol)
    record.put("seq", env.seq)
    record.put("is_final", env.isFinal)
    record.put("source", env.source)
    record.put("window", windowRecord(surfaceSchema, env))
    record.put("underlying_symbol", payload.underlyingSymbol)
    record.put("asof_contract_count", payload.asofContractCount)
    record.put("atm_iv", payload.atmIv)
    record.put("atm_call_iv", payload.atmCallIv)
    record.put("atm_put_iv", payload.atmPutIv)
    record.put("call_put_skew_25d", payload.callPutSkew25d)
    record.put("call_put_skew_10d", payload.callPutSkew10d)
    record.put("term_slope_front_back", payload.termSlopeFrontBack)
    record.put("term_slope_front_mid", payload.termSlopeFrontMid)
    record.put("surface_breadth", payload.surfaceBreadth)
    record.put("hot_contract_coverage_ratio", payload.hotContractCoverageRatio)
    record.put("snapshot_coverage_ratio", payload.snapshotCoverageRatio)
    record.put("feature_quality_status", payload.featureQualityStatus)
    record.put("version", env.version)
    return record
  }

  private fun flattenStatus(env: Envelope<OptionsTaStatusPayload>): GenericData.Record {
    val payload = env.payload
    val record = GenericData.Record(statusSchema)
    record.put("ingest_ts", env.ingestTs.toString())
    record.put("event_ts", env.eventTs.toString())
    record.put("symbol", env.symbol)
    record.put("seq", env.seq)
    record.put("is_final", env.isFinal)
    record.put("source", env.source)
    record.put("window", windowRecord(statusSchema, env))
    record.put("component", payload.component)
    record.put("status", payload.status)
    record.put("watermark_lag_ms", payload.watermarkLagMs)
    record.put("last_event_ts", payload.lastEventTs)
    record.put("checkpoint_age_ms", payload.checkpointAgeMs)
    record.put("input_backlog", payload.inputBacklog)
    record.put("schema_version", payload.schemaVersion)
    record.put("version", env.version)
    return record
  }

  private fun encode(
    record: GenericData.Record,
    schema: Schema,
  ): ByteArray {
    val out = ByteArrayOutputStream()
    val encoder: BinaryEncoder = EncoderFactory.get().binaryEncoder(out, null)
    val writer = GenericDatumWriter<GenericData.Record>(schema)
    writer.write(record, encoder)
    encoder.flush()
    return out.toByteArray()
  }

  private fun encodeWithRegistryOrFallback(
    topic: String,
    record: GenericData.Record,
    schema: Schema,
  ): ByteArray {
    val url = schemaRegistryUrl?.trim()
    if (!url.isNullOrBlank()) {
      val serializer =
        registrySerializer
          ?: KafkaAvroSerializer().also { created ->
            created.configure(
              mapOf(
                "schema.registry.url" to url,
                "auto.register.schemas" to true,
              ),
              false,
            )
            registrySerializer = created
          }
      return serializer.serialize(topic, record)
    }
    return encode(record, schema)
  }
}
