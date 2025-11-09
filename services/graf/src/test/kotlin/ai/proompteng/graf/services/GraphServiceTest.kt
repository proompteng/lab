package ai.proompteng.graf.services

import ai.proompteng.graf.model.EntityPatchRequest
import ai.proompteng.graf.model.GraphResponse
import ai.proompteng.graf.neo4j.Neo4jClient
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.runs
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
import kotlin.test.Test
import kotlin.test.assertEquals

class GraphServiceTest {
  private val driver = mockk<Driver>()
  private val session = mockk<Session>()
  private val txContext = mockk<TransactionContext>()
  private val result = mockk<Result>()
  private val record = mockk<Record>()
  private val service = GraphService(Neo4jClient(driver, "neo4j"))

  @Test
  fun `patchEntity updates node and returns GraphResponse`() =
    runBlocking {
      every { driver.session(any<SessionConfig>()) } returns session
      every { session.executeWrite(any<TransactionCallback<GraphResponse>>()) } answers {
        firstArg<TransactionCallback<GraphResponse>>().execute(txContext)
      }
      every { session.close() } just runs
      every { txContext.run(any<String>(), any<Map<String, Any?>>()) } returns result
      val idValue = mockk<Value>()
      every { idValue.asString() } returns "entity-123"
      every { result.list() } returns listOf(record)
      every { record["id"] } returns idValue

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
