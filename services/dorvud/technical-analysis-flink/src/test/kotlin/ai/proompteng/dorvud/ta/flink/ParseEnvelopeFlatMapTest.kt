package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.TradePayload
import java.io.ByteArrayOutputStream
import java.io.ObjectOutputStream
import kotlin.test.Test
import kotlin.test.assertTrue

class ParseEnvelopeFlatMapTest {
  @Test
  fun `flatmap is java-serializable`() {
    val fn = ParseEnvelopeFlatMap(SerializerFactory { TradePayload.serializer() })
    val serialized = ByteArrayOutputStream()
    ObjectOutputStream(serialized).use { it.writeObject(fn) }
    assertTrue(serialized.size() > 0)
  }
}
