package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.producer.OptionsAvroSerde
import ai.proompteng.dorvud.ta.stream.DirectionProbabilities
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.MicrostructureSignalArtifact
import ai.proompteng.dorvud.ta.stream.MicrostructureSignalV1
import ai.proompteng.dorvud.ta.stream.OptionsContractBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.TaStatusPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import kotlinx.serialization.json.Json
import org.apache.flink.api.common.serialization.SerializerConfigImpl
import org.apache.flink.api.java.typeutils.runtime.kryo.KryoSerializer
import java.io.ByteArrayOutputStream
import java.io.ObjectOutputStream
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
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
  fun `status serialization includes current processing freshness fields`() {
    val status =
      Envelope(
        ingestTs = Instant.parse("2026-07-07T14:00:05Z"),
        eventTs = Instant.parse("2026-07-07T14:00:05Z"),
        feed = "ta",
        channel = "status",
        symbol = "ta",
        seq = 1,
        payload =
          TaStatusPayload(
            watermarkLagMs = 250,
            sourceLagMs = 1_000,
            lastEventTs = "2026-07-07T14:00:04Z",
            lastInputEventTs = "2026-07-07T14:00:04Z",
            lastOutputEventTs = "2026-07-07T14:00:04Z",
            inputEventCount = 42,
            outputEventCount = 40,
            currentInputEventCount = 2,
            currentOutputEventCount = 1,
            currentRecordCount = 3,
            inputRatePerSecond = 10.5,
            outputRatePerSecond = 9.5,
            microbarEventCount = 42,
            signalEventCount = 40,
            microbarRatePerSecond = 10.5,
            signalRatePerSecond = 9.5,
            clickhouseSinkEnabled = true,
            perSymbolLatestEventTs = mapOf("NVDA" to "2026-07-07T14:00:04Z"),
            marketSessionState = "regular",
            statusReason = null,
          ),
        isFinal = true,
        source = "ta",
        window = null,
        version = 1,
      )

    val json = serde.statusJson(status)

    assertTrue(json.contains("source_lag_ms"))
    assertTrue(json.contains("last_input_event_ts"))
    assertTrue(json.contains("input_event_count"))
    assertTrue(json.contains("current_record_count"))
    assertTrue(json.contains("output_rate_per_second"))
    assertTrue(json.contains("microbar_event_count"))
    assertTrue(json.contains("signal_event_count"))
    assertTrue(json.contains("clickhouse_sink_enabled"))
    assertTrue(json.contains("market_session_state"))
    assertTrue(json.contains("per_symbol_latest_event_ts"))
    assertTrue(json.contains("NVDA"))
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
  fun `live websocket bar signals are emitted as accepted ta source`() {
    assertEquals("ta", taSignalOutputSource("ws"))
    assertEquals("ta", taSignalOutputSource("ta"))
  }

  @Test
  fun `rest backfill bar signals remain excluded from accepted ta source`() {
    assertEquals("rest", taSignalOutputSource("rest"))
  }

  @Test
  fun `flink ta config is serializable`() {
    assertSerializable(FlinkTaConfig.fromEnv())
  }

  @Test
  fun `clickhouse insert batch size is capped to safe ceiling`() {
    assertEquals(1, normalizeClickhouseInsertBatchSize(0))
    assertEquals(64, normalizeClickhouseInsertBatchSize(64))
    assertEquals(MAX_SAFE_CLICKHOUSE_INSERT_BATCH_SIZE, normalizeClickhouseInsertBatchSize(500))
  }

  @Test
  fun `clickhouse insert flush interval falls back to safe minimum`() {
    assertEquals(DEFAULT_CLICKHOUSE_INSERT_FLUSH_MS, normalizeClickhouseInsertFlushMs(0))
    assertEquals(MIN_CLICKHOUSE_INSERT_FLUSH_MS, normalizeClickhouseInsertFlushMs(10))
    assertEquals(500, normalizeClickhouseInsertFlushMs(500))
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
    assertTrue(schema.contains("ALTER TABLE torghut.ta_signals ON CLUSTER default"))
    assertTrue(schema.contains("MODIFY TTL toDateTime(event_ts) + INTERVAL 35 DAY"))
  }

  @Test
  fun `clickhouse ta table engine validation rejects local tables`() {
    val failure =
      assertFailsWith<IllegalStateException> {
        validateClickhouseTaTableEngines(
          mapOf(
            "ta_microbars" to "ReplacingMergeTree",
            "ta_signals" to "ReplicatedReplacingMergeTree",
          ),
        )
      }

    assertTrue(failure.message.orEmpty().contains("ta_microbars=ReplacingMergeTree"))
  }

  @Test
  fun `clickhouse ta table engine validation requires every ta table`() {
    val failure =
      assertFailsWith<IllegalStateException> {
        validateClickhouseTaTableEngines(mapOf("ta_signals" to "ReplicatedReplacingMergeTree"))
      }

    assertTrue(failure.message.orEmpty().contains("ta_microbars=missing"))
  }

  @Test
  fun `clickhouse ta table engine validation accepts replicated tables`() {
    validateClickhouseTaTableEngines(
      mapOf(
        "ta_microbars" to "ReplicatedReplacingMergeTree",
        "ta_signals" to "ReplicatedReplacingMergeTree",
      ),
    )
  }

  @Test
  fun `clickhouse database name is loaded from sink jdbc url`() {
    assertEquals(
      "torghut",
      clickhouseDatabaseName("jdbc:clickhouse://torghut-clickhouse.torghut.svc.cluster.local:8123/torghut"),
    )
    assertEquals(
      "torghut_sim_default",
      clickhouseDatabaseName("jdbc:clickhouse://torghut-clickhouse.torghut.svc.cluster.local:8123/default?database=torghut_sim_default"),
    )
    assertEquals("default", clickhouseDatabaseName("not a url"))
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
  fun `options clickhouse bootstrap excludes equity tables`() {
    val schema =
      javaClass
        .classLoader
        ?.getResourceAsStream("ta-schema.sql")
        ?.bufferedReader()
        ?.readText()
        ?.trim()
    assertNotNull(schema)

    val statements = optionsClickhouseSchemaStatements(schema)

    assertTrue(statements.any { it.contains("CREATE DATABASE IF NOT EXISTS torghut") })
    assertTrue(statements.any { it.contains("options_contract_bars_1s") })
    assertTrue(statements.any { it.contains("options_contract_features") })
    assertTrue(statements.any { it.contains("options_surface_features") })
    assertFalse(statements.any { it.contains("ta_microbars") })
    assertFalse(statements.any { it.contains("ta_signals") })
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
  fun `timed quote state supports kryo copy`() {
    val serializer = KryoSerializer(TimedQuoteState::class.java, SerializerConfigImpl())
    val original =
      TimedQuoteState(
        eventTs = Instant.EPOCH,
        payload =
          QuotePayload(
            bp = 100.0,
            bs = 10.0,
            ap = 100.02,
            `as` = 12.0,
            t = Instant.EPOCH,
          ),
      )
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
