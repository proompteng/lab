package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.HttpStatusCode
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal const val BROKER_ACTIVITY_VERSION = "bayn.broker-activity.v2"
internal const val BROKER_ACTIVITY_PROJECTION_CONTRACT = "bayn.broker-activity-projection.v2"
private const val MAXIMUM_ACTIVITY_CHARACTERS = 262_144
private val ACTIVITY_HISTORY_AVAILABLE_FROM = Instant.parse("2026-02-12T00:00:00Z")
internal const val ACTIVITY_HISTORY_REPLAY_FROM_ID = "01KH7JBG000000000000000000"
private const val ACTIVITY_CATCHUP_CLOCK_SAFETY_SECONDS = 5L
private val crockfordBase32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
private val activityEventId = Regex("[0-9A-HJKMNP-TV-Z]{26}")
private val activityJson =
  Json {
    encodeDefaults = true
    classDiscriminator = "_tag"
  }
private val activityTime = DateTimeFormatterBuilder().appendInstant(3).toFormatter()

@Serializable
internal data class VerifiedBrokerActivitySession(
  val identityHash: String,
  val accountId: String,
  val environment: String,
  val credentialHash: String,
  val sessionId: String,
  val sourceRevision: String,
  val verifiedAt: String,
  val connectedAt: String,
  val requestId: String,
)

@Serializable
internal sealed interface BrokerActivityMessage {
  val schemaVersion: String
  val eventId: String
  val session: VerifiedBrokerActivitySession
  val receivedAt: String

  @Serializable
  @SerialName("Event")
  @OptIn(ExperimentalSerializationApi::class)
  data class Event(
    override val eventId: String,
    override val session: VerifiedBrokerActivitySession,
    override val receivedAt: String,
    val sourceEventId: String,
    val contentHash: String,
    val refId: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val previousRefId: String? = null,
    val activityType: String,
    val activityJson: String,
    override val schemaVersion: String = BROKER_ACTIVITY_VERSION,
  ) : BrokerActivityMessage

  @Serializable
  @SerialName("CatchupComplete")
  data class CatchupComplete(
    override val eventId: String,
    override val session: VerifiedBrokerActivitySession,
    override val receivedAt: String,
    val cursor: String?,
    val replayFromId: String,
    val replayUntilId: String,
    val eventCount: Int,
    val prefixHash: String,
    val rangeRequestHash: String,
    val completionHash: String,
    override val schemaVersion: String = BROKER_ACTIVITY_VERSION,
  ) : BrokerActivityMessage

  @Serializable
  @SerialName("Heartbeat")
  data class Heartbeat(
    override val eventId: String,
    override val session: VerifiedBrokerActivitySession,
    override val receivedAt: String,
    val cursor: String?,
    override val schemaVersion: String = BROKER_ACTIVITY_VERSION,
  ) : BrokerActivityMessage
}

@Serializable
internal data class SignedBrokerActivity(
  val message: String,
  val signature: String,
  val schemaVersion: String = "bayn.signed-broker-activity.v1",
)

internal data class BrokerActivityCursorReceipt(
  val cursor: String?,
  val caughtUp: Boolean,
  val replayFromId: String?,
  val replayUntilId: String?,
  val completionHash: String?,
  val fillFeeComplete: Boolean,
  val sourceRevision: String,
)

internal fun signBrokerActivity(
  activity: BrokerActivityMessage,
  secret: String,
): SignedBrokerActivity {
  val message = activityJson.encodeToString(activity)
  require(message.length <= MAXIMUM_ACTIVITY_CHARACTERS) { "broker activity exceeds the source limit" }
  val mac = Mac.getInstance("HmacSHA256")
  mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
  val signature = mac.doFinal("$BROKER_ACTIVITY_VERSION\n$message".toByteArray(Charsets.UTF_8)).toHex()
  return SignedBrokerActivity(message, signature)
}

private fun canonicalUuid(value: String): String = UUID.fromString(value).toString().also { check(it == value) }

private data class ActivityHeader(
  val sourceEventId: String,
  val refId: String,
  val previousRefId: String?,
  val activityType: String,
  val accountId: String?,
)

