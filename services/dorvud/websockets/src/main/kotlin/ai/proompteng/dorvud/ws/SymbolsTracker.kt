package ai.proompteng.dorvud.ws

internal data class SymbolsRefreshResult(
  val symbols: List<String>,
  val hadError: Boolean,
)

internal class SymbolsTracker(
  initialSymbols: List<String>,
  private val fetcher: (suspend () -> List<String>)?,
) {
  private var lastKnown: List<String> = initialSymbols

  suspend fun refresh(): SymbolsRefreshResult {
    val localFetcher = fetcher
    if (localFetcher == null) {
      return SymbolsRefreshResult(lastKnown, hadError = false)
    }

    val fetched =
      runCatching { localFetcher.invoke() }
        .onFailure { /* handled below */ }
        .getOrNull()

    if (fetched == null) {
      return SymbolsRefreshResult(lastKnown, hadError = true)
    }

    lastKnown = fetched
    return SymbolsRefreshResult(lastKnown, hadError = false)
  }

  fun current(): List<String> = lastKnown
}
