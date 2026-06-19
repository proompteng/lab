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
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val healthLogger = KotlinLogging.logger {}

@Serializable
data class HyperliquidReadinessInfo(
  val status: String,
  val ready: Boolean,
  val websocket: Boolean,
  val kafka: Boolean,
  val clickhouse: Boolean,
  val clickhouseTableFresh: Boolean,
  val clickhouseLastSuccessLagMs: Long?,
  val clickhouseLastFailureAgeMs: Long?,
  val clickhouseTableIngestLagMs: Map<String, Long?>,
  val clickhouseTableEventLagMs: Map<String, Long?>,
  val marketDataFresh: Boolean,
  val marketDataLastSeenLagMs: Map<String, Long?>,
  val marketDataMaxAgeMs: Long,
  val catalog: Boolean,
  val subscriptions: Int,
  val markets: Int,
)

class HealthServer(
  private val app: HyperliquidFeedApp,
  private val config: HyperliquidConfig,
) {
  private var engine: ApplicationEngine? = null
  private var metricsEngine: ApplicationEngine? = null

  fun start() {
    if (engine != null) return
    engine =
      embeddedServer(CIO, port = config.healthPort) {
        install(CallLogging)
        install(ContentNegotiation) { json(Json { encodeDefaults = true }) }
        healthRoutes()
        if (config.metricsPort == config.healthPort) metricsRoutes()
      }.start(wait = false)
    healthLogger.info { "Hyperliquid health server listening on ${config.healthPort}" }

    if (config.metricsPort != config.healthPort) {
      metricsEngine =
        embeddedServer(CIO, port = config.metricsPort) {
          install(ContentNegotiation) { json(Json { encodeDefaults = true }) }
          metricsRoutes()
        }.start(wait = false)
      healthLogger.info { "Hyperliquid metrics server listening on ${config.metricsPort}" }
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
      get("/healthz") {
        if (app.isAlive()) {
          call.respondText("ok")
        } else {
          call.respondText("not_alive", status = HttpStatusCode.ServiceUnavailable)
        }
      }
      get("/readyz") {
        val info = app.readinessInfo()
        if (info.ready) {
          call.respond(info)
        } else {
          call.respond(HttpStatusCode.ServiceUnavailable, info)
        }
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