private fun activityHeader(raw: String): ActivityHeader {
  val value = Json.parseToJsonElement(raw) as? JsonObject ?: error("broker activity is not an object")
  val sourceEventId = value["event_id"]?.jsonPrimitive?.content ?: error("broker activity has no event ID")
  check(sourceEventId.matches(activityEventId)) { "broker activity event ID is not a ULID" }
  val refId = canonicalUuid(value["ref_id"]?.jsonPrimitive?.content ?: error("broker activity has no reference ID"))
  val previousRefId = value["previous_id"]?.jsonPrimitive?.content?.let(::canonicalUuid)
  val activityType = value["activity_type"]?.jsonPrimitive?.content ?: error("broker activity has no type")
  check(activityType.isNotEmpty() && activityType.length <= 32) { "broker activity type is invalid" }
  return ActivityHeader(
    sourceEventId,
    refId,
    previousRefId,
    activityType,
    value["account_id"]?.jsonPrimitive?.content,
  )
}

internal fun activityPublicationUpperFrontier(at: Instant): String {
  var milliseconds = at.toEpochMilli()
  require(milliseconds >= 0) { "activity publication frontier predates the ULID epoch" }
  val result = CharArray(26) { 'Z' }
  for (index in 9 downTo 0) {
    result[index] = crockfordBase32[(milliseconds and 31L).toInt()]
    milliseconds = milliseconds ushr 5
  }
  check(milliseconds == 0L) { "activity publication frontier exceeds the ULID timestamp range" }
  return result.concatToString()
}

private data class ActivityPublication(
  val sourceEventId: String,
  val sourceEventHash: String,
)

private fun activityPrefixHash(events: List<ActivityPublication>): String =
  brokerFeedSha256(events.joinToString("\n\n") { "${it.sourceEventId}\n${it.sourceEventHash}" })

private fun activityRangeRequestHash(
  session: VerifiedBrokerActivitySession,
  replayFromId: String,
  replayUntilId: String,
): String =
  brokerFeedSha256(
    "${session.identityHash}\n${session.sessionId}\n${session.requestId}\n$replayFromId\n$replayUntilId",
  )

private fun activityCompletionHash(
  rangeRequestHash: String,
  cursor: String?,
  eventCount: Int,
  prefixHash: String,
): String = brokerFeedSha256("$rangeRequestHash\n${cursor ?: "empty"}\n$eventCount\n$prefixHash\nclean-eof")

private data class ActivityStreamResult(
  val cursor: String?,
  val session: VerifiedBrokerActivitySession,
  val publications: List<ActivityPublication>,
)

