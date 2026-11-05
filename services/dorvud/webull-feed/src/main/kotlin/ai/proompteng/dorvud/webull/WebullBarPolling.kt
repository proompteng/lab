package ai.proompteng.dorvud.webull

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.temporal.ChronoUnit

internal fun webullCatalogSweepGap(
  previousSweep: Instant?,
  startedAt: Instant,
  catalogId: String,
  backgroundSymbols: List<String>,
): JsonObject? {
  val recoveredFrom = startedAt.minus(5, ChronoUnit.MINUTES)
  if (previousSweep == null || previousSweep >= recoveredFrom || backgroundSymbols.isEmpty()) return null
  return buildJsonObject {
    put("channel", "bars")
    put("reason", "bounded_recovery_window_exceeded")
    put("scope", "catalog_sweep")
    put("from", previousSweep.toString())
    put("to", recoveredFrom.toString())
    put("catalogId", catalogId)
    put("symbols", buildJsonArray { backgroundSymbols.forEach { add(JsonPrimitive(it)) } })
  }
}

internal suspend fun pollWebullBars(
  symbols: List<String>,
  prioritySymbols: List<String>,
  collect: suspend (List<String>, Instant) -> Unit,
  sweepStarted: suspend (Instant, List<String>) -> Unit,
  sweepCompleted: suspend () -> Unit,
  pause: suspend (Long) -> Unit = { delay(it) },
): Unit =
  coroutineScope {
    val listed = symbols.toSet()
    val priority = prioritySymbols.filter { it in listed }.distinct()
    val prioritySet = priority.toSet()
    val background = symbols.filter { it !in prioritySet }
    if (priority.isNotEmpty()) {
      launch(start = CoroutineStart.UNDISPATCHED) {
        while (isActive) {
          for (batch in priority.chunked(MAX_WEBULL_BAR_SYMBOLS)) {
            collect(batch, Instant.now().truncatedTo(ChronoUnit.MINUTES))
          }
          pause(1_000)
        }
      }
    }
    while (isActive) {
      val started = Instant.now().truncatedTo(ChronoUnit.MINUTES)
      sweepStarted(started, background)
      for (batch in background.chunked(MAX_WEBULL_BAR_SYMBOLS)) {
        collect(batch, Instant.now().truncatedTo(ChronoUnit.MINUTES))
      }
      sweepCompleted()
      val remaining = started.plus(1, ChronoUnit.MINUTES).toEpochMilli() - System.currentTimeMillis()
      if (remaining > 0) pause(remaining)
    }
  }
