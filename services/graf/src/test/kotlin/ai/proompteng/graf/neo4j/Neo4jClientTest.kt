package ai.proompteng.graf.neo4j

import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.neo4j.driver.Driver
import org.neo4j.driver.Session
import org.neo4j.driver.SessionConfig
import org.neo4j.driver.TransactionCallback
import org.neo4j.driver.TransactionContext
import kotlin.test.Test
import kotlin.test.assertEquals

class Neo4jClientTest {
  private val driver = mockk<Driver>()
  private val session = mockk<Session>(relaxed = true)
  private val txContext = mockk<TransactionContext>()

  @Test
  fun `executeWrite delegates to driver session`() =
    runBlocking {
      every { driver.session(any<SessionConfig>()) } returns session
      every { session.executeWrite(any<TransactionCallback<String>>()) } answers
        { firstArg<TransactionCallback<String>>().execute(txContext) }
      every { session.close() } just Runs

      val client = Neo4jClient(driver, "neo4j")
      val result = client.executeWrite { "ok-${it.hashCode()}" }
      assertEquals("ok-${txContext.hashCode()}", result)
      verify { session.executeWrite(any()) }
      verify { session.close() }
    }

  @Test
  fun `close only closes driver once`() {
    every { driver.close() } just Runs

    val client = Neo4jClient(driver, "neo4j")
    client.close()
    client.close()

    verify(exactly = 1) { driver.close() }
  }
}
