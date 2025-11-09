package ai.proompteng.graf

import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.di.configModule
import ai.proompteng.graf.di.createRequestScopeForCall
import ai.proompteng.graf.di.infrastructureModule
import ai.proompteng.graf.di.serviceModule
import ai.proompteng.graf.routes.graphRoutes
import ai.proompteng.graf.security.ApiBearerTokenConfig
import ai.proompteng.graf.security.AuditContext
import ai.proompteng.graf.services.GraphService
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCallPipeline
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
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import org.koin.core.Koin
import org.koin.core.component.KoinComponent
import org.koin.core.component.inject
import org.koin.ktor.ext.getKoin
import org.koin.ktor.plugin.Koin
import org.koin.logger.slf4jLogger
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation as ServerContentNegotiation
import org.koin.core.logger.Level as KoinLevel
import org.slf4j.event.Level as SlfLevel

private val buildVersion = System.getenv("GRAF_VERSION") ?: "dev"
private val buildCommit = System.getenv("GRAF_COMMIT") ?: "unknown"
private const val GRAF_BEARER_AUTH_NAME = "graf-bearer"

private object GrafInjector : KoinComponent {
  val graphService: GraphService by inject()
  val codexResearchService: CodexResearchService by inject()
  val minioConfig: MinioConfig by inject()
  val jsonConfig: Json by inject()
}

fun main() {
  val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
  embeddedServer(Netty, port) {
    module()
  }.start(wait = true)
}

@OptIn(ExperimentalSerializationApi::class)
fun Application.module() {
  install(Koin) {
    slf4jLogger(level = KoinLevel.INFO)
    modules(listOf(configModule, infrastructureModule, serviceModule))
  }

  val koin = getKoin()
  val application = this
  intercept(ApplicationCallPipeline.Setup) {
    val scope = application.createRequestScopeForCall(call, koin)
    scope.declare<AuditContext>(AuditContext.from(call))
    try {
      proceed()
    } finally {
      scope.close()
    }
  }

  val injector = GrafInjector
  val graphService = injector.graphService
  val codexResearchService = injector.codexResearchService
  val minioConfig = injector.minioConfig
  val jsonConfig = injector.jsonConfig

  install(ServerContentNegotiation) {
    json(jsonConfig)
  }
  install(CallLogging) {
    level = SlfLevel.INFO
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
        graphRoutes(graphService, codexResearchService, minioConfig)
      }
    }
    get("/healthz") {
      call.respond(mapOf("status" to "ok", "port" to System.getenv("PORT")))
    }
  }
}
