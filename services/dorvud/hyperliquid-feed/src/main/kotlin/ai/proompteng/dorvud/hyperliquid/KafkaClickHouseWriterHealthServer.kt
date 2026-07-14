package ai.proompteng.dorvud.hyperliquid

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
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val writerHealthLogger = KotlinLogging.logger {}

class KafkaClickHouseWriterHealthServer(
  private val state: KafkaClickHouseWriterState,
  private val config: KafkaClickHouseWriterConfig,
) {
  private var healthEngine: ApplicationEngine? = null
  private var metricsEngine: ApplicationEngine? = null

  fun start() {
    if (healthEngine != null) return
    healthEngine =
      embeddedServer(CIO, port = config.healthPort) {
        install(CallLogging)
        install(ContentNegotiation) { json(Json { encodeDefaults = true }) }
        healthRoutes()
        if (config.metricsPort == config.healthPort) metricsRoutes()
      }.start(wait = false)
    writerHealthLogger.info { "Kafka ClickHouse writer health server listening on ${config.healthPort}" }

    if (config.metricsPort != config.healthPort) {
      metricsEngine =
        embeddedServer(CIO, port = config.metricsPort) {
          metricsRoutes()
        }.start(wait = false)
      writerHealthLogger.info { "Kafka ClickHouse writer metrics server listening on ${config.metricsPort}" }
    }
  }

  fun stop() {
    healthEngine?.stop()
    healthEngine = null
    metricsEngine?.stop()
    metricsEngine = null
  }

  private fun Application.healthRoutes() {
    routing {
      get("/healthz") {
        if (state.isAlive()) {
          call.respondText("ok")
        } else {
          call.respondText("not_alive", status = HttpStatusCode.ServiceUnavailable)
        }
      }
      get("/readyz") {
        val snapshot = state.snapshot()
        if (snapshot.ready) {
          call.respond(snapshot)
        } else {
          call.respond(HttpStatusCode.ServiceUnavailable, snapshot)
        }
      }
    }
  }

  private fun Application.metricsRoutes() {
    routing {
      get("/metrics") {
        val scrape = (Metrics.registry as? PrometheusMeterRegistry)?.scrape().orEmpty()
        call.respondText(scrape)
      }
    }
  }
}
