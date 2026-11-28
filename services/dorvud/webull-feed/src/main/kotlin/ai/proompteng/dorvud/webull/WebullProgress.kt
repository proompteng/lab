package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullCapture
import ai.proompteng.dorvud.platform.WebullPayload
import ai.proompteng.dorvud.platform.webullProviderInstant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class WebullProgress {
  @Volatile var catalog: WebullCatalog? = null
  val accepted = ConcurrentHashMap<Int, Set<String>>()
  val requestedStreaming = ConcurrentHashMap.newKeySet<String>()
  val requestedBars = ConcurrentHashMap.newKeySet<String>()
  val connected = ConcurrentHashMap.newKeySet<Int>()
  val invalidSymbols = ConcurrentHashMap.newKeySet<String>()
  val invalidBarSymbols = ConcurrentHashMap.newKeySet<String>()
  val quotaWitnesses = ConcurrentHashMap<Int, String>()
  val latestObservations = ConcurrentHashMap<String, ConcurrentHashMap<String, String>>()
  val acknowledged = AtomicLong()
  val received = AtomicLong()
  val acknowledgedBytes = AtomicLong()
  val malformed = AtomicLong()
  val outOfWindowBars = AtomicLong()
  val kafkaFailures = AtomicLong()
  val lastAcknowledgedAt = AtomicLong()
  val lastHeartbeatAt = AtomicLong()
  val gaps = AtomicLong()
  val startedAt: Instant = Instant.now()

  fun record(
    capture: WebullCapture,
    payload: WebullPayload?,
  ) {
    acknowledged.incrementAndGet()
    acknowledgedBytes.addAndGet(capture.bytes().size.toLong())
    lastAcknowledgedAt.set(System.currentTimeMillis())
    if (payload == null) {
      malformed.incrementAndGet()
    } else {
      outOfWindowBars.addAndGet(payload.outOfWindowBars.toLong())
      val latest = latestObservations.computeIfAbsent(payload.channel) { ConcurrentHashMap() }
      for (observation in payload.observations) {
        latest.compute(observation.symbol) { _, previous ->
          val prior = previous?.let(::webullProviderInstant)
          val incoming = webullProviderInstant(observation.sourceTime)
          if (prior != null && incoming != null && prior > incoming) previous else observation.sourceTime
        }
      }
    }
  }

  fun report(): JsonObject =
    buildJsonObject {
      put("schemaVersion", "dorvud.webull.coverage.v1")
      put("reportedAt", Instant.now().toString())
      put("startedAt", startedAt.toString())
      put("sourceRevision", System.getenv("WEBULL_FEED_COMMIT") ?: "development")
      val current = catalog
      put("catalogId", current?.identity ?: "unavailable")
      put("discoveredRows", current?.discovered ?: 0)
      put("candidateSymbols", current?.symbols?.size ?: 0)
      put("catalogExclusions", buildJsonObject { current?.exclusions?.forEach { (key, value) -> put(key, value) } })
      val liveAccepted =
        accepted
          .filterKeys { it in connected }
          .values
          .flatten()
          .toSet()
      put("connectedSessions", connected.size)
      put("acceptedStreamingSymbols", liveAccepted.size)
      put("requestedStreamingSymbols", requestedStreaming.size)
      put("requestedBarSymbols", requestedBars.size)
      put("acceptedSymbols", buildJsonArray { liveAccepted.sorted().forEach { add(JsonPrimitive(it)) } })
      put("invalidStreamingSymbols", buildJsonArray { invalidSymbols.sorted().forEach { add(JsonPrimitive(it)) } })
      put("invalidBarSymbols", buildJsonArray { invalidBarSymbols.sorted().forEach { add(JsonPrimitive(it)) } })
      put("quotaWitnesses", buildJsonObject { quotaWitnesses.toSortedMap().forEach { (slot, symbol) -> put(slot.toString(), symbol) } })
      put("kafkaAcknowledgedCaptures", acknowledged.get())
      put("receivedCaptures", received.get())
      put("gapEvents", gaps.get())
      put("kafkaAcknowledgedNativeBytes", acknowledgedBytes.get())
      put("malformedNativeCaptures", malformed.get())
      put("excludedOutOfWindowBars", outOfWindowBars.get())
      put("kafkaFailures", kafkaFailures.get())
      put("lastKafkaAcknowledgementEpochMillis", lastAcknowledgedAt.get())
      put("lastMqttHeartbeatEpochMillis", lastHeartbeatAt.get())
      put(
        "observedSymbolsByChannel",
        buildJsonObject {
          latestObservations.toSortedMap().forEach { (channel, observations) ->
            put(
              channel,
              buildJsonObject {
                put("count", observations.size)
                val parsed = observations.values.mapNotNull(::webullProviderInstant)
                put("unparsedProviderTimes", observations.values.count { it.isNotBlank() && webullProviderInstant(it) == null })
                parsed.maxOrNull()?.let { put("latestProviderTime", it.toString()) }
                put(
                  "lastProviderTimes",
                  buildJsonObject {
                    observations.toSortedMap().forEach { (symbol, timestamp) ->
                      put(symbol, timestamp)
                    }
                  },
                )
              },
            )
          }
        },
      )
      put(
        "uncoveredStreamingSymbols",
        buildJsonArray { current?.symbols?.filter { it !in liveAccepted }?.forEach { add(JsonPrimitive(it)) } },
      )
      put(
        "unobservedBarSymbols",
        buildJsonArray {
          current?.symbols?.filter { it !in latestObservations["bars"].orEmpty() }?.forEach { add(JsonPrimitive(it)) }
        },
      )
    }
}
