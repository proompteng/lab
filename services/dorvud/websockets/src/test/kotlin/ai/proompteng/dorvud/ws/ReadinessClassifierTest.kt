package ai.proompteng.dorvud.ws

import org.apache.kafka.common.errors.RecordTooLargeException
import org.apache.kafka.common.errors.SaslAuthenticationException
import org.apache.kafka.common.errors.UnknownTopicOrPartitionException
import kotlin.test.Test
import kotlin.test.assertEquals

class ReadinessClassifierTest {
  @Test
  fun `alpaca 406 maps to connection-limit class`() {
    assertEquals(
      ReadinessErrorClass.Alpaca406SecondConnection,
      ReadinessClassifier.classifyAlpacaError(406, "connection limit exceeded"),
    )
  }

  @Test
  fun `alpaca 401 maps to auth class`() {
    assertEquals(
      ReadinessErrorClass.AlpacaAuth,
      ReadinessClassifier.classifyAlpacaError(401, "unauthorized"),
    )
  }

  @Test
  fun `alpaca message-only 406 maps to connection-limit class`() {
    assertEquals(
      ReadinessErrorClass.Alpaca406SecondConnection,
      ReadinessClassifier.classifyAlpacaError(null, "http 406 connection limit exceeded"),
    )
  }

  @Test
  fun `alpaca message-only forbidden maps to auth class`() {
    assertEquals(
      ReadinessErrorClass.AlpacaAuth,
      ReadinessClassifier.classifyAlpacaError(null, "forbidden"),
    )
  }

  @Test
  fun `kafka sasl auth maps to kafka_auth`() {
    val ex = SaslAuthenticationException("bad credentials")
    assertEquals(
      ReadinessErrorClass.KafkaAuth,
      ReadinessClassifier.classifyKafkaFailure(ex, KafkaFailureContext.Metadata),
    )
  }

  @Test
  fun `kafka unknown topic maps to kafka_metadata`() {
    val ex = UnknownTopicOrPartitionException("missing topic")
    assertEquals(
      ReadinessErrorClass.KafkaMetadata,
      ReadinessClassifier.classifyKafkaFailure(ex, KafkaFailureContext.Metadata),
    )
  }

  @Test
  fun `kafka produce failures map to kafka_produce by default`() {
    val ex = RecordTooLargeException("too big")
    assertEquals(
      ReadinessErrorClass.KafkaProduce,
      ReadinessClassifier.classifyKafkaFailure(ex, KafkaFailureContext.Produce),
    )
  }

  @Test
  fun `readiness response surfaces unknown when not ready and unset`() {
    assertEquals(
      ReadinessErrorClass.Unknown,
      ReadinessClassifier.readinessErrorClassForResponse(false, null),
    )
  }

  @Test
  fun `readiness response clears error class when ready`() {
    assertEquals(
      null,
      ReadinessClassifier.readinessErrorClassForResponse(true, ReadinessErrorClass.KafkaAuth),
    )
  }

  @Test
  fun `readiness error uses alpaca class when alpaca gate is false`() {
    val gates =
      ReadinessGates(
        alpacaWs = false,
        kafka = true,
        tradeUpdates = true,
      )
    assertEquals(
      ReadinessErrorClass.Alpaca406SecondConnection,
      ReadinessClassifier.readinessErrorClassForGates(
        ready = false,
        gates = gates,
        alpacaErrorClass = ReadinessErrorClass.Alpaca406SecondConnection,
        kafkaErrorClass = ReadinessErrorClass.KafkaAuth,
        tradeUpdatesErrorClass = ReadinessErrorClass.AlpacaAuth,
        fallbackErrorClass = ReadinessErrorClass.Unknown,
      ),
    )
  }

  @Test
  fun `readiness error does not fall back to other classes when alpaca gate is false`() {
    val gates =
      ReadinessGates(
        alpacaWs = false,
        kafka = true,
        tradeUpdates = true,
      )
    assertEquals(
      ReadinessErrorClass.Unknown,
      ReadinessClassifier.readinessErrorClassForGates(
        ready = false,
        gates = gates,
        alpacaErrorClass = null,
        kafkaErrorClass = ReadinessErrorClass.KafkaAuth,
        tradeUpdatesErrorClass = null,
        fallbackErrorClass = ReadinessErrorClass.KafkaAuth,
      ),
    )
  }

  @Test
  fun `readiness error uses kafka class when kafka gate is false`() {
    val gates =
      ReadinessGates(
        alpacaWs = true,
        kafka = false,
        tradeUpdates = true,
      )
    assertEquals(
      ReadinessErrorClass.KafkaAuth,
      ReadinessClassifier.readinessErrorClassForGates(
        ready = false,
        gates = gates,
        alpacaErrorClass = ReadinessErrorClass.AlpacaAuth,
        kafkaErrorClass = ReadinessErrorClass.KafkaAuth,
        tradeUpdatesErrorClass = null,
        fallbackErrorClass = ReadinessErrorClass.Unknown,
      ),
    )
  }

  @Test
  fun `readiness error uses trade updates class when trade gate is false`() {
    val gates =
      ReadinessGates(
        alpacaWs = true,
        kafka = true,
        tradeUpdates = false,
      )
    assertEquals(
      ReadinessErrorClass.AlpacaAuth,
      ReadinessClassifier.readinessErrorClassForGates(
        ready = false,
        gates = gates,
        alpacaErrorClass = ReadinessErrorClass.Alpaca406SecondConnection,
        kafkaErrorClass = ReadinessErrorClass.KafkaAuth,
        tradeUpdatesErrorClass = ReadinessErrorClass.AlpacaAuth,
        fallbackErrorClass = ReadinessErrorClass.Unknown,
      ),
    )
  }

  @Test
  fun `readiness error falls back to unknown when all gates true`() {
    val gates =
      ReadinessGates(
        alpacaWs = true,
        kafka = true,
        tradeUpdates = true,
      )
    assertEquals(
      ReadinessErrorClass.Unknown,
      ReadinessClassifier.readinessErrorClassForGates(
        ready = false,
        gates = gates,
        alpacaErrorClass = null,
        kafkaErrorClass = null,
        tradeUpdatesErrorClass = null,
        fallbackErrorClass = null,
      ),
    )
  }
}
