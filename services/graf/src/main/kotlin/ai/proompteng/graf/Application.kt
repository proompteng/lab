package ai.proompteng.graf

import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.routes.graphRoutes
import ai.proompteng.graf.security.ApiBearerTokenConfig
import ai.proompteng.graf.services.GraphService
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.calllogging.*
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.auth.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import org.neo4j.driver.AuthTokens
import org.neo4j.driver.GraphDatabase
import org.slf4j.event.Level

private val buildVersion = System.getenv("GRAF_VERSION") ?: "dev"
private val buildCommit = System.getenv("GRAF_COMMIT") ?: "unknown"
private const val grafBearerAuthName = "graf-bearer"

fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
    val neo4jConfig = Neo4jConfig.fromEnvironment()
    val driver = GraphDatabase.driver(
        neo4jConfig.uri,
        AuthTokens.basic(neo4jConfig.username, neo4jConfig.password),
        neo4jConfig.toDriverConfig()
    )
    val client = Neo4jClient(driver, neo4jConfig.database)
    val graphService = GraphService(client)
    val server = embeddedServer(Netty, port) {
        module(graphService)
    }
    Runtime.getRuntime().addShutdownHook(Thread {
        if (!client.isClosed) {
            client.close()
        }
    })
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
            }
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
        bearer(grafBearerAuthName) {
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
                )
            )
        }
        route("/v1") {
            authenticate(grafBearerAuthName) {
                graphRoutes(graphService)
            }
        }
        get("/healthz") {
            call.respond(mapOf("status" to "ok", "port" to System.getenv("PORT")))
        }
    }
}
