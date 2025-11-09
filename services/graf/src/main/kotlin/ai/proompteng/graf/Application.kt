package ai.proompteng.graf

import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.routes.graphRoutes
import ai.proompteng.graf.security.ApiBearerTokenConfig
import ai.proompteng.graf.services.GraphService
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.application.log
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.bearer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import org.neo4j.driver.AuthTokens
import org.neo4j.driver.GraphDatabase
import org.slf4j.event.Level

private val buildVersion = System.getenv("GRAF_VERSION") ?: "dev"
private val buildCommit = System.getenv("GRAF_COMMIT") ?: "unknown"
private const val GRAF_BEARER_AUTH_NAME = "graf-bearer"

fun main() {
  val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
  val neo4jConfig = Neo4jConfig.fromEnvironment()
  val driver =
    GraphDatabase.driver(
      neo4jConfig.uri,
      AuthTokens.basic(neo4jConfig.username, neo4jConfig.password),
      neo4jConfig.toDriverConfig(),
    )
  val client = Neo4jClient(driver, neo4jConfig.database)
  val graphService = GraphService(client)
  val server =
    embeddedServer(Netty, port) {
      module(graphService)
    }
  Runtime.getRuntime().addShutdownHook(
    Thread {
      if (!client.isClosed) {
        client.close()
      }
    },
  )
  server.start(wait = true)
}

@OptIn(ExperimentalSerializationApi::class)
fun Application.module(graphService: GraphService) {
  install(ContentNegotiation) {
    json(
      Json {
        encodeDefaults = true
        prettyPrint = false
        explicitNulls = false
      },
    )
  }
  install(CallLogging) {
    level = Level.INFO
  }
  install(CORS) {
    anyHost()
    allowHeader("Authorization")
    allowHeader("Content-Type")
    allowMethod(HttpMethod.Get)
    allowMethod(HttpMethod.Post)
    allowMethod(HttpMethod.Patch)
    allowMethod(HttpMethod.Delete)
    allowMethod(HttpMethod.Options)
    allowCredentials = true
  }
  install(Authentication) {
    bearer(GRAF_BEARER_AUTH_NAME) {
      realm = "graf-graph-api"
      authenticate { credential ->
        if (ApiBearerTokenConfig.isValid(credential.token)) {
          UserIdPrincipal("graf")
        } else {
          null
        }
      }
    }
  }
  install(StatusPages) {
    exception<IllegalArgumentException> { call, cause ->
      call.application.log.warn("Bad request", cause)
      call.respondText(status = HttpStatusCode.BadRequest, text = cause.message ?: "invalid payload")
    }
    exception<Throwable> { call, cause ->
      call.application.log.error("Unhandled exception", cause)
      call.respondText(status = HttpStatusCode.InternalServerError, text = "internal server error")
    }
  }
  routing {
    get("/") {
      call.respond(
        mapOf(
          "service" to "graf",
          "status" to "ok",
          "version" to buildVersion,
          "commit" to buildCommit,
        ),
      )
    }
    route("/v1") {
      authenticate(GRAF_BEARER_AUTH_NAME) {
        graphRoutes(graphService)
      }
    }
    get("/healthz") {
      call.respond(mapOf("status" to "ok", "port" to System.getenv("PORT")))
    }
  }
}
