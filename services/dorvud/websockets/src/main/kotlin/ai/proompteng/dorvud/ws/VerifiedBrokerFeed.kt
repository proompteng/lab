package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal const val BROKER_NOTIFICATION_VERSION = "bayn.broker-notification.v1"
private val brokerFeedJson =
  Json {
    encodeDefaults = true
    classDiscriminator = "_tag"
  }
private val brokerFeedTime = DateTimeFormatterBuilder().appendInstant(3).toFormatter()

internal class BrokerFeedConnection(
  val accountId: String,
  val keyId: String,
  val secretKey: String,
  val sourceRevision: String,
  val accountUrl: String = "https://paper-api.alpaca.markets/v2/account",
  val streamUrl: String = "wss://paper-api.alpaca.markets/stream",
)

@Serializable
internal data class VerifiedBrokerSession(
  val identityHash: String,
  val accountId: String,
  val environment: String,
  val credentialHash: String,
  val sessionId: String,
  val sourceRevision: String,
  val verifiedAt: String,
  val authenticatedAt: String,
  val subscribedAt: String,
)

@Serializable
internal sealed interface BrokerFeedNotification {
  val schemaVersion: String
  val eventId: String
  val session: VerifiedBrokerSession
  val receivedAt: String

  @Serializable
  @SerialName("SessionReady")
  data class SessionReady(
    override val eventId: String,
    override val session: VerifiedBrokerSession,
    override val receivedAt: String,
    override val schemaVersion: String = BROKER_NOTIFICATION_VERSION,
  ) : BrokerFeedNotification

  @Serializable
  @SerialName("TradeUpdate")
  data class TradeUpdate(
    override val eventId: String,
    override val session: VerifiedBrokerSession,
    override val receivedAt: String,
    val frameJson: String,
    override val schemaVersion: String = BROKER_NOTIFICATION_VERSION,
  ) : BrokerFeedNotification
}

@Serializable
internal data class SignedBrokerNotification(
  val message: String,
  val signature: String,
  val schemaVersion: String,
)

internal fun brokerFeedSha256(value: String): String =
  MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).toHex()

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

// This is the existing bayn.broker-identity.v2 canonical material, not a new routing identity.
internal fun brokerFeedIdentityHash(accountId: String): String =
  brokerFeedSha256(
    buildJsonObject {
      put("accountId", accountId)
      put("environment", "sandbox")
      put("provider", "alpaca")
      put("schemaVersion", "bayn.broker-identity.v2")
    }.toString(),
  )

internal fun signBrokerNotification(
  notification: BrokerFeedNotification,
  secret: String,
): SignedBrokerNotification {
  val message = brokerFeedJson.encodeToString(notification)
  require(message.length <= 262_144) { "broker notification exceeds the source limit" }
  val mac = Mac.getInstance("HmacSHA256")
  mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
  val signature = mac.doFinal("$BROKER_NOTIFICATION_VERSION\n$message".toByteArray(Charsets.UTF_8)).toHex()
  return SignedBrokerNotification(message, signature, "bayn.signed-broker-notification.v1")
}

internal class VerifiedBrokerFeed(
  private val connection: BrokerFeedConnection,
  private val client: HttpClient,
  private val publish: suspend (String, SignedBrokerNotification) -> Unit,
  private val now: () -> Instant = Instant::now,
  private val newSessionId: () -> String = { UUID.randomUUID().toString() },
) {
  suspend fun collect() {
    val response =
      client.get(connection.accountUrl) {
        header("APCA-API-KEY-ID", connection.keyId)
        header("APCA-API-SECRET-KEY", connection.secretKey)
      }
    check(response.status == HttpStatusCode.OK) { "broker session account verification failed" }
    val account = Json.parseToJsonElement(response.body<String>()) as? JsonObject
    check(account?.get("id")?.jsonPrimitive?.content == connection.accountId) { "broker session account mismatch" }
    val verifiedAt = now()
    val identityHash = brokerFeedIdentityHash(connection.accountId)
    val sessionId = newSessionId()
    var session: VerifiedBrokerSession? = null
    client.streamAlpacaTradeUpdates(
      streamUrl = connection.streamUrl,
      keyId = connection.keyId,
      secretKey = connection.secretKey,
      now = now,
      onReady = { subscription ->
        check(verifiedAt <= subscription.authenticatedAt && subscription.authenticatedAt <= subscription.subscribedAt) {
          "broker session clock regressed"
        }
        val proof =
          VerifiedBrokerSession(
            identityHash = identityHash,
            accountId = connection.accountId,
            environment = "sandbox",
            credentialHash = brokerFeedSha256(connection.keyId),
            sessionId = sessionId,
            sourceRevision = connection.sourceRevision,
            verifiedAt = brokerFeedTime.format(verifiedAt),
            authenticatedAt = brokerFeedTime.format(subscription.authenticatedAt),
            subscribedAt = brokerFeedTime.format(subscription.subscribedAt),
          )
        publish(
          identityHash,
          signBrokerNotification(
            BrokerFeedNotification.SessionReady(
              eventId = brokerFeedSha256("$identityHash\n$sessionId\nready"),
              session = proof,
              receivedAt = brokerFeedTime.format(subscription.subscribedAt),
            ),
            connection.secretKey,
          ),
        )
        session = proof
      },
      onUpdate = { update ->
        val proof = checkNotNull(session) { "broker session proof was not published" }
        check(brokerFeedTime.format(update.receivedAt) >= proof.subscribedAt) { "broker receipt clock regressed" }
        val notification =
          BrokerFeedNotification.TradeUpdate(
            eventId = brokerFeedSha256("$identityHash\n${update.frameJson}"),
            session = proof,
            receivedAt = brokerFeedTime.format(update.receivedAt),
            frameJson = update.frameJson,
          )
        // Publication must finish durably before consuming the next update. A failure ends the
        // session; its replacement publishes a new verified readiness event for canonical gap repair.
        publish(identityHash, signBrokerNotification(notification, connection.secretKey))
      },
    )
  }
}
