package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class RestateBrokerPublisherTest {
  private val key = "a".repeat(64)
  private val eventId = "b".repeat(64)
  private val sourceRevision = "d".repeat(40)
  private val credentialHash = "f".repeat(64)
  private val notificationDelivery =
    brokerDeliveryIdentity(sourceRevision, credentialHash, "session-1", "notify", eventId)
  private val receipt =
    """{"accepted":true,"eventId":"$eventId","sourceRevision":"$sourceRevision","projectionContract":"$BROKER_SOURCE_PROJECTION_CONTRACT"}"""
  private val notification =
    SignedBrokerNotification(
      message = """{"schemaVersion":"bayn.broker-notification.v1"}""",
      signature = "c".repeat(64),
      schemaVersion = "bayn.signed-broker-notification.v1",
    )
  private val activity =
    SignedBrokerActivity(
      message = """{"schemaVersion":"bayn.broker-activity.v2"}""",
      signature = "e".repeat(64),
    )

  @Test
  fun `posts one signed event to the account keyed Restate object with durable idempotency`() =
    runBlocking {
      var requests = 0
      val client =
        HttpClient(
          MockEngine { request ->
            requests += 1
            assertEquals(HttpMethod.Post, request.method)
            assertEquals("/BaynBrokerObservations/$key/notify", request.url.encodedPath)
            assertEquals(notificationDelivery.deliveryId, request.headers[RESTATE_IDEMPOTENCY_HEADER])
            assertEquals(ContentType.Application.Json, request.body.contentType)
            val body = Json.parseToJsonElement((request.body as TextContent).text).jsonObject
            assertEquals(notification.schemaVersion, body.getValue("schemaVersion").jsonPrimitive.content)
            assertEquals(notification.message, body.getValue("message").jsonPrimitive.content)
            assertEquals(notification.signature, body.getValue("signature").jsonPrimitive.content)
            respond(
              receipt,
              HttpStatusCode.OK,
              headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
            )
          },
        )
      try {
        RestateBrokerPublisher(client, "http://restate:8080/", sourceRevision)
          .publish(key, notificationDelivery, notification)
        assertEquals(1, requests)
      } finally {
        client.close()
      }
    }

  @Test
  fun `retries an uncertain server response with the same idempotency key`() =
    runBlocking {
      val keys = mutableListOf<String?>()
      val client =
        HttpClient(
          MockEngine { request ->
            keys += request.headers[RESTATE_IDEMPOTENCY_HEADER]
            if (keys.size == 1) {
              respond("unavailable", HttpStatusCode.ServiceUnavailable)
            } else {
              respond(receipt)
            }
          },
        )
      try {
        RestateBrokerPublisher(client, "http://restate:8080", sourceRevision, retryDelaysMs = listOf(0))
          .publish(key, notificationDelivery, notification)
        assertEquals(listOf<String?>(notificationDelivery.deliveryId, notificationDelivery.deliveryId), keys)
      } finally {
        client.close()
      }
    }

  @Test
  fun `uses the durable activity owner for cursor catchup live events and heartbeats`() =
    runBlocking {
      val requests = mutableListOf<Pair<String, String?>>()
      val cursor = "00000000000000000000000001"
      val deliveries =
        mapOf(
          "ingest" to brokerDeliveryIdentity(sourceRevision, credentialHash, "session-1", "ingest", eventId),
          "catchup" to brokerDeliveryIdentity(sourceRevision, credentialHash, "session-1", "catchup", eventId),
          "heartbeat" to brokerDeliveryIdentity(sourceRevision, credentialHash, "session-1", "heartbeat", eventId),
        )
      val client =
        HttpClient(
          MockEngine { request ->
            requests += request.url.encodedPath to request.headers[RESTATE_IDEMPOTENCY_HEADER]
            val lifecycle = request.url.encodedPath.substringAfterLast('/')
            val accepted = lifecycle != "cursor"
            if (accepted) {
              assertEquals(ContentType.Application.Json, request.body.contentType)
              val body = Json.parseToJsonElement((request.body as TextContent).text).jsonObject
              assertEquals("bayn.signed-broker-activity.v1", body.getValue("schemaVersion").jsonPrimitive.content)
              assertEquals(activity.message, body.getValue("message").jsonPrimitive.content)
              assertEquals(activity.signature, body.getValue("signature").jsonPrimitive.content)
            }
            respond(
              """{"cursor":"$cursor","caughtUp":true,"replayFromId":"$ACTIVITY_HISTORY_REPLAY_FROM_ID","replayUntilId":"$cursor","completionHash":"${"1".repeat(
                64,
              )}","fillFeeComplete":true,"sourceRevision":"$sourceRevision","projectionContract":"$BROKER_ACTIVITY_PROJECTION_CONTRACT"${if (accepted) ",\"accepted\":true,\"eventId\":\"$eventId\"" else ""}}""",
              HttpStatusCode.OK,
              headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
            )
          },
        )
      try {
        val publisher = RestateBrokerPublisher(client, "http://restate:8080", sourceRevision)
        assertEquals(cursor, publisher.activityCursor(key).cursor)
        assertEquals(cursor, publisher.publishActivity(key, deliveries.getValue("ingest"), activity).cursor)
        assertEquals(cursor, publisher.completeActivityCatchup(key, deliveries.getValue("catchup"), activity).cursor)
        assertEquals(
          cursor,
          publisher.publishActivityHeartbeat(key, deliveries.getValue("heartbeat"), activity).cursor,
        )
        assertEquals(
          listOf(
            "/BaynBrokerActivities/$key/cursor" to null,
            "/BaynBrokerActivities/$key/ingest" to deliveries.getValue("ingest").deliveryId,
            "/BaynBrokerActivities/$key/catchup" to deliveries.getValue("catchup").deliveryId,
            "/BaynBrokerActivities/$key/heartbeat" to deliveries.getValue("heartbeat").deliveryId,
          ),
          requests,
        )
      } finally {
        client.close()
      }
    }

  @Test
  fun `does not retry a rejected or mismatched notification`() =
    runBlocking {
      var requests = 0
      val client =
        HttpClient(
          MockEngine {
            requests += 1
            respond("rejected", HttpStatusCode.BadRequest)
          },
        )
      try {
        assertFailsWith<IllegalStateException> {
          RestateBrokerPublisher(client, "http://restate:8080", sourceRevision, retryDelaysMs = listOf(0, 0))
            .publish(key, notificationDelivery, notification)
        }
        assertEquals(1, requests)
      } finally {
        client.close()
      }
    }

  @Test
  fun `rejects an acceptance from the retired identity-only handler`() =
    runBlocking {
      val client = HttpClient(MockEngine { respond("""{"accepted":true,"eventId":"$eventId"}""") })
      try {
        assertFailsWith<IllegalStateException> {
          RestateBrokerPublisher(client, "http://restate:8080", sourceRevision)
            .publish(key, notificationDelivery, notification)
        }
      } finally {
        client.close()
      }
    }

  @Test
  fun `keeps economic identity stable while rotating transport delivery across sessions and revisions`() {
    val sameSession = brokerDeliveryIdentity(sourceRevision, credentialHash, "session-1", "ingest", eventId)
    assertEquals(sameSession, brokerDeliveryIdentity(sourceRevision, credentialHash, "session-1", "ingest", eventId))
    assertEquals(eventId, sameSession.eventId)
    kotlin.test.assertNotEquals(
      sameSession.deliveryId,
      brokerDeliveryIdentity(sourceRevision, credentialHash, "session-2", "ingest", eventId).deliveryId,
    )
    kotlin.test.assertNotEquals(
      sameSession.deliveryId,
      brokerDeliveryIdentity("e".repeat(40), credentialHash, "session-1", "ingest", eventId).deliveryId,
    )
    kotlin.test.assertNotEquals(
      sameSession.deliveryId,
      brokerDeliveryIdentity(sourceRevision, "0".repeat(64), "session-1", "ingest", eventId).deliveryId,
    )
  }
}
