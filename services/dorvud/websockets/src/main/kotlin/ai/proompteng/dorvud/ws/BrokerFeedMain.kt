package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.buildProducer
import io.ktor.client.HttpClient
import io.ktor.client.engine.ProxyBuilder
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.server.application.call
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import org.apache.kafka.clients.producer.ProducerRecord
import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger
import io.ktor.client.engine.cio.CIO as ClientCIO

private val brokerFeedLogger = KotlinLogging.logger {}

object BrokerFeedMain {
  @JvmStatic
  fun main(args: Array<String>) {
    require(args.isEmpty()) { "broker feed is configured through its environment" }
    val settings = BrokerFeedSettings.fromEnv(System.getenv())
    runBlocking {
      val owner = currentCoroutineContext().job
      val shutdown = Thread { runBlocking { owner.cancelAndJoin() } }
      Runtime.getRuntime().addShutdownHook(shutdown)
      try {
        runVerifiedBrokerFeed(settings)
      } finally {
        runCatching { Runtime.getRuntime().removeShutdownHook(shutdown) }
      }
    }
  }
}

internal suspend fun runVerifiedBrokerFeed(settings: BrokerFeedSettings) {
  val ready = AtomicInteger()
  Metrics.registry.gauge("dorvud_broker_feed_ready", ready) { it.get().toDouble() }
  val publications = Metrics.registry.counter("dorvud_broker_feed_publications")
  val failures = Metrics.registry.counter("dorvud_broker_feed_session_failures")
  val producer = buildProducer(settings.kafka)
  try {
    val client =
      HttpClient(ClientCIO) {
        engine { proxy = ProxyBuilder.http(Url(settings.proxyUrl)) }
        install(WebSockets) {
          pingInterval = 20_000
          maxFrameSize = ALPACA_TRADE_UPDATE_MAX_FRAME_BYTES
        }
        install(HttpTimeout) {
          connectTimeoutMillis = 10_000
          requestTimeoutMillis = 10_000
        }
      }
    try {
      val health =
        embeddedServer(CIO, port = 8080) {
          routing {
            get("/healthz") { call.respondText("ok") }
            get("/readyz") {
              val current = ready.get() == 1
              call.respondText(
                if (current) "ready" else "not_ready",
                status = if (current) HttpStatusCode.OK else HttpStatusCode.ServiceUnavailable,
              )
            }
            get("/metrics") {
              call.respondText((Metrics.registry as? PrometheusMeterRegistry)?.scrape().orEmpty())
            }
          }
        }
      var attempt = 0
      val backoff = ReconnectBackoff(1000, 30_000)
      val feed =
        VerifiedBrokerFeed(settings.connection, client, publish = { key, notification ->
          val record = ProducerRecord(settings.topic, key, Json.encodeToString(notification))
          runInterruptible(Dispatchers.IO) { producer.send(record).get() }
          publications.increment()
          ready.set(1)
          attempt = 0
        })
      try {
        health.start(wait = false)
        while (currentCoroutineContext().isActive) {
          try {
            feed.collect()
          } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            failures.increment()
            brokerFeedLogger.warn { "Verified broker feed session ended failure_class=${failure.javaClass.simpleName}" }
          } finally {
            ready.set(0)
          }
          attempt = (attempt + 1).coerceAtMost(16)
          delay(backoff.nextDelay(attempt))
        }
      } finally {
        ready.set(0)
        health.stop(0, 1000)
      }
    } finally {
      client.close()
    }
  } finally {
    producer.close(Duration.ofSeconds(5))
  }
}
