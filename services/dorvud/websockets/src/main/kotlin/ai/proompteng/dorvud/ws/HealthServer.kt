package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Metrics
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.callloging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

class HealthServer(
  private val app: ForwarderApp,
  private val config: ForwarderConfig,
) {
  private var engine: ApplicationEngine? = null
  private var metricsEngine: ApplicationEngine? = null

  fun start() {
    if (engine != null) return
    engine =
      embeddedServer(CIO, port = config.healthPort) {
        install(CallLogging)
        install(ContentNegotiation) {
          json(Json { encodeDefaults = true })
        }
        healthRoutes()
        if (config.metricsPort == config.healthPort) {
          metricsRoutes()
        }
      }.start(wait = false)
    logger.info { "health server listening on ${config.healthPort}" }

    if (config.metricsPort != config.healthPort) {
      metricsEngine =
        embeddedServer(CIO, port = config.metricsPort) {
          install(ContentNegotiation) {
            json(Json { encodeDefaults = true })
          }
          metricsRoutes()
        }.start(wait = false)
      logger.info { "metrics server listening on ${config.metricsPort}" }
    }
  }

  fun stop() {
    engine?.stop()
    engine = null
    metricsEngine?.stop()
    metricsEngine = null
  }

  private fun Application.healthRoutes() {
    routing {
      get("/healthz") { call.respondText("ok") }
      get("/readyz") {
        if (app.isReady()) call.respondText("ready") else call.respondText("not-ready", status = HttpStatusCode.ServiceUnavailable)
      }
    }
  }

  private fun Application.metricsRoutes() {
    routing {
      get("/metrics") {
        val scrape = (Metrics.registry as? PrometheusMeterRegistry)?.scrape() ?: ""
        call.respondText(scrape)
      }
    }
  }
}
