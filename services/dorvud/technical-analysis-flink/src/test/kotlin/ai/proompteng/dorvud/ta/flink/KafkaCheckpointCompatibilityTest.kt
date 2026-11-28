package ai.proompteng.dorvud.ta.flink

import org.apache.flink.connector.kafka.source.enumerator.KafkaSourceEnumStateSerializer
import org.apache.flink.connector.kafka.source.split.KafkaPartitionSplit
import org.apache.flink.connector.kafka.source.split.KafkaPartitionSplitSerializer
import org.apache.kafka.common.TopicPartition
import java.io.IOException
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class KafkaCheckpointCompatibilityTest {
  @Test
  fun `restores exact bounded offsets from connector 4 checkpoints`() {
    val split = KafkaPartitionSplitSerializer().deserialize(0, decode(BOUNDED_SPLIT))

    assertEquals(TopicPartition("upgrade-input", 7), split.topicPartition)
    assertEquals(9_007_199_254_740_993L, split.startingOffset)
    assertEquals(9_007_199_254_741_093L, split.stoppingOffset.orElseThrow())
  }

  @Test
  fun `preserves committed offset and unbounded markers`() {
    val split = KafkaPartitionSplitSerializer().deserialize(0, decode(COMMITTED_SPLIT))

    assertEquals(TopicPartition("upgrade-input", 8), split.topicPartition)
    assertEquals(KafkaPartitionSplit.COMMITTED_OFFSET, split.startingOffset)
    assertTrue(split.stoppingOffset.isEmpty)
  }

  @Test
  fun `migrates enumerator assignments without losing discovery state`() {
    for ((fixture, discovered) in listOf(UNDISCOVERED_ENUMERATOR to false, DISCOVERED_ENUMERATOR to true)) {
      val state = KafkaSourceEnumStateSerializer().deserialize(2, decode(fixture))

      assertEquals(
        setOf(TopicPartition("upgrade-input", 7), TopicPartition("upgrade-input", 8)),
        state.assignedSplits().map { it.topicPartition }.toSet(),
      )
      assertEquals(setOf(TopicPartition("upgrade-input", 9)), state.unassignedSplits().map { it.topicPartition }.toSet())
      assertEquals(discovered, state.initialDiscoveryFinished())
      assertTrue(state.assignedSplits().all { it.isMigrated })
    }
  }

  @Test
  fun `rejects truncated checkpoint payloads`() {
    assertFailsWith<IOException> { KafkaPartitionSplitSerializer().deserialize(0, decode(BOUNDED_SPLIT).copyOf(4)) }
    assertFailsWith<IOException> { KafkaSourceEnumStateSerializer().deserialize(2, decode(DISCOVERED_ENUMERATOR).copyOf(4)) }
  }

  private fun decode(value: String): ByteArray = Base64.getDecoder().decode(value)

  private companion object {
    // Produced by released connector 4.0.1-2.0 serializers, not by the upgraded dependency.
    // Source JAR SHA256: 842885a51c768b2f31c946a2071656c166ee8cc6d3c02fe6c557e134e03bf228.
    const val BOUNDED_SPLIT = "AA11cGdyYWRlLWlucHV0AAAABwAgAAAAAAABACAAAAAAAGU="
    const val COMMITTED_SPLIT = "AA11cGdyYWRlLWlucHV0AAAACP/////////9gAAAAAAAAAA="
    const val UNDISCOVERED_ENUMERATOR =
      "AAAAAwANdXBncmFkZS1pbnB1dAAAAAcAAAAAAA11cGdyYWRlLWlucHV0AAAACQAAAAEADXVwZ3JhZGUtaW5wdXQAAAAIAAAAAAA="
    const val DISCOVERED_ENUMERATOR =
      "AAAAAwANdXBncmFkZS1pbnB1dAAAAAgAAAAAAA11cGdyYWRlLWlucHV0AAAABwAAAAAADXVwZ3JhZGUtaW5wdXQAAAAJAAAAAQE="
  }
}
