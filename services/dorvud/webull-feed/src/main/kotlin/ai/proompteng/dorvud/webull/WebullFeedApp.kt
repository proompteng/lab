package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.WEBULL_QUOTES_PATH
import ai.proompteng.dorvud.platform.WebullCapture
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.buildProducer
import ai.proompteng.dorvud.platform.encodeWebullCapture
import ai.proompteng.dorvud.platform.inspectWebullCapture
import ai.proompteng.dorvud.platform.webullCapture
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.apache.kafka.clients.producer.ProducerRecord
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

private fun required(
  env: Map<String, String>,
  key: String,
): String = env[key]?.takeIf { it.isNotBlank() } ?: error("$key is required")

private fun logEvent(
  event: String,
  fields: Map<String, String> = emptyMap(),
) {
  println(
    buildJsonObject {
      put("event", event)
      fields.forEach { (key, value) -> put(key, value) }
    },
  )
}

fun main(args: Array<String>): Unit =
  runBlocking(Dispatchers.IO) {
    val env = System.getenv()
    val credentials =
      WebullCredentials(
        required(env, "WEBULL_APP_KEY"),
        required(env, "WEBULL_APP_SECRET"),
      )
    if (args.contentEquals(arrayOf("probe"))) {
      var validatedResponses = 0
      val api =
        WebullApi(credentials, capture = { source, bytes, receivedAt ->
          inspectWebullCapture(webullCapture(source, bytes, receivedAt))
          validatedResponses++
        })
      val catalog = api.discoverCatalog()
      api.request(WEBULL_QUOTES_PATH, mapOf("symbol" to "AAPL", "category" to "US_STOCK", "depth" to "1"), symbols = listOf("AAPL"))
      val bars = api.completedBars(listOf("AAPL", "SPY"), Instant.now().truncatedTo(ChronoUnit.MINUTES))
      val mqtt = WebullMqtt(credentials, receive = {})
      try {
        mqtt.connect()
        val result = api.subscribeMaximum(mqtt.sessionId, listOf("AAPL", "NVDA", "SPY"))
        logEvent(
          "webull.probe.passed",
          mapOf(
            "acceptedSymbols" to result.accepted.size.toString(),
            "candidateSymbols" to catalog.symbols.size.toString(),
            "validatedResponses" to validatedResponses.toString(),
            "barResponseKeys" to bars.keys.sorted().joinToString(","),
          ),
        )
      } finally {
        mqtt.close {}
      }
      return@runBlocking
    }
    require(args.isEmpty() || args.contentEquals(arrayOf("verify"))) { "use no arguments, 'probe', or 'verify'" }
    val kafka =
      KafkaProducerSettings(
        bootstrapServers = required(env, "KAFKA_BOOTSTRAP_SERVERS"),
        clientId = "dorvud-webull-feed",
        maxRequestSizeBytes = 8 * 1024 * 1024,
        securityProtocol = env["KAFKA_SECURITY_PROTOCOL"] ?: "SASL_PLAINTEXT",
        auth = KafkaAuth(required(env, "KAFKA_SASL_USER"), required(env, "KAFKA_SASL_PASSWORD")),
      )
    if (args.contentEquals(arrayOf("verify"))) {
      verifyWebullArchive(kafka, env["WEBULL_TOPIC"] ?: "dorvud.webull.raw.v1")
      return@runBlocking
    }
    val owner = coroutineContext.job
    val shutdown =
      Thread {
        runBlocking {
          owner.cancel()
          withTimeout(28_000) { owner.join() }
        }
      }
    Runtime.getRuntime().addShutdownHook(shutdown)
    try {
      runWebullFeed(
        credentials,
        kafka,
        env["WEBULL_TOPIC"] ?: "dorvud.webull.raw.v1",
        env["WEBULL_STREAM_PRIORITY_SYMBOLS"].orEmpty().split(',').filter { it.isNotBlank() },
      )
    } finally {
      runCatching { Runtime.getRuntime().removeShutdownHook(shutdown) }
    }
  }

