package ai.proompteng.dorvud.ta.server

import ai.proompteng.dorvud.ta.config.TaServiceConfig
import io.github.oshai.kotlinlogging.KLogger
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.metrics.micrometer.MicrometerMetrics
import io.ktor.server.netty.Netty
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry

class HttpServer(
  private val config: TaServiceConfig,
  private val registry: MeterRegistry,
  private val logger: KLogger,
) {
  private var engine: ApplicationEngine? = null

  fun start() {
    if (engine != null) return
    engine = embeddedServer(Netty, host = config.httpHost, port = config.httpPort) {
      install(MicrometerMetrics) {
        this.registry = this@HttpServer.registry
      }
      routing {
        get("/healthz") { call.respondText("ok") }
        get("/metrics") {
          val body =
            if (registry is PrometheusMeterRegistry) registry.scrape() else "prometheus registry not configured"
          call.respondText(body)
        }
      }
    }.start(wait = false)
    logger.info { "http server listening on ${config.httpHost}:${config.httpPort}" }
  }

  fun stop() {
    engine?.stop()
    engine = null
  }
}
