package ai.proompteng.dorvud.hyperliquid

internal class MarketDataStallGuard(
  connectedAtMs: Long,
  startupGraceMs: Long,
  private val checkIntervalMs: Long,
) {
  private var nextCheckAtMs = connectedAtMs + startupGraceMs

  init {
    require(startupGraceMs > 0) { "startupGraceMs must be positive" }
    require(checkIntervalMs > 0) { "checkIntervalMs must be positive" }
  }

  fun staleSnapshotIfDue(
    observedAtMs: Long,
    freshness: () -> EventFreshnessSnapshot,
  ): EventFreshnessSnapshot? {
    if (observedAtMs < nextCheckAtMs) return null

    nextCheckAtMs = observedAtMs + checkIntervalMs
    return freshness().takeUnless { it.fresh }
  }
}