private suspend fun runWebullFeed(
  credentials: WebullCredentials,
  kafka: KafkaProducerSettings,
  topic: String,
  prioritySymbols: List<String>,
): Unit =
  coroutineScope {
    val progress = WebullProgress()
    val ingress = coroutineContext.job
    // Input cancellation must not cancel Kafka delivery of captures already accepted into the queue.
    val publisherOwner = Job()
    val queue = Channel<WebullCapture>(16)
    val producer = buildProducer(kafka)

    suspend fun enqueue(capture: WebullCapture) {
      queue.send(capture)
      progress.received.incrementAndGet()
    }

    suspend fun control(
      operation: String,
      body: JsonObject,
    ) {
      if (operation == "gap") progress.gaps.incrementAndGet()
      enqueue(webullCapture(WebullSource.Collector(operation), body.toString().toByteArray()))
    }
    val api = WebullApi(credentials, capture = { source, bytes, receivedAt -> enqueue(webullCapture(source, bytes, receivedAt)) })

    suspend fun loadCatalog(): WebullCatalog {
      while (true) {
        try {
          return api.discoverCatalog()
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (failure: Exception) {
          if (failure is WebullApiFailure && failure.status in setOf(401, 403)) throw failure
          logEvent("webull.catalog.retry", mapOf("errorClass" to failure.javaClass.simpleName))
          control(
            "gap",
            buildJsonObject {
              put("channel", "instruments")
              put("errorClass", failure.javaClass.simpleName)
            },
          )
          delay(60_000)
        }
      }
    }
    val server =
      embeddedServer(CIO, port = 8080) {
        routing {
          get("/healthz") { call.respondText("ok") }
          get("/readyz") {
            val hasSubscriptions = progress.accepted.any { (slot, symbols) -> slot in progress.connected && symbols.isNotEmpty() }
            val ready =
              progress.catalog != null && hasSubscriptions &&
                System.currentTimeMillis() - progress.lastAcknowledgedAt.get() < 120_000
            call.respondText(
              if (ready) "ready" else "pending",
              status = if (ready) HttpStatusCode.OK else HttpStatusCode.ServiceUnavailable,
            )
          }
          get("/coverage") { call.respondText(progress.report().toString(), ContentType.Application.Json) }
          get("/metrics") { call.respondText((Metrics.registry as PrometheusMeterRegistry).scrape()) }
        }
      }.start(wait = false)
    val publisher =
      launch(publisherOwner) {
        for (capture in queue) {
          val parsed = runCatching { inspectWebullCapture(capture) }.getOrNull()
          val encoded = encodeWebullCapture(capture)
          val key = parsed?.observations?.firstOrNull()?.symbol ?: "control"
          while (isActive) {
            try {
              runInterruptible(Dispatchers.IO) { producer.send(ProducerRecord(topic, key, encoded)).get(70, TimeUnit.SECONDS) }
              progress.record(capture, parsed)
              Metrics.registry.counter("webull_captures_total", "channel", parsed?.channel ?: "malformed").increment()
              break
            } catch (cancelled: CancellationException) {
              throw cancelled
            } catch (failure: Exception) {
              progress.kafkaFailures.incrementAndGet()
              logEvent("webull.kafka.retry", mapOf("errorClass" to failure.javaClass.simpleName, "captureId" to capture.captureId))
              delay(5_000)
            }
          }
        }
      }
    publisher.invokeOnCompletion { failure ->
      if (failure != null && ingress.isActive) ingress.cancel("Webull publisher failed", failure)
    }
    try {
      control(
        "gap",
        buildJsonObject {
          put("channel", "mqtt")
          put("reason", "process_start_unknown_stream_gap")
          put("barRecoveryMinutes", 5)
        },
      )
      var catalog = loadCatalog()
      while (isActive) {
        val activeCatalog = catalog
        progress.catalog = catalog
        control(
          "catalog",
          buildJsonObject {
            put("catalogId", catalog.identity)
            put("discoveredRows", catalog.discovered)
            put("candidateSymbols", buildJsonArray { catalog.symbols.forEach { add(JsonPrimitive(it)) } })
            put("exclusions", buildJsonObject { catalog.exclusions.forEach { (reason, count) -> put(reason, count) } })
          },
        )
        logEvent("webull.catalog.loaded", mapOf("candidateSymbols" to catalog.symbols.size.toString(), "catalogId" to catalog.identity))
        val bars =
          launch {
            var previousSweep: Instant? = null
            while (isActive) {
              val sweepStartedAt = Instant.now().truncatedTo(ChronoUnit.MINUTES)
              previousSweep?.takeIf { it < sweepStartedAt.minus(5, ChronoUnit.MINUTES) }?.let { previous ->
                control(
                  "gap",
                  buildJsonObject {
                    put("channel", "bars")
                    put("reason", "bounded_recovery_window_exceeded")
                    put("scope", "catalog_sweep")
                    put("from", previous.toString())
                    put("to", sweepStartedAt.minus(5, ChronoUnit.MINUTES).toString())
                    put("catalogId", activeCatalog.identity)
                  },
                )
              }
              previousSweep = sweepStartedAt
              for (batch in activeCatalog.symbols.filter { it !in progress.invalidBarSymbols }.chunked(MAX_WEBULL_BAR_SYMBOLS)) {
                val cutoff = Instant.now().truncatedTo(ChronoUnit.MINUTES)
                try {
                  collectWebullBarBatch(batch, {
                    progress.requestedBars += it
                    api.completedBars(it, cutoff)
                  }, { progress.invalidBarSymbols.add(it) })
                } catch (cancelled: CancellationException) {
                  throw cancelled
                } catch (failure: Exception) {
                  control(
                    "gap",
                    buildJsonObject {
                      put("channel", "bars")
                      put("cutoff", cutoff.toString())
                      put("symbols", buildJsonArray { batch.forEach { add(JsonPrimitive(it)) } })
                      put("errorClass", failure.javaClass.simpleName)
                      if (failure is WebullApiFailure) put("providerCode", failure.code)
                    },
                  )
                }
              }
              control("coverage", progress.report())
              val next = sweepStartedAt.plus(1, ChronoUnit.MINUTES).toEpochMilli() - System.currentTimeMillis()
              if (next > 0) delay(next)
            }
          }
        val stream =
          launch {
            val slot = 0
            var candidates = (prioritySymbols.filter { it in activeCatalog.symbols } + activeCatalog.symbols).distinct()
            while (isActive) {
              val mqtt =
                WebullMqtt(credentials, receive = { capture ->
                  runBlocking { withTimeout(5_000) { enqueue(capture) } }
                }, heartbeat = { progress.lastHeartbeatAt.set(System.currentTimeMillis()) })
              try {
                mqtt.connect()
                val admission = api.subscribeMaximum(mqtt.sessionId, candidates)
                candidates = admission.accepted.toList()
                progress.accepted[slot] = admission.accepted
                progress.connected.add(slot)
                progress.requestedStreaming += admission.requested
                progress.invalidSymbols += admission.invalid
                admission.quotaWitness?.let { progress.quotaWitnesses[slot] = it }
                if (admission.accepted.isEmpty()) return@launch
                control(
                  "subscriptions",
                  buildJsonObject {
                    put("sessionId", mqtt.sessionId)
                    put("slot", slot)
                    put("requested", buildJsonArray { admission.requested.forEach { add(JsonPrimitive(it)) } })
                    put("accepted", buildJsonArray { admission.accepted.forEach { add(JsonPrimitive(it)) } })
                    put("invalid", buildJsonArray { admission.invalid.forEach { add(JsonPrimitive(it)) } })
                    admission.quotaWitness?.let { put("quotaWitness", it) }
                  },
                )
                val failure = mqtt.disconnected.await()
                control(
                  "gap",
                  buildJsonObject {
                    put("channel", "mqtt")
                    put("sessionId", mqtt.sessionId)
                    put("errorClass", failure?.javaClass?.simpleName ?: "connection_closed")
                  },
                )
              } catch (cancelled: CancellationException) {
                throw cancelled
              } catch (failure: Exception) {
                if (failure is WebullApiFailure && failure.status in setOf(401, 403)) {
                  throw failure
                }
                logEvent("webull.mqtt.retry", mapOf("slot" to slot.toString(), "errorClass" to failure.javaClass.simpleName))
                control(
                  "gap",
                  buildJsonObject {
                    put("channel", "mqtt")
                    put("slot", slot)
                    put("errorClass", failure.javaClass.simpleName)
                  },
                )
              } finally {
                progress.connected.remove(slot)
                withContext(NonCancellable) {
                  runCatching { mqtt.close(::enqueue) }.onFailure { failure ->
                    logEvent(
                      "webull.mqtt.close.failure",
                      mapOf(
                        "sessionId" to mqtt.sessionId,
                        "errorClass" to failure.javaClass.simpleName,
                      ),
                    )
                  }
                }
              }
              delay(60_000)
            }
          }
        delay(24 * 60 * 60_000L)
        val refreshed = loadCatalog()
        stream.cancelAndJoin()
        bars.cancelAndJoin()
        progress.accepted.clear()
        progress.invalidSymbols.clear()
        progress.invalidBarSymbols.clear()
        progress.quotaWitnesses.clear()
        progress.requestedStreaming.clear()
        progress.requestedBars.clear()
        catalog = refreshed
      }
      awaitCancellation()
    } finally {
      withContext(NonCancellable) {
        withTimeoutOrNull(20_000) { drainWebullPublisher(ingress, queue, publisher) }
          ?: logEvent(
            "webull.shutdown.gap",
            mapOf("unacknowledgedCaptures" to (progress.received.get() - progress.acknowledged.get()).toString()),
          )
        queue.close()
        publisherOwner.cancel()
        publisher.cancelAndJoin()
        server.stop(500, 2_000)
        producer.close(java.time.Duration.ofSeconds(5))
      }
    }
  }