internal class VerifiedBrokerActivityFeed(
  private val connection: BrokerFeedConnection,
  private val client: HttpClient,
  private val cursor: suspend (String) -> BrokerActivityCursorReceipt,
  private val publish: suspend (String, BrokerDeliveryIdentity, SignedBrokerActivity) -> BrokerActivityCursorReceipt,
  private val completeCatchup: suspend (
    String,
    BrokerDeliveryIdentity,
    SignedBrokerActivity,
  ) -> BrokerActivityCursorReceipt,
  private val heartbeat: suspend (String, BrokerDeliveryIdentity, SignedBrokerActivity) -> BrokerActivityCursorReceipt,
  private val now: () -> Instant = Instant::now,
  private val newSessionId: () -> String = { UUID.randomUUID().toString() },
  private val onReady: () -> Unit = {},
  private val lineTimeoutMs: Long = 30_000,
) {
  suspend fun collect() {
    val response =
      client.get(connection.accountUrl) {
        header("APCA-API-KEY-ID", connection.keyId)
        header("APCA-API-SECRET-KEY", connection.secretKey)
      }
    check(response.status == HttpStatusCode.OK) { "broker activity account verification failed" }
    val account = Json.parseToJsonElement(response.body<String>()) as? JsonObject
    check(account?.get("id")?.jsonPrimitive?.content == connection.accountId) { "broker activity account mismatch" }
    val accountCreatedAt =
      account
        .get("created_at")
        ?.jsonPrimitive
        ?.content
        ?.let(Instant::parse)
        ?: error("broker activity account has no creation boundary")
    val verifiedAt = now()
    check(!accountCreatedAt.isAfter(verifiedAt)) { "broker activity account creation boundary is in the future" }
    check(!accountCreatedAt.isBefore(ACTIVITY_HISTORY_AVAILABLE_FROM)) {
      "broker activity account predates complete provider history"
    }
    val identityHash = brokerFeedIdentityHash(connection.accountId)
    var retained = cursor(identityHash)
    check(retained.sourceRevision == connection.sourceRevision) { "broker activity cursor source revision mismatch" }
    val url = Url(connection.activityUrl)
    if (!retained.caughtUp) {
      val replayFromId = ACTIVITY_HISTORY_REPLAY_FROM_ID
      val replayUntilId =
        activityPublicationUpperFrontier(verifiedAt.minusSeconds(ACTIVITY_CATCHUP_CLOCK_SAFETY_SECONDS))
      check(retained.cursor == null || checkNotNull(retained.cursor) <= replayUntilId) {
        "broker activity publication clock regressed behind the durable cursor"
      }
      val catchupEndpoint =
        URLBuilder(url)
          .apply {
            parameters.append("since_id", replayFromId)
            parameters.append("until_id", replayUntilId)
          }.build()
      val result =
        withTimeoutOrNull(120_000) {
          consume(
            catchupEndpoint,
            identityHash,
            verifiedAt,
            retained.cursor,
            replayFromId,
            replayUntilId,
          )
        } ?: error("broker activity finite replay timed out")
      check(result.publications.lastOrNull()?.sourceEventId == result.cursor) {
        "broker activity range completion does not match the retained publication cursor"
      }
      val prefixHash = activityPrefixHash(result.publications)
      val rangeRequestHash = activityRangeRequestHash(result.session, replayFromId, replayUntilId)
      val completionHash =
        activityCompletionHash(rangeRequestHash, result.cursor, result.publications.size, prefixHash)
      val receivedAt = activityTime.format(now())
      val eventId =
        brokerFeedSha256(
          "$identityHash\nactivity-catchup\n${result.session.sessionId}\n${result.cursor ?: "empty"}\n" +
            "$replayFromId\n$replayUntilId\n${result.publications.size}\n$prefixHash\n" +
            "$rangeRequestHash\n$completionHash\n$receivedAt",
        )
      val boundary =
        BrokerActivityMessage.CatchupComplete(
          eventId = eventId,
          session = result.session,
          receivedAt = receivedAt,
          cursor = result.cursor,
          replayFromId = replayFromId,
          replayUntilId = replayUntilId,
          eventCount = result.publications.size,
          prefixHash = prefixHash,
          rangeRequestHash = rangeRequestHash,
          completionHash = completionHash,
        )
      retained =
        completeCatchup(
          identityHash,
          brokerDeliveryIdentity(
            connection.sourceRevision,
            result.session.credentialHash,
            result.session.sessionId,
            "catchup",
            eventId,
          ),
          signBrokerActivity(boundary, connection.secretKey),
        )
      check(
        retained.cursor == result.cursor &&
          retained.caughtUp &&
          retained.replayFromId == replayFromId &&
          retained.replayUntilId == replayUntilId &&
          retained.completionHash == completionHash,
      ) {
        "broker activity catchup receipt did not retain the proved publication range"
      }
    }

    check(retained.caughtUp) { "broker activity publication catchup is incomplete" }
    val resumeFromId = retained.cursor ?: checkNotNull(retained.replayUntilId)
    val liveEndpoint =
      URLBuilder(url)
        .apply {
          parameters.append("since_id", resumeFromId)
        }.build()
    consume(liveEndpoint, identityHash, verifiedAt, retained.cursor, resumeFromId, null)
  }

  private suspend fun consume(
    endpoint: Url,
    identityHash: String,
    verifiedAt: Instant,
    initialCursor: String?,
    streamFromId: String,
    finiteUntilId: String?,
  ): ActivityStreamResult =
    client
      .prepareGet(endpoint) {
        header("accept", "text/event-stream")
        header("APCA-API-KEY-ID", connection.keyId)
        header("APCA-API-SECRET-KEY", connection.secretKey)
        timeout { requestTimeoutMillis = HttpTimeout.INFINITE_TIMEOUT_MS }
      }.execute { stream ->
        check(stream.status == HttpStatusCode.OK) { "broker activity stream connection failed" }
        check(stream.headers["content-type"]?.substringBefore(';') == "text/event-stream") {
          "broker activity response is not an event stream"
        }
        val requestId =
          stream.headers["x-request-id"]?.takeIf(String::isNotBlank)
            ?: error("broker activity stream has no request identity")
        val connectedAt = now()
        val session =
          VerifiedBrokerActivitySession(
            identityHash = identityHash,
            accountId = connection.accountId,
            environment = "sandbox",
            credentialHash = brokerFeedSha256(connection.keyId),
            sessionId = newSessionId(),
            sourceRevision = connection.sourceRevision,
            verifiedAt = activityTime.format(verifiedAt),
            connectedAt = activityTime.format(connectedAt),
            requestId = requestId,
          )
        val data = ArrayList<String>()
        val publications = ArrayList<ActivityPublication>()
        var characters = 0
        var sessionReady = false
        var currentCursor = initialCursor
        var lastStreamCursor = streamFromId
        val channel = stream.bodyAsChannel()
        while (true) {
          val read =
            withTimeoutOrNull(lineTimeoutMs) { Result.success(channel.readUTF8Line()) }
              ?: error("broker activity stream stopped delivering lines")
          val line = read.getOrThrow()
          if (line == null) {
            check(finiteUntilId != null) { "broker activity live stream ended" }
            check(data.isEmpty()) { "broker activity finite range ended inside an incomplete event" }
            return@execute ActivityStreamResult(currentCursor, session, publications)
          }
          when {
            line.isEmpty() -> {
              if (data.isNotEmpty()) {
                val raw = data.joinToString("\n")
                data.clear()
                characters = 0
                val header = activityHeader(raw)
                check(header.accountId == null || header.accountId == connection.accountId) {
                  "broker activity belongs to another account"
                }
                check(header.sourceEventId >= lastStreamCursor) {
                  "broker activity cursor regressed"
                }
                check(finiteUntilId == null || header.sourceEventId <= finiteUntilId) {
                  "broker activity finite range exceeded its publication boundary"
                }
                lastStreamCursor = header.sourceEventId
                val contentHash = brokerFeedSha256(raw)
                if (finiteUntilId != null) {
                  publications += ActivityPublication(header.sourceEventId, contentHash)
                  // Bayn independently compares the whole finite range with the journal before admitting coverage.
                  if (initialCursor != null && header.sourceEventId <= initialCursor) continue
                }
                val eventId = brokerFeedSha256("$identityHash\nactivity\n${header.sourceEventId}\n$contentHash")
                val event =
                  BrokerActivityMessage.Event(
                    eventId = eventId,
                    session = session,
                    receivedAt = activityTime.format(now()),
                    sourceEventId = header.sourceEventId,
                    contentHash = contentHash,
                    refId = header.refId,
                    previousRefId = header.previousRefId,
                    activityType = header.activityType,
                    activityJson = raw,
                  )
                val retained =
                  publish(
                    identityHash,
                    brokerDeliveryIdentity(
                      connection.sourceRevision,
                      session.credentialHash,
                      session.sessionId,
                      "ingest",
                      eventId,
                    ),
                    signBrokerActivity(event, connection.secretKey),
                  )
                check(checkNotNull(retained.cursor) >= header.sourceEventId) {
                  "broker activity receipt did not cover its source event"
                }
                currentCursor = retained.cursor
              }
            }
            line == ": heartbeat" || line == ":heartbeat" -> {
              if (finiteUntilId == null) {
                val receivedAt = activityTime.format(now())
                val eventId =
                  brokerFeedSha256(
                    "$identityHash\nactivity-heartbeat\n${session.sessionId}\n${currentCursor ?: "empty"}\n$receivedAt",
                  )
                val boundary =
                  BrokerActivityMessage.Heartbeat(
                    eventId = eventId,
                    session = session,
                    receivedAt = receivedAt,
                    cursor = currentCursor,
                  )
                val retained =
                  heartbeat(
                    identityHash,
                    brokerDeliveryIdentity(
                      connection.sourceRevision,
                      session.credentialHash,
                      session.sessionId,
                      "heartbeat",
                      eventId,
                    ),
                    signBrokerActivity(boundary, connection.secretKey),
                  )
                check(retained.cursor == currentCursor && retained.caughtUp) {
                  "broker activity heartbeat did not cover a caught-up durable prefix"
                }
                if (!sessionReady) {
                  sessionReady = true
                  onReady()
                }
              }
            }
            line == ": welcome to the Alpaca events" -> Unit
            line.startsWith("data:") -> {
              val value = line.removePrefix("data:").removePrefix(" ")
              characters += value.length
              check(characters <= MAXIMUM_ACTIVITY_CHARACTERS) { "broker activity frame exceeds its source limit" }
              data += value
            }
            line.startsWith(':') -> error("broker activity stream reported lost data or an internal failure")
            else -> error("broker activity stream sent an unsupported field")
          }
        }
        @Suppress("UNREACHABLE_CODE")
        error("broker activity stream loop terminated without a result")
      }
}
