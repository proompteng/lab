package ai.proompteng.graf.runtime

import java.util.concurrent.CopyOnWriteArrayList

class GrafLifecycleRegistry {
  private val closers = CopyOnWriteArrayList<() -> Unit>()

  fun register(closer: () -> Unit) {
    closers += closer
  }

  fun shutdown() {
    closers
      .asReversed()
      .forEach { closer ->
        runCatching { closer() }
      }
    closers.clear()
  }
}
