package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import org.apache.flink.api.common.serialization.SerializerConfigImpl
import org.apache.flink.api.java.typeutils.runtime.kryo.KryoSerializer
import java.io.ByteArrayOutputStream
import java.io.ObjectOutputStream
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SerializationSchemasTest {
  private val serde = AvroSerde()

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
  fun `session accumulator state supports kryo copy`() {
    val serializer = KryoSerializer(SessionAccumulatorState::class.java, SerializerConfigImpl())
    val original = SessionAccumulatorState(pv = 10.5, vol = 2.0)
    val copy = serializer.copy(original)
    assertEquals(original, copy)
    assertTrue(original !== copy)
  }

  private fun assertSerializable(target: Any) {
    val baos = ByteArrayOutputStream()
    ObjectOutputStream(baos).use { it.writeObject(target) }
    assertTrue(baos.size() > 0)
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
