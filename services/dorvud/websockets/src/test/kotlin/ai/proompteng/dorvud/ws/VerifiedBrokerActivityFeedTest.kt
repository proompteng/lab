package ai.proompteng.dorvud.ws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.ContentType
import io.ktor.server.application.call
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import java.time.Instant
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import io.ktor.client.engine.cio.CIO as ClientCIO

class VerifiedBrokerActivityFeedTest {
  private val accountId = "00000000-0000-4000-8000-000000000001"
  private val sourceEventId = "01KH7JBG000000000000000002"
  private val refId = "00000000-0000-4000-8000-000000000002"
  private val orderId = "00000000-0000-4000-8000-000000000003"

  @Test
  fun `constructs an inclusive publication frontier at the maximum ULID entropy`() {
    assertEquals("0000000000ZZZZZZZZZZZZZZZZ", activityPublicationUpperFrontier(Instant.ofEpochMilli(0)))
    assertEquals("01KH7JBG00ZZZZZZZZZZZZZZZZ", activityPublicationUpperFrontier(Instant.parse("2026-02-12T00:00:00Z")))
  }

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
                ": welcome to the Alpaca events\n\ndata: $raw\n\n: heartbeat\n\n",
                ContentType.parse("text/event-stream"),
              )
            }
          }
        }.start(wait = false)
      val port = server.resolvedConnectors().single().port
      val client = HttpClient(ClientCIO) { install(HttpTimeout) }
      var cursor: String? = null
      var caughtUp = false
      var replayFromId: String? = null
      var replayUntilId: String? = null
      var completionHash: String? = null
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
            BrokerActivityCursorReceipt(
              cursor,
              caughtUp,
              replayFromId,
              replayUntilId,
              completionHash,
              true,
              connection.sourceRevision,
            )
          },
          publish = { key, delivery, signed ->
            assertEquals(brokerFeedIdentityHash(accountId), key)
            val event = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(event is BrokerActivityMessage.Event)
            assertFalse(protocolJson.parseToJsonElement(signed.message).jsonObject.containsKey("previousRefId"))
            assertEquals(delivery.eventId, event.eventId)
            publications += event
            cursor = event.sourceEventId
            BrokerActivityCursorReceipt(
              cursor,
              caughtUp,
              replayFromId,
              replayUntilId,
              completionHash,
              true,
              connection.sourceRevision,
            )
          },
          completeCatchup = { _, delivery, signed ->
            val boundary = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(boundary is BrokerActivityMessage.CatchupComplete)
            assertEquals(delivery.eventId, boundary.eventId)
            assertEquals(cursor, boundary.cursor)
            caughtUp = true
            replayFromId = boundary.replayFromId
            replayUntilId = boundary.replayUntilId
            completionHash = boundary.completionHash
            BrokerActivityCursorReceipt(
              cursor,
              caughtUp,
              replayFromId,
              replayUntilId,
              completionHash,
              true,
              connection.sourceRevision,
            )
          },
          heartbeat = { _, delivery, signed ->
            val boundary = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(boundary is BrokerActivityMessage.Heartbeat)
            assertEquals(delivery.eventId, boundary.eventId)
            assertEquals(cursor, boundary.cursor)
            BrokerActivityCursorReceipt(
              cursor,
              caughtUp,
              replayFromId,
              replayUntilId,
              completionHash,
              true,
              connection.sourceRevision,
            )
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
            "since_id=$ACTIVITY_HISTORY_REPLAY_FROM_ID&until_id=${activityPublicationUpperFrontier(Instant.parse("2026-11-21T15:59:56Z"))}",
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

      @Test
      fun `a live heartbeat keeps its null cursor and a silent stream fails without cancelling its caller`() =
        runBlocking {
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
                  call.response.header("x-request-id", "silent-activity-request")
                  call.respondTextWriter(ContentType.parse("text/event-stream")) {
                    write(": heartbeat\n\n")
                    flush()
                    awaitCancellation()
                  }
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
          val caughtUp =
            BrokerActivityCursorReceipt(
              null,
              true,
              ACTIVITY_HISTORY_REPLAY_FROM_ID,
              sourceEventId,
              "f".repeat(64),
              true,
              connection.sourceRevision,
            )
          var ready = false
          val feed =
            VerifiedBrokerActivityFeed(
              connection,
              client,
              cursor = { caughtUp },
              publish = { _, _, _ -> error("unexpected event") },
              completeCatchup = { _, _, _ -> error("unexpected catchup") },
              heartbeat = { _, _, signed ->
                assertEquals(JsonNull, Json.parseToJsonElement(signed.message).jsonObject["cursor"])
                caughtUp
              },
              onReady = { ready = true },
              now = { Instant.parse("2026-11-21T16:00:01Z") },
              lineTimeoutMs = 500,
            )
          try {
            val failure = assertFailsWith<IllegalStateException> { feed.collect() }
            assertEquals("broker activity stream stopped delivering lines", failure.message)
            assertTrue(ready)
          } finally {
            client.close()
            server.stop(0, 1000)
          }
        }
    }

  @Test
  fun `unfinished catchup verifies its retained prefix without republishing it`() =
    runBlocking {
      val olderSourceEventId = "01KH7JBG000000000000000001"
      val publications = AtomicInteger()
      val readiness = AtomicInteger()
      val raw =
        """{"activity_type":"TRD","event_id":"$olderSourceEventId","ref_id":"$refId","account_id":"$accountId","executed_at":"2026-11-21T16:00:00.123456789Z","price":"100.25","qty":"1","details":{"order_id":"$orderId","cum_qty":"1","leaves_qty":"0","symbol":"AAPL","side":"buy","execution_type":"fill","order_status":"filled"}}"""
      val retainedRaw =
        """{"activity_type":"TRD","event_id":"$sourceEventId","ref_id":"00000000-0000-4000-8000-000000000004","account_id":"$accountId","executed_at":"2026-11-21T16:00:00.223456789Z","price":"100.50","qty":"1","details":{"order_id":"$orderId","cum_qty":"2","leaves_qty":"0","symbol":"AAPL","side":"buy","execution_type":"fill","order_status":"filled"}}"""
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
              val catchup = call.request.queryParameters["until_id"] != null
              call.response.header("x-request-id", if (catchup) "partial-catchup-request" else "live-request")
              call.respondText(
                if (catchup) "data: $raw\n\ndata: $retainedRaw\n\n" else ": heartbeat\n\n",
                ContentType.parse("text/event-stream"),
              )
            }
          }
        }.start(wait = false)
      val port = server.resolvedConnectors().single().port
      val client = HttpClient(ClientCIO) { install(HttpTimeout) }
      val protocolJson = Json { classDiscriminator = "_tag" }
      var caughtUp = false
      var replayFromId: String? = null
      var replayUntilId: String? = null
      var completionHash: String? = null
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
        BrokerActivityCursorReceipt(
          sourceEventId,
          caughtUp,
          replayFromId,
          replayUntilId,
          completionHash,
          true,
          connection.sourceRevision,
        )
      }
      val feed =
        VerifiedBrokerActivityFeed(
          connection,
          client,
          cursor = { receipt() },
          publish = { _, _, signed ->
            val event = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(event is BrokerActivityMessage.Event)
            assertTrue(event.sourceEventId == olderSourceEventId || event.sourceEventId == sourceEventId)
            publications.incrementAndGet()
            receipt()
          },
          completeCatchup = { _, _, signed ->
            val boundary = protocolJson.decodeFromString<BrokerActivityMessage>(signed.message)
            assertTrue(boundary is BrokerActivityMessage.CatchupComplete)
            assertEquals(sourceEventId, boundary.cursor)
            assertEquals(2, boundary.eventCount)
            assertEquals(
              brokerFeedSha256(
                "$olderSourceEventId\n${brokerFeedSha256(raw)}\n\n$sourceEventId\n${brokerFeedSha256(retainedRaw)}",
              ),
              boundary.prefixHash,
            )
            caughtUp = true
            replayFromId = boundary.replayFromId
            replayUntilId = boundary.replayUntilId
            completionHash = boundary.completionHash
            receipt()
          },
          heartbeat = { _, _, _ -> receipt() },
          now = { Instant.parse("2026-11-21T16:00:01Z") },
          onReady = { readiness.incrementAndGet() },
        )
      try {
        assertFailsWith<IllegalStateException> { feed.collect() }
        assertEquals(0, publications.get())
        assertEquals(1, readiness.get())
      } finally {
        client.close()
        server.stop(0, 1000)
      }
    }

  @Test
  fun `does not promote a finite range heartbeat when the provider reports an error before clean EOF`() =
    runBlocking {
      val catchups = AtomicInteger()
      val readiness = AtomicInteger()
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
              call.response.header("x-request-id", "failed-range-request")
              call.respondText(
                ": heartbeat\n\n: provider failed to replay the range\n\n",
                ContentType.parse("text/event-stream"),
              )
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
      val unavailable = BrokerActivityCursorReceipt(null, false, null, null, null, true, connection.sourceRevision)
      val feed =
        VerifiedBrokerActivityFeed(
          connection,
          client,
          cursor = { unavailable },
          publish = { _, _, _ -> unavailable },
          completeCatchup = { _, _, _ ->
            catchups.incrementAndGet()
            unavailable
          },
          heartbeat = { _, _, _ -> unavailable },
          now = { Instant.parse("2026-11-21T16:00:01Z") },
          onReady = { readiness.incrementAndGet() },
        )
      try {
        val failure = assertFailsWith<IllegalStateException> { feed.collect() }
        assertEquals("broker activity stream reported lost data or an internal failure", failure.message)
        assertEquals(0, catchups.get())
        assertEquals(0, readiness.get())
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
        BrokerActivityCursorReceipt(null, false, null, null, null, false, connection.sourceRevision)
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
