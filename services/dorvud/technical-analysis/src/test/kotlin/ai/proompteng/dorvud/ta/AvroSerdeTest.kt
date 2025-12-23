package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.stream.Macd
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import org.apache.avro.generic.GenericDatumReader
import org.apache.avro.io.DecoderFactory
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AvroSerdeTest {
  private val serde = AvroSerde()

  @Test
  fun `microbar encodes with schema`() {
    val now = Instant.parse("2025-01-01T00:00:00Z")
    val env =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "alpaca",
        channel = "trades",
        symbol = "TEST",
        seq = 1,
        payload =
          MicroBarPayload(
            o = 10.0,
            h = 12.0,
            l = 9.5,
            c = 11.0,
            v = 100.0,
            vwap = 10.8,
            count = 3,
            t = now.plus(1, ChronoUnit.SECONDS),
          ),
        isFinal = true,
        source = "unit",
        window = Window(size = "PT1S", step = "PT1S", start = now.toString(), end = now.plusSeconds(1).toString()),
        version = 1,
      )

    val bytes = serde.encodeMicroBar(env, "torghut.ta.bars.1s.v1")
    val schemaStream = serde.javaClass.classLoader.getResourceAsStream("schemas/ta-bars-1s.avsc") ?: error("schema missing")
    val schema =
      schemaStream.use {
        org.apache.avro.Schema
          .Parser()
          .parse(it)
      }
    val reader = GenericDatumReader<org.apache.avro.generic.GenericData.Record>(schema)
    val record = reader.read(null, DecoderFactory.get().binaryDecoder(bytes, null))
    assertEquals("TEST", record.get("symbol").toString())
    assertTrue(record.get("o") != null)
  }

  @Test
  fun `signals encodes with schema`() {
    val now = Instant.parse("2025-01-01T00:00:00Z")
    val env =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "alpaca",
        channel = "signals",
        symbol = "TEST",
        seq = 2,
        payload = TaSignalsPayload(macd = Macd(macd = 1.0, signal = 0.5, hist = 0.5)),
        isFinal = true,
        source = "unit",
        window = Window(size = "PT1S", step = "PT1S", start = now.toString(), end = now.plusSeconds(1).toString()),
        version = 1,
      )

    val bytes = serde.encodeSignals(env, "torghut.ta.signals.v1")
    val schemaStream = serde.javaClass.classLoader.getResourceAsStream("schemas/ta-signals.avsc") ?: error("schema missing")
    val schema =
      schemaStream.use {
        org.apache.avro.Schema
          .Parser()
          .parse(it)
      }
    val reader = GenericDatumReader<org.apache.avro.generic.GenericData.Record>(schema)
    val record = reader.read(null, DecoderFactory.get().binaryDecoder(bytes, null))
    assertEquals("TEST", record.get("symbol").toString())
    assertEquals(1.0, record.get("macd").let { (it as org.apache.avro.generic.GenericRecord).get("macd") })
  }
}
