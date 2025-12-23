package ai.proompteng.dorvud.ta.producer

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import io.confluent.kafka.serializers.KafkaAvroSerializer
import org.apache.avro.Schema
import org.apache.avro.generic.GenericData
import org.apache.avro.generic.GenericDatumWriter
import org.apache.avro.io.BinaryEncoder
import org.apache.avro.io.EncoderFactory
import java.io.ByteArrayOutputStream
import java.io.Serializable
import java.nio.charset.StandardCharsets

/** Lightweight Avro helper to validate and encode payloads against the published schemas. */
class AvroSerde(
  private val schemaRegistryUrl: String? = System.getenv("TA_SCHEMA_REGISTRY_URL"),
) : Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  private val barsSchema: Schema = loadSchema("schemas/ta-bars-1s.avsc")
  private val signalsSchema: Schema = loadSchema("schemas/ta-signals.avsc")

  @Transient
  private var registrySerializer: KafkaAvroSerializer? = null

  fun encodeMicroBar(
    env: Envelope<MicroBarPayload>,
    topic: String,
  ): ByteArray = encodeWithRegistryOrFallback(topic, flattenBar(env), barsSchema)

  fun encodeSignals(
    env: Envelope<TaSignalsPayload>,
    topic: String,
  ): ByteArray = encodeWithRegistryOrFallback(topic, flattenSignal(env), signalsSchema)

  fun toJson(env: Envelope<MicroBarPayload>): String = flattenBar(env).toString()

  fun signalJson(env: Envelope<TaSignalsPayload>): String = flattenSignal(env).toString()

  private fun loadSchema(resourcePath: String): Schema {
    val stream =
      javaClass.classLoader.getResourceAsStream(resourcePath)
        ?: error("Schema resource not found: $resourcePath")
    return stream.use { Schema.Parser().parse(it) }
  }

  private fun flattenBar(env: Envelope<MicroBarPayload>): GenericData.Record {
    val record = GenericData.Record(barsSchema)
    record.put("ingest_ts", env.ingestTs.toString())
    record.put("event_ts", env.eventTs.toString())
    record.put("symbol", env.symbol)
    record.put("seq", env.seq)
    record.put("is_final", env.isFinal)
    record.put("source", env.source)
    env.window?.let { window ->
      val windowSchema =
        barsSchema
          .getField("window")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val winRecord = GenericData.Record(windowSchema)
      winRecord.put("size", window.size)
      winRecord.put("step", window.step)
      winRecord.put("start", window.start)
      winRecord.put("end", window.end)
      record.put("window", winRecord)
    }
    record.put("o", env.payload.o)
    record.put("h", env.payload.h)
    record.put("l", env.payload.l)
    record.put("c", env.payload.c)
    record.put("v", env.payload.v)
    record.put("vwap", env.payload.vwap)
    record.put("count", env.payload.count)
    record.put("version", env.version)
    return record
  }

  private fun flattenSignal(env: Envelope<TaSignalsPayload>): GenericData.Record {
    val record = GenericData.Record(signalsSchema)
    record.put("ingest_ts", env.ingestTs.toString())
    record.put("event_ts", env.eventTs.toString())
    record.put("symbol", env.symbol)
    record.put("seq", env.seq)
    record.put("is_final", env.isFinal)
    record.put("source", env.source)
    env.window?.let { window ->
      val windowSchema =
        signalsSchema
          .getField("window")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val winRecord = GenericData.Record(windowSchema)
      winRecord.put("size", window.size)
      winRecord.put("step", window.step)
      winRecord.put("start", window.start)
      winRecord.put("end", window.end)
      record.put("window", winRecord)
    }

    env.payload.macd?.let {
      val schema =
        signalsSchema
          .getField("macd")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val r = GenericData.Record(schema)
      r.put("macd", it.macd)
      r.put("signal", it.signal)
      r.put("hist", it.hist)
      record.put("macd", r)
    }

    env.payload.ema?.let {
      val schema =
        signalsSchema
          .getField("ema")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val r = GenericData.Record(schema)
      r.put("ema12", it.ema12)
      r.put("ema26", it.ema26)
      record.put("ema", r)
    }

    env.payload.rsi14?.let { record.put("rsi14", it) }

    env.payload.boll?.let {
      val schema =
        signalsSchema
          .getField("boll")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val r = GenericData.Record(schema)
      r.put("mid", it.mid)
      r.put("upper", it.upper)
      r.put("lower", it.lower)
      record.put("boll", r)
    }

    env.payload.vwap?.let {
      val schema =
        signalsSchema
          .getField("vwap")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val r = GenericData.Record(schema)
      r.put("session", it.session)
      r.put("w5m", it.w5m)
      record.put("vwap", r)
    }

    env.payload.imbalance?.let {
      val schema =
        signalsSchema
          .getField("imbalance")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val r = GenericData.Record(schema)
      r.put("spread", it.spread)
      r.put("bid_px", it.bid_px)
      r.put("ask_px", it.ask_px)
      r.put("bid_sz", it.bid_sz)
      r.put("ask_sz", it.ask_sz)
      record.put("imbalance", r)
    }

    env.payload.vol_realized?.let {
      val schema =
        signalsSchema
          .getField("vol_realized")
          .schema()
          .types
          .first { it.type == Schema.Type.RECORD }
      val r = GenericData.Record(schema)
      r.put("w60s", it.w60s)
      record.put("vol_realized", r)
    }

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

  fun pretty(record: GenericData.Record): String = record.toString()

  fun toUtf8(record: GenericData.Record): ByteArray = record.toString().toByteArray(StandardCharsets.UTF_8)
}
