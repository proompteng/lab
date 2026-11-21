package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.ContentType
import io.ktor.server.application.call
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.time.Instant
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import io.ktor.client.engine.cio.CIO as ClientCIO

class VerifiedBrokerActivityFeedTest {
  private val accountId = "00000000-0000-4000-8000-000000000001"
  private val sourceEventId = "00000000000000000000000001"
  private val refId = "00000000-0000-4000-8000-000000000002"
  private val orderId = "00000000-0000-4000-8000-000000000003"

  @Test
  fun `persists each exact activity before readiness and resumes from the durable inclusive cursor`() =
    runBlocking {
      val queries = ConcurrentLinkedQueue<String>()
      val publications = ConcurrentLinkedQueue<BrokerActivityMessage.Event>()
      val readiness = AtomicInteger()
      val sessions = AtomicInteger()
      val raw =
        """{"activity_type":"TRD","event_id":"$sourceEventId","ref_id":"$refId","account_id":"$accountId","executed_at":"2026-11-21T16:00:00.123456789Z","price":"100.25","qty":"1","details":{"order_id":"$orderId","cum_qty":"1","leaves_qty":"0","symbol":"AAPL","side":"buy","execution_type":"fill","order_status":"filled"}}"""
      val server =
        embeddedServer(CIO, port = 0) {
          routing {
            get("/v2/account") {
              call.respondText(
                """{"id":"$accountId","created_at":"2026-07-22T16:32:23.149747Z"}""",
                ContentType.Application.Json,
              )
            }
            get("/v2beta1/events/activities") {
              queries +=
                call.request.queryParameters
                  .entries()
                  .joinToString("&") { (key, values) -> "$key=${values.single()}" }
              call.response.header("x-request-id", "activity-request-${queries.size}")
              call.respondText(
                if (call.request.queryParameters.contains("until")) {
                  ": welcome to the Alpaca events\n\ndata: $raw\n\n"
                } else {
                  ": welcome to the Alpaca events\n\ndata: $raw\n\n: heartbeat\n\n"
                },
                ContentType.parse("text/event-stream"),
              )
            }
          }
        }.start(wait = false)
      val port = server.resolvedConnectors().single().port
      val client = HttpClient(ClientCIO) { install(HttpTimeout) }
      var cursor: String? = null
      var caughtUp = false
      var coveredThrough: String? = null
      val protocolJson = Json { classDiscriminator = "_tag" }
      val connection =
        BrokerFeedConnection(
          accountId = accountId,
          keyId = "test-key",
          secretKey = "test-secret",
          sourceRevision = "a".repeat(40),
          accountUrl = "http://127.0.0.1:$port/v2/account",
          streamUrl = "ws://127.0.0.1:$port/unused",
          activityUrl = "http://127.0.0.1:$port/v2beta1/events/activities",
        )
      val feed =
        VerifiedBrokerActivityFeed(
          connection,
          client,
          cursor = {
            BrokerActivityCursorReceipt(cursor, caughtUp, coveredThrough, true, connection.sourceRevision)
          },
          publish = { key, eventId, signed ->
            assertEquals(brokerFeedIdentityHash(accountId), key)
            val event = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(event is BrokerActivityMessage.Event)
            assertEquals(eventId, event.eventId)
            publications += event
            cursor = event.sourceEventId
            BrokerActivityCursorReceipt(cursor, caughtUp, coveredThrough, true, connection.sourceRevision)
          },
          completeCatchup = { _, eventId, signed ->
            val boundary = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(boundary is BrokerActivityMessage.CatchupComplete)
            assertEquals(eventId, boundary.eventId)
            assertEquals(cursor, boundary.cursor)
            caughtUp = true
            coveredThrough = boundary.coveredThrough
            BrokerActivityCursorReceipt(cursor, caughtUp, coveredThrough, true, connection.sourceRevision)
          },
          heartbeat = { _, eventId, signed ->
            val boundary = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(boundary is BrokerActivityMessage.Heartbeat)
            assertEquals(eventId, boundary.eventId)
            assertEquals(cursor, boundary.cursor)
            BrokerActivityCursorReceipt(cursor, caughtUp, coveredThrough, true, connection.sourceRevision)
          },
          now = { Instant.parse("2026-11-21T16:00:01Z") },
          newSessionId = { "activity-session-${sessions.incrementAndGet()}" },
          onReady = { readiness.incrementAndGet() },
        )
      try {
        assertFailsWith<IllegalStateException> { feed.collect() }
        assertFailsWith<IllegalStateException> { feed.collect() }
        assertEquals(
          listOf(
            "since=2026-07-22T16:32:23.149Z&until=2026-11-21T16:00:01.000Z",
            "since_id=$sourceEventId",
            "since_id=$sourceEventId",
          ),
          queries.toList(),
        )
        assertEquals(2, readiness.get())
        assertEquals(3, publications.size)
        assertEquals(raw, publications.first().activityJson)
        assertEquals(sourceEventId, publications.last().sourceEventId)
        assertEquals(refId, publications.last().refId)
        assertTrue(publications.all { it.contentHash == brokerFeedSha256(raw) })
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }

  @Test
  fun `unfinished finite catchup replays from account creation without regressing its durable cursor`() =
    runBlocking {
      val olderSourceEventId = "00000000000000000000000000"
      val publications = AtomicInteger()
      val readiness = AtomicInteger()
      val raw =
        """{"activity_type":"TRD","event_id":"$olderSourceEventId","ref_id":"$refId","account_id":"$accountId","executed_at":"2026-11-21T16:00:00.123456789Z","price":"100.25","qty":"1","details":{"order_id":"$orderId","cum_qty":"1","leaves_qty":"0","symbol":"AAPL","side":"buy","execution_type":"fill","order_status":"filled"}}"""
      val server =
        embeddedServer(CIO, port = 0) {
          routing {
            get("/v2/account") {
              call.respondText(
                """{"id":"$accountId","created_at":"2026-07-22T16:32:23.149747Z"}""",
                ContentType.Application.Json,
              )
            }
            get("/v2beta1/events/activities") {
              call.response.header("x-request-id", "partial-catchup-request")
              call.respondText(
                if (call.request.queryParameters.contains("until")) "data: $raw\n\n" else ": heartbeat\n\n",
                ContentType.parse("text/event-stream"),
              )
            }
          }
        }.start(wait = false)
      val port = server.resolvedConnectors().single().port
      val client = HttpClient(ClientCIO) { install(HttpTimeout) }
      val protocolJson = Json { classDiscriminator = "_tag" }
      var caughtUp = false
      var coveredThrough: String? = null
      val connection =
        BrokerFeedConnection(
          accountId = accountId,
          keyId = "test-key",
          secretKey = "test-secret",
          sourceRevision = "a".repeat(40),
          accountUrl = "http://127.0.0.1:$port/v2/account",
          streamUrl = "ws://127.0.0.1:$port/unused",
          activityUrl = "http://127.0.0.1:$port/v2beta1/events/activities",
        )
      val receipt = {
        BrokerActivityCursorReceipt(sourceEventId, caughtUp, coveredThrough, true, connection.sourceRevision)
      }
      val feed =
        VerifiedBrokerActivityFeed(
          connection,
          client,
          cursor = { receipt() },
          publish = { _, _, signed ->
            val event = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(event is BrokerActivityMessage.Event)
            assertEquals(olderSourceEventId, event.sourceEventId)
            publications.incrementAndGet()
            receipt()
          },
          completeCatchup = { _, _, signed ->
            val boundary = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(boundary is BrokerActivityMessage.CatchupComplete)
            assertEquals(sourceEventId, boundary.cursor)
            caughtUp = true
            coveredThrough = boundary.coveredThrough
            receipt()
          },
          heartbeat = { _, _, _ -> receipt() },
          now = { Instant.parse("2026-11-21T16:00:01Z") },
          onReady = { readiness.incrementAndGet() },
        )
      try {
        assertFailsWith<IllegalStateException> { feed.collect() }
        assertEquals(1, publications.get())
        assertEquals(1, readiness.get())
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }

  @Test
  fun `rejects an account whose complete history predates provider retention`() =
    runBlocking {
      val activityRequests = AtomicInteger()
      val durableCalls = AtomicInteger()
      val server =
        embeddedServer(CIO, port = 0) {
          routing {
            get("/v2/account") {
              call.respondText(
                """{"id":"$accountId","created_at":"2026-02-11T23:59:59.999Z"}""",
                ContentType.Application.Json,
              )
            }
            get("/v2beta1/events/activities") {
              activityRequests.incrementAndGet()
              call.respondText(": heartbeat\n\n", ContentType.parse("text/event-stream"))
            }
          }
        }.start(wait = false)
      val port = server.resolvedConnectors().single().port
      val client = HttpClient(ClientCIO) { install(HttpTimeout) }
      val connection =
        BrokerFeedConnection(
          accountId = accountId,
          keyId = "test-key",
          secretKey = "test-secret",
          sourceRevision = "a".repeat(40),
          accountUrl = "http://127.0.0.1:$port/v2/account",
          streamUrl = "ws://127.0.0.1:$port/unused",
          activityUrl = "http://127.0.0.1:$port/v2beta1/events/activities",
        )
      val unavailable = {
        durableCalls.incrementAndGet()
        BrokerActivityCursorReceipt(null, false, null, false, connection.sourceRevision)
      }
      val feed =
        VerifiedBrokerActivityFeed(
          connection,
          client,
          cursor = { unavailable() },
          publish = { _, _, _ -> unavailable() },
          completeCatchup = { _, _, _ -> unavailable() },
          heartbeat = { _, _, _ -> unavailable() },
          now = { Instant.parse("2026-11-21T16:00:01Z") },
        )
      try {
        val failure = assertFailsWith<IllegalStateException> { feed.collect() }
        assertEquals("broker activity account predates complete provider history", failure.message)
        assertEquals(0, activityRequests.get())
        assertEquals(0, durableCalls.get())
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }
}
