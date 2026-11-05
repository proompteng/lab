package ai.proompteng.dorvud.webull

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.temporal.ChronoUnit

internal suspend fun pollWebullBars(
  symbols: List<String>,
  prioritySymbols: List<String>,
  collect: suspend (List<String>, Instant) -> Unit,
  sweepStarted: suspend (Instant) -> Unit,
  sweepCompleted: suspend () -> Unit,
  pause: suspend (Long) -> Unit = { delay(it) },
): Unit =
  coroutineScope {
    val listed = symbols.toSet()
    val priority = prioritySymbols.filter { it in listed }.distinct()
    val prioritySet = priority.toSet()
    if (priority.isNotEmpty()) {
      launch(start = CoroutineStart.UNDISPATCHED) {
        while (isActive) {
          for (batch in priority.chunked(MAX_WEBULL_BAR_SYMBOLS)) {
            collect(batch, Instant.now().truncatedTo(ChronoUnit.MINUTES))
          }
          pause(5_000)
        }
      }
    }
    while (isActive) {
      val started = Instant.now().truncatedTo(ChronoUnit.MINUTES)
      sweepStarted(started)
      for (batch in symbols.filter { it !in prioritySet }.chunked(MAX_WEBULL_BAR_SYMBOLS)) {
        collect(batch, Instant.now().truncatedTo(ChronoUnit.MINUTES))
      }
      sweepCompleted()
      val remaining = started.plus(1, ChronoUnit.MINUTES).toEpochMilli() - System.currentTimeMillis()
      if (remaining > 0) pause(remaining)
    }
  }
