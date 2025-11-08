package ai.proompteng.graf.config

import org.neo4j.driver.Config
import java.lang.IllegalStateException

data class Neo4jConfig(
    val uri: String,
    val username: String,
    val password: String,
    val database: String
) {
    fun toDriverConfig(): Config = Config.builder().build()

    companion object {
        fun fromEnvironment(): Neo4jConfig {
            val env = System.getenv()
            val uri = env["NEO4J_URI"] ?: throw IllegalStateException("NEO4J_URI must be set")
            val username = env["NEO4J_USER"].takeUnless { it.isNullOrBlank() } ?: "neo4j"
            val password = env["NEO4J_PASSWORD"] ?: throw IllegalStateException("NEO4J_PASSWORD must be set")
            val database = env["NEO4J_DATABASE"].takeUnless { it.isNullOrBlank() } ?: "neo4j"
            return Neo4jConfig(uri, username, password, database)
        }
    }
}
