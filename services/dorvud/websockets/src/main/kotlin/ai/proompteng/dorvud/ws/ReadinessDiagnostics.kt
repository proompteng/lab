package ai.proompteng.dorvud.ws

import io.ktor.client.plugins.ResponseException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import org.apache.kafka.common.errors.AuthenticationException
import org.apache.kafka.common.errors.AuthorizationException
import org.apache.kafka.common.errors.ClusterAuthorizationException
import org.apache.kafka.common.errors.GroupAuthorizationException
import org.apache.kafka.common.errors.LeaderNotAvailableException
import org.apache.kafka.common.errors.NotLeaderOrFollowerException
import org.apache.kafka.common.errors.SaslAuthenticationException
import org.apache.kafka.common.errors.TimeoutException
import org.apache.kafka.common.errors.TopicAuthorizationException
import org.apache.kafka.common.errors.UnknownTopicOrPartitionException

enum class ReadinessErrorClass(
  val id: String,
) {
  Alpaca406SecondConnection("alpaca_406_second_connection"),
  AlpacaAuth("alpaca_auth"),
  KafkaAuth("kafka_auth"),
  KafkaMetadata("kafka_metadata"),
  KafkaProduce("kafka_produce"),
  Unknown("unknown"),
}

@Serializable
data class ReadinessGates(
  @SerialName("alpaca_ws") val alpacaWs: Boolean,
  val kafka: Boolean,
  @SerialName("trade_updates") val tradeUpdates: Boolean,
)

@Serializable
data class ReadinessInfo(
  val status: String,
  val ready: Boolean,
  @SerialName("error_class") val errorClass: String? = null,
  val gates: ReadinessGates,
)

internal enum class KafkaFailureContext {
  Metadata,
  Produce,
}

internal object ReadinessClassifier {
  fun readinessErrorClassForResponse(
    ready: Boolean,
    errorClass: ReadinessErrorClass?,
  ): ReadinessErrorClass? {
    if (ready) return null
    return errorClass ?: ReadinessErrorClass.Unknown
  }

  fun classifyAlpacaError(
    code: Int?,
    msg: String?,
  ): ReadinessErrorClass {
    if (code == 406) return ReadinessErrorClass.Alpaca406SecondConnection
    if (code == 401 || code == 403) return ReadinessErrorClass.AlpacaAuth

    val lowered = msg?.lowercase()
    if (lowered != null) {
      if (lowered.contains("406") || lowered.contains("connection limit")) {
        return ReadinessErrorClass.Alpaca406SecondConnection
      }
      if (lowered.contains("401") || lowered.contains("403") || lowered.contains("unauthorized") || lowered.contains("forbidden")) {
        return ReadinessErrorClass.AlpacaAuth
      }
    }

    return ReadinessErrorClass.Unknown
  }

  fun classifyAlpacaHandshakeFailure(exception: Throwable): ReadinessErrorClass? {
    val responseException = exception.findCause<ResponseException>() ?: return null
    return when (responseException.response.status.value) {
      401, 403 -> ReadinessErrorClass.AlpacaAuth
      406 -> ReadinessErrorClass.Alpaca406SecondConnection
      else -> null
    }
  }

  fun classifyKafkaFailure(
    exception: Throwable,
    context: KafkaFailureContext,
  ): ReadinessErrorClass {
    if (exception.findCause<SaslAuthenticationException>() != null ||
      exception.findCause<AuthenticationException>() != null ||
      exception.findCause<AuthorizationException>() != null ||
      exception.findCause<TopicAuthorizationException>() != null ||
      exception.findCause<GroupAuthorizationException>() != null ||
      exception.findCause<ClusterAuthorizationException>() != null
    ) {
      return ReadinessErrorClass.KafkaAuth
    }

    if (exception.findCause<TimeoutException>() != null ||
      exception.findCause<UnknownTopicOrPartitionException>() != null ||
      exception.findCause<LeaderNotAvailableException>() != null ||
      exception.findCause<NotLeaderOrFollowerException>() != null
    ) {
      return ReadinessErrorClass.KafkaMetadata
    }

    return when (context) {
      KafkaFailureContext.Metadata -> ReadinessErrorClass.KafkaMetadata
      KafkaFailureContext.Produce -> ReadinessErrorClass.KafkaProduce
    }
  }

  private inline fun <reified T : Throwable> Throwable.findCause(): T? {
    var cursor: Throwable? = this
    while (cursor != null) {
      if (cursor is T) return cursor
      cursor = cursor.cause
    }
    return null
  }
}
