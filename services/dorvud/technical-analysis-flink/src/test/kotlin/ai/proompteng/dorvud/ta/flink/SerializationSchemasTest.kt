package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.producer.OptionsAvroSerde
import ai.proompteng.dorvud.ta.stream.DirectionProbabilities
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.MicrostructureSignalArtifact
import ai.proompteng.dorvud.ta.stream.MicrostructureSignalV1
import ai.proompteng.dorvud.ta.stream.OptionsContractBarPayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import kotlinx.serialization.json.Json
import org.apache.flink.api.common.serialization.SerializerConfigImpl
import org.apache.flink.api.java.typeutils.runtime.kryo.KryoSerializer
import java.io.ByteArrayOutputStream
import java.io.ObjectOutputStream
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class SerializationSchemasTest {
  private val serde = AvroSerde()
  private val optionsSerde = OptionsAvroSerde()

  @Test
  fun `microbar serialization schema is java-serializable`() {
    val schema = MicroBarSerializationSchema("topic", serde)
    assertSerializable(schema)
  }

  @Test
  fun `signal serialization schema is java-serializable`() {
    val schema = SignalSerializationSchema("topic", serde)
    assertSerializable(schema)
  }

  @Test
  fun `status serialization schema is java-serializable`() {
    val schema = StatusSerializationSchema("topic", serde)
    assertSerializable(schema)
  }

  @Test
  fun `parse envelope flatmap remains serializable`() {
    val fn = ParseEnvelopeFlatMap(SerializerFactory { TradePayload.serializer() })
    assertSerializable(fn)
  }

  @Test
  fun `bars1m compat flatmap remains serializable`() {
    val fn = ParseMicroBarCompatFlatMap()
    assertSerializable(fn)
  }

  @Test
  fun `flink ta config is serializable`() {
    assertSerializable(FlinkTaConfig.fromEnv())
  }

  @Test
  fun `avro serde is java-serializable`() {
    assertSerializable(serde)
  }

  @Test
  fun `options avro serde is java-serializable`() {
    assertSerializable(optionsSerde)
  }

  @Test
  fun `clickhouse signals insert statement includes microstructure payload column`() {
    val sql = clickhouseSignalsInsertSql()
    assertTrue(sql.contains("microstructure_signal_v1"))
    assertEquals(29, sql.count { it == '?' })
  }

  @Test
  fun `microstructure signal serializes deterministically for clickhouse`() {
    val signal =
      MicrostructureSignalV1(
        schemaVersion = "microstructure_signal_v1",
        symbol = "AAPL",
        horizon = "1s",
        directionProbabilities =
          DirectionProbabilities(
            up = 0.33,
            flat = 0.34,
            down = 0.33,
          ),
        uncertaintyBand = "medium",
        expectedSpreadImpactBps = 1.23,
        expectedSlippageBps = 2.34,
        featureQualityStatus = "pass",
        artifact =
          MicrostructureSignalArtifact(
            modelId = "model-a",
            featureSchemaVersion = "v6/11",
            trainingRunId = "run-a",
          ),
      )

    val serialized = serializeMicrostructureSignalV1(signal)
    assertNotNull(serialized)

    val decoded = Json.decodeFromString<MicrostructureSignalV1>(serialized)
    assertEquals(signal, decoded)
  }

  @Test
  fun `ta signals clickhouse schema contains microstructure payload column`() {
    val schema =
      javaClass
        .classLoader
        ?.getResourceAsStream("ta-schema.sql")
        ?.bufferedReader()
        ?.readText()
        ?.trim()
    assertNotNull(schema)
    assertTrue(schema.contains("microstructure_signal_v1 Nullable(String)"))
  }

  @Test
  fun `options clickhouse schema contains contract feature tables`() {
    val schema =
      javaClass
        .classLoader
        ?.getResourceAsStream("ta-schema.sql")
        ?.bufferedReader()
        ?.readText()
        ?.trim()
    assertNotNull(schema)
    assertTrue(schema.contains("options_contract_bars_1s"))
    assertTrue(schema.contains("options_contract_features"))
    assertTrue(schema.contains("options_surface_features"))
  }

  @Test
  fun `options contract bar serialization schema is java-serializable`() {
    val schema = OptionsContractBarSerializationSchema("topic", optionsSerde)
    assertSerializable(schema)
  }

  @Test
  fun `options contract bar avro encoder produces bytes`() {
    val bytes =
      optionsSerde.encodeContractBar(
        Envelope(
          ingestTs = Instant.EPOCH,
          eventTs = Instant.EPOCH,
          feed = "opra",
          channel = "contract-bars",
          symbol = "AAPL260320C00100000",
          seq = 1,
          payload =
            OptionsContractBarPayload(
              underlyingSymbol = "AAPL",
              expirationDate = "2026-03-20",
              strikePrice = 100.0,
              optionType = "call",
              dte = 12,
              o = 2.0,
              h = 2.1,
              l = 1.9,
              c = 2.05,
              v = 10.0,
              count = 3,
            ),
          isFinal = true,
          source = "flink",
          version = 1,
        ),
        "torghut.options.ta.contract-bars.1s.v1",
      )
    assertTrue(bytes.isNotEmpty())
  }

  @Test
  fun `session accumulator state supports kryo copy`() {
    val serializer = KryoSerializer(SessionAccumulatorState::class.java, SerializerConfigImpl())
    val original = SessionAccumulatorState(pv = 10.5, vol = 2.0)
    val copy = serializer.copy(original)
    assertEquals(original, copy)
    assertTrue(original !== copy)
  }

  @Test
  fun `options input supports kryo copy`() {
    val original = OptionsInput()
    assertKryoCopy(OptionsInput::class.java, original)
  }

  @Test
  fun `options bar accumulator supports kryo copy`() {
    val original = OptionsBarAccumulator(windowStartMs = 0L, windowEndMs = 1000L, underlyingSymbol = "AAPL")
    assertKryoCopy(OptionsBarAccumulator::class.java, original)
  }

  private fun assertSerializable(target: Any) {
    val baos = ByteArrayOutputStream()
    ObjectOutputStream(baos).use { it.writeObject(target) }
    assertTrue(baos.size() > 0)
  }

  private fun <T : Any> assertKryoCopy(
    type: Class<T>,
    original: T,
  ) {
    val serializer = KryoSerializer(type, SerializerConfigImpl())
    val copy = serializer.copy(original)
    assertEquals(original, copy)
    assertTrue(original !== copy)
  }

  // Build a minimal envelope for potential schema usage if needed later
  private fun sampleEnvelope(): Envelope<MicroBarPayload> =
    Envelope(
      ingestTs = Instant.EPOCH,
      eventTs = Instant.EPOCH,
      feed = "test",
      channel = "test",
      symbol = "ABC",
      seq = 1,
      payload = MicroBarPayload(o = 1.0, h = 1.0, l = 1.0, c = 1.0, v = 1.0, vwap = 1.0, count = 1, t = Instant.EPOCH),
      isFinal = true,
      source = "test",
      window = null,
      version = 1,
    )
}
