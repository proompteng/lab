package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.producer.OptionsAvroSerde
import ai.proompteng.dorvud.ta.stream.OptionsContractFeaturePayload
import org.apache.avro.Schema
import org.apache.avro.generic.GenericDatumReader
import org.apache.avro.io.DecoderFactory
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OptionsAvroSerdeTest {
  private val serde = OptionsAvroSerde()

  @Test
  fun `contract feature encodes documented options fields`() {
    val now = Instant.parse("2026-03-08T15:30:00Z")
    val envelope =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "opra",
        channel = "contract-features",
        symbol = "AAPL260320C00100000",
        seq = 7,
        payload =
          OptionsContractFeaturePayload(
            underlyingSymbol = "AAPL",
            expirationDate = "2026-03-20",
            strikePrice = 100.0,
            optionType = "call",
            dte = 12,
            moneyness = 0.03,
            spreadAbs = 0.12,
            spreadBps = 58.5,
            bidSize = 12.0,
            askSize = 14.0,
            quoteImbalance = -0.0769230769,
            tradeCountW60s = 11,
            notionalW60s = 1520.4,
            quoteUpdatesW60s = 24,
            realizedVolW60s = 0.18,
            impliedVolatility = 0.31,
            ivChangeW60s = 0.02,
            delta = 0.49,
            deltaChangeW60s = 0.03,
            gamma = 0.04,
            theta = -0.02,
            vega = 0.18,
            rho = 0.01,
            midPrice = 2.05,
            markPrice = 2.04,
            midChangeW60s = 0.12,
            markChangeW60s = 0.11,
            staleQuote = false,
            staleSnapshot = false,
            featureQualityStatus = "ok",
          ),
        isFinal = true,
        source = "flink",
        window = Window(size = "PT1S", step = "PT1S", start = now.minusSeconds(1).toString(), end = now.toString()),
        version = 1,
      )

    val bytes = serde.encodeContractFeature(envelope, "torghut.options.ta.contract-features.v1")
    val record = decode(bytes, "schemas/options-contract-features.avsc")

    assertEquals("AAPL260320C00100000", record.get("symbol").toString())
    assertEquals("AAPL", record.get("underlying_symbol").toString())
    assertEquals("call", record.get("option_type").toString())
    assertEquals(0.03, record.get("moneyness") as Double, 1e-9)
    assertEquals(0.31, record.get("implied_volatility") as Double, 1e-9)
    assertEquals("ok", record.get("feature_quality_status").toString())
    assertTrue(record.get("stale_quote") as Boolean == false)
    assertEquals(1, record.get("version"))
  }

  private fun decode(
    bytes: ByteArray,
    schemaPath: String,
  ): org.apache.avro.generic.GenericData.Record {
    val schema = loadSchema(schemaPath)
    val reader = GenericDatumReader<org.apache.avro.generic.GenericData.Record>(schema)
    return reader.read(null, DecoderFactory.get().binaryDecoder(bytes, null))
  }

  private fun loadSchema(path: String): Schema {
    val schemaStream = serde.javaClass.classLoader.getResourceAsStream(path) ?: error("schema missing: $path")
    return schemaStream.use { Schema.Parser().parse(it) }
  }
}
