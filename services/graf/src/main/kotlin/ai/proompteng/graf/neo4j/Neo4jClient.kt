package ai.proompteng.graf.neo4j

import ai.proompteng.graf.telemetry.GrafTelemetry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.neo4j.driver.Driver
import org.neo4j.driver.SessionConfig
import org.neo4j.driver.TransactionContext
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

class Neo4jClient(
  private val driver: Driver,
  private val database: String,
) : Closeable {
  private val closed = AtomicBoolean(false)

  val isClosed: Boolean
    get() = closed.get()

  suspend fun <T> executeWrite(
    operation: String,
    block: (TransactionContext) -> T,
  ): T =
    withContext(Dispatchers.IO) {
      val start = System.nanoTime()
      try {
        GrafTelemetry.withSpan("graf.neo4j.$operation") {
          driver.session(SessionConfig.forDatabase(database)).use { session ->
            session.executeWrite { tx -> block(tx) }
          }
        }
      } finally {
        val durationMs = (System.nanoTime() - start) / 1_000_000
        GrafTelemetry.recordNeo4jWrite(durationMs, operation, database)
      }
    }

  suspend fun <T> executeRead(block: (TransactionContext) -> T): T =
    withContext(Dispatchers.IO) {
      driver.session(SessionConfig.forDatabase(database)).use { session ->
        session.executeRead { tx -> block(tx) }
      }
    }

  override fun close() {
    if (closed.compareAndSet(false, true)) {
      driver.close()
    }
  }
}
