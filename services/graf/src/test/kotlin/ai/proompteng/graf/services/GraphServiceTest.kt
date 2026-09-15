package ai.proompteng.graf.services

import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.EntityPatchRequest
import ai.proompteng.graf.model.EntityRequest
import ai.proompteng.graf.model.GraphResponse
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.model.RelationshipRequest
import ai.proompteng.graf.neo4j.Neo4jClient
import io.mockk.CapturingSlot
import io.mockk.clearAllMocks
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.runs
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.neo4j.driver.Driver
import org.neo4j.driver.Record
import org.neo4j.driver.Result
import org.neo4j.driver.Session
import org.neo4j.driver.SessionConfig
import org.neo4j.driver.TransactionCallback
import org.neo4j.driver.TransactionContext
import org.neo4j.driver.Value
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class GraphServiceTest {
  private val driver = mockk<Driver>()
  private val session = mockk<Session>()
  private val txContext = mockk<TransactionContext>()
  private lateinit var service: GraphService

  @BeforeTest
  fun setUp() {
    clearAllMocks()
    service = GraphService(Neo4jClient(driver, "neo4j"))
  }

  private fun configureSession() {
    every { driver.session(any<SessionConfig>()) } returns session
    val callbackSlot = slot<TransactionCallback<Any>>()
    every { session.executeWrite(capture(callbackSlot)) } answers {
      callbackSlot.captured.execute(txContext)
    }
    every { session.close() } just runs
  }

  private fun stubTxRun(
    querySlot: CapturingSlot<String>? = null,
    response: () -> Result = { resultWithIds(listOf("stub")) },
  ) {
    if (querySlot != null) {
      every { txContext.run(capture(querySlot), any<Map<String, Any?>>()) } answers { response() }
    } else {
      every { txContext.run(any<String>(), any<Map<String, Any?>>()) } answers { response() }
    }
  }

  private fun resultWithIds(ids: List<String>): Result {
    val result = mockk<Result>()
    every { result.list() } returns ids.map { recordWithId(it) }
    return result
  }

  private fun recordWithId(id: String): Record {
    val record = mockk<Record>()
    val value = mockk<Value>()
    every { value.asString() } returns id
    every { record["id"] } returns value
    return record
  }

  @Test
  fun `upsertEntities batches a single query per label`() =
    runBlocking {
      configureSession()
      val querySlot = slot<String>()
      stubTxRun(querySlot) { resultWithIds(listOf("entity-1", "entity-2")) }
      val response =
        service.upsertEntities(
          EntityBatchRequest(
            listOf(
              EntityRequest(label = "Person", properties = mapOf("name" to JsonPrimitive("Alice")), artifactId = "artifact-1"),
              EntityRequest(label = "Person", properties = mapOf("name" to JsonPrimitive("Bob"))),
            ),
          ),
        )
      assertEquals(2, response.results.size)
      assertEquals(listOf("artifact-1", null), response.results.map { it.artifactId })
      assertTrue(querySlot.captured.contains("UNWIND ${'$'}rows AS row"))
      verify(exactly = 1) { txContext.run(any<String>(), any<Map<String, Any?>>()) }
    }

  @Test
  fun `upsertEntities accepts type and name fields`() =
    runBlocking {
      configureSession()
      val querySlot = slot<String>()
      val paramsSlot = slot<Map<String, Any?>>()
      every { txContext.run(capture(querySlot), capture(paramsSlot)) } answers { resultWithIds(listOf("entity-1")) }

      val response =
        service.upsertEntities(
          EntityBatchRequest(
            listOf(
              EntityRequest(type = "Company", name = "Acme Corp"),
            ),
          ),
        )

      assertEquals(1, response.results.size)
      assertTrue(querySlot.captured.contains("MERGE (n:Company"))
      val rows = paramsSlot.captured["rows"] as List<*>
      val firstRow = rows.first() as Map<*, *>
      val props = firstRow["props"] as Map<*, *>
      assertEquals("Acme Corp", props["name"])
    }

  @Test
  fun `upsertRelationships batches a single query per type`() =
    runBlocking {
      configureSession()
      val querySlot = slot<String>()
      stubTxRun(querySlot) { resultWithIds(listOf("rel-1", "rel-2")) }
      val response =
        service.upsertRelationships(
          RelationshipBatchRequest(
            listOf(
              RelationshipRequest(type = "KNOWS", fromId = "entity-a", toId = "entity-b", artifactId = "artifact-rel"),
              RelationshipRequest(type = "KNOWS", fromId = "entity-b", toId = "entity-c"),
            ),
          ),
        )
      assertEquals(2, response.results.size)
      assertEquals("relationship upserted", response.results.first().message)
      assertTrue(querySlot.captured.contains("MATCH (a { id: row.fromId }), (b { id: row.toId })"))
      verify(exactly = 1) { txContext.run(any<String>(), any<Map<String, Any?>>()) }
    }

  @Test
  fun `upsertRelationships reports missing nodes`() =
    runBlocking {
      configureSession()
      stubTxRun(response = { resultWithIds(listOf("rel-2")) })
      val request =
        RelationshipBatchRequest(
          listOf(
            RelationshipRequest(id = "rel-1", type = "LIKES", fromId = "entity-x", toId = "entity-y"),
            RelationshipRequest(id = "rel-2", type = "LIKES", fromId = "entity-y", toId = "entity-z"),
          ),
        )
      val error = assertFailsWith<IllegalArgumentException> { service.upsertRelationships(request) }
      assertEquals("source or target node not found for relationship rel-1", error.message)
    }

  @Test
  fun `patchEntity updates node and returns GraphResponse`() =
    runBlocking {
      configureSession()
      val result = mockk<Result>()
      every { txContext.run(any<String>(), any<Map<String, Any?>>()) } returns result
      val record = mockk<Record>()
      val idValue = mockk<Value>()
      every { idValue.asString() } returns "entity-123"
      every { record["id"] } returns idValue
      every { result.list() } returns listOf(record)

      val response =
        service.patchEntity(
          id = "entity-123",
          request =
            EntityPatchRequest(
              set = mapOf("name" to JsonPrimitive("Acme")),
            ),
        )
      assertEquals("entity-123", response.id)
      assertEquals("entity patched", response.message)
    }
}
