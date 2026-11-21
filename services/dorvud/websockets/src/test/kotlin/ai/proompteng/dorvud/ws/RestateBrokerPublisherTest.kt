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
  private val notification =
    SignedBrokerNotification(
      message = """{"schemaVersion":"bayn.broker-notification.v1"}""",
      signature = "c".repeat(64),
      schemaVersion = "bayn.signed-broker-notification.v1",
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
            assertEquals(eventId, request.headers[RESTATE_IDEMPOTENCY_HEADER])
            assertEquals(ContentType.Application.Json, request.body.contentType)
            val body = Json.parseToJsonElement((request.body as TextContent).text).jsonObject
            assertEquals(notification.message, body.getValue("message").jsonPrimitive.content)
            assertEquals(notification.signature, body.getValue("signature").jsonPrimitive.content)
            respond(
              """{"accepted":true,"eventId":"$eventId"}""",
              HttpStatusCode.OK,
              headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
            )
          },
        )
      try {
        RestateBrokerPublisher(client, "http://restate:8080/").publish(key, eventId, notification)
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
              respond("""{"accepted":true,"eventId":"$eventId"}""")
            }
          },
        )
      try {
        RestateBrokerPublisher(client, "http://restate:8080", retryDelaysMs = listOf(0))
          .publish(key, eventId, notification)
        assertEquals(listOf<String?>(eventId, eventId), keys)
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
          RestateBrokerPublisher(client, "http://restate:8080", retryDelaysMs = listOf(0, 0))
            .publish(key, eventId, notification)
        }
        assertEquals(1, requests)
      } finally {
        client.close()
      }
    }
}
