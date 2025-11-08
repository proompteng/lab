package ai.proompteng.graf.neo4j

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.neo4j.driver.Driver
import org.neo4j.driver.SessionConfig
import org.neo4j.driver.TransactionContext
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

class Neo4jClient(private val driver: Driver, private val database: String) : Closeable {
    private val closed = AtomicBoolean(false)

    val isClosed: Boolean
        get() = closed.get()

    suspend fun <T> executeWrite(block: (TransactionContext) -> T): T = withContext(Dispatchers.IO) {
        driver.session(SessionConfig.forDatabase(database)).use { session ->
            session.executeWrite { tx -> block(tx) }
        }
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            driver.close()
        }
    }
}
