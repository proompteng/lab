package ai.proompteng.graf.config

import org.neo4j.driver.Config
import java.lang.IllegalStateException

data class Neo4jConfig(
  val uri: String,
  val username: String,
  val password: String,
  val database: String,
) {
  fun toDriverConfig(): Config = Config.builder().build()

  companion object {
    fun fromEnvironment(): Neo4jConfig {
      val env = System.getenv()
      val uri = env["NEO4J_URI"] ?: throw IllegalStateException("NEO4J_URI must be set")
      val authFromEnv = env["NEO4J_AUTH"]?.takeIf { it.isNotBlank() }
      val (authUser, authPassword) =
        authFromEnv
          ?.split('/', limit = 2)
          ?.let { parts ->
            val userPart = parts.getOrNull(0)?.takeIf { it.isNotBlank() }
            val passPart = parts.getOrNull(1)?.takeIf { it.isNotBlank() }
            if (userPart != null && passPart != null) userPart to passPart else null
          }
          ?: (null to null)
      val username = authUser ?: env["NEO4J_USER"].takeUnless { it.isNullOrBlank() } ?: "neo4j"
      val password =
        authPassword ?: env["NEO4J_PASSWORD"] ?: throw IllegalStateException("NEO4J_PASSWORD or NEO4J_AUTH must be set")
      val database = env["NEO4J_DATABASE"].takeUnless { it.isNullOrBlank() } ?: "neo4j"
      return Neo4jConfig(uri, username, password, database)
    }
  }
}
