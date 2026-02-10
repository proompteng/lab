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
}
