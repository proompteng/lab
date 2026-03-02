package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.stream.Macd
import ai.proompteng.dorvud.ta.stream.DirectionProbabilities
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.MicrostructureSignalArtifact
import ai.proompteng.dorvud.ta.stream.MicrostructureSignalV1
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.TaStatusPayload
import org.apache.avro.generic.GenericDatumReader
import org.apache.avro.generic.GenericRecord
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

  @Test
  fun `signals encodes microstructure v1 payload`() {
    val now = Instant.parse("2025-01-01T00:00:00Z")
    val env =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "alpaca",
        channel = "signals",
        symbol = "TEST",
        seq = 3,
        payload =
          TaSignalsPayload(
            macd = Macd(macd = 1.0, signal = 0.5, hist = 0.5),
            microstructureSignalV1 =
              MicrostructureSignalV1(
                schemaVersion = "microstructure_signal_v1",
                symbol = "TEST",
                horizon = "PT1S",
                directionProbabilities = DirectionProbabilities(up = 0.35, flat = 0.3, down = 0.35),
                uncertaintyBand = "low",
                expectedSpreadImpactBps = 1.2,
                expectedSlippageBps = 0.9,
                featureQualityStatus = "pass",
                artifact =
                  MicrostructureSignalArtifact(
                    modelId = "deeplob-bdlob-v1",
                    featureSchemaVersion = "microstructure_signal_v1",
                    trainingRunId = "run-abc-123",
                  ),
              ),
          ),
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
    val microstructure = record.get("microstructure_signal_v1") as GenericRecord
    val directionProbabilities = microstructure.get("direction_probabilities") as GenericRecord
    val artifact = microstructure.get("artifact") as GenericRecord

    assertEquals("microstructure_signal_v1", microstructure.get("schema_version").toString())
    assertEquals("TEST", microstructure.get("symbol").toString())
    assertEquals(0.35, directionProbabilities.get("up"))
    assertEquals(0.3, directionProbabilities.get("flat"))
    assertEquals(0.35, directionProbabilities.get("down"))
    assertEquals("low", microstructure.get("uncertainty_band").toString())
    assertEquals(1.2, microstructure.get("expected_spread_impact_bps"))
    assertEquals(0.9, microstructure.get("expected_slippage_bps"))
    assertEquals("pass", microstructure.get("feature_quality_status").toString())
    assertEquals("deeplob-bdlob-v1", artifact.get("model_id").toString())
    assertEquals("microstructure_signal_v1", artifact.get("feature_schema_version").toString())
    assertEquals("run-abc-123", artifact.get("training_run_id").toString())
  }

  @Test
  fun `status encodes with schema`() {
    val now = Instant.parse("2025-01-01T00:00:00Z")
    val env =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "ta",
        channel = "status",
        symbol = "ta",
        seq = 3,
        payload =
          TaStatusPayload(
            watermarkLagMs = 1500L,
            lastEventTs = now.minusSeconds(5).toString(),
            status = "ok",
            heartbeat = true,
          ),
        isFinal = true,
        source = "unit",
        window = null,
        version = 1,
      )

    val bytes = serde.encodeStatus(env, "torghut.ta.status.v1")
    val schemaStream = serde.javaClass.classLoader.getResourceAsStream("schemas/ta-status.avsc") ?: error("schema missing")
    val schema =
      schemaStream.use {
        org.apache.avro.Schema
          .Parser()
          .parse(it)
      }
    val reader = GenericDatumReader<org.apache.avro.generic.GenericData.Record>(schema)
    val record = reader.read(null, DecoderFactory.get().binaryDecoder(bytes, null))
    assertEquals("ta", record.get("symbol").toString())
    assertEquals(1500L, record.get("watermark_lag_ms"))
    assertEquals("ok", record.get("status").toString())
  }
}
