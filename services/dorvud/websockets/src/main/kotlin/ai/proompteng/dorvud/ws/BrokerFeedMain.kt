package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Metrics
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
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
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
  val tradeReady = AtomicInteger()
  val activityReady = AtomicInteger()
  val readiness = listOf(tradeReady, activityReady)
  Metrics.registry.gauge("dorvud_broker_feed_ready", readiness) {
    if (it.all { state -> state.get() == 1 }) 1.0 else 0.0
  }
  Metrics.registry.gauge("dorvud_broker_trade_updates_ready", tradeReady) { it.get().toDouble() }
  Metrics.registry.gauge("dorvud_broker_activities_ready", activityReady) { it.get().toDouble() }
  val publications = Metrics.registry.counter("dorvud_broker_feed_publications")
  val activityHeartbeats = Metrics.registry.counter("dorvud_broker_activity_heartbeats")
  val failures = Metrics.registry.counter("dorvud_broker_feed_session_failures")
  val brokerClient =
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
  val restateClient =
    HttpClient(ClientCIO) {
      install(HttpTimeout) {
        connectTimeoutMillis = 2_000
        requestTimeoutMillis = 10_000
      }
    }
  val publisher = RestateBrokerPublisher(restateClient, settings.restateIngressUrl, settings.connection.sourceRevision)
  try {
    val health =
      embeddedServer(CIO, port = 8080) {
        routing {
          get("/healthz") { call.respondText("ok") }
          get("/readyz") {
            val current = readiness.all { it.get() == 1 }
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
    val backoff = ReconnectBackoff(1000, 30_000)
    val tradeFeed =
      VerifiedBrokerFeed(settings.connection, brokerClient, publish = { key, delivery, notification ->
        publisher.publish(key, delivery, notification)
        publications.increment()
      }, onReady = { tradeReady.set(1) })
    val activityFeed =
      VerifiedBrokerActivityFeed(
        settings.connection,
        brokerClient,
        cursor = publisher::activityCursor,
        publish = { key, delivery, activity ->
          val receipt = publisher.publishActivity(key, delivery, activity)
          publications.increment()
          receipt
        },
        completeCatchup = { key, delivery, activity ->
          val receipt = publisher.completeActivityCatchup(key, delivery, activity)
          activityHeartbeats.increment()
          receipt
        },
        heartbeat = { key, delivery, activity ->
          val receipt = publisher.publishActivityHeartbeat(key, delivery, activity)
          activityHeartbeats.increment()
          receipt
        },
        onReady = { activityReady.set(1) },
      )

    suspend fun reconnect(
      stream: String,
      streamReady: AtomicInteger,
      collect: suspend () -> Unit,
    ) {
      var attempt = 0
      while (currentCoroutineContext().isActive) {
        try {
          collect()
        } catch (failure: Exception) {
          if (failure is CancellationException) throw failure
          failures.increment()
          brokerFeedLogger.warn {
            "Verified broker feed session ended stream=$stream failure_class=${failure.javaClass.simpleName}"
          }
        }
        val reachedReady = streamReady.getAndSet(0) == 1
        attempt = if (reachedReady) 1 else (attempt + 1).coerceAtMost(16)
        delay(backoff.nextDelay(attempt))
      }
    }
    try {
      health.start(wait = false)
      coroutineScope {
        launch { reconnect("trade_updates", tradeReady, tradeFeed::collect) }
        launch { reconnect("activities", activityReady, activityFeed::collect) }
      }
    } finally {
      tradeReady.set(0)
      activityReady.set(0)
      health.stop(0, 1000)
    }
  } finally {
    restateClient.close()
    brokerClient.close()
  }
}
