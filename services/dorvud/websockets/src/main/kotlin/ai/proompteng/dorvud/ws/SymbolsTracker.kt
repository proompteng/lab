package ai.proompteng.dorvud.ws

import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

internal data class SymbolsRefreshResult(
  val symbols: List<String>,
  val hadError: Boolean,
)

internal class SymbolsTracker(
  initialSymbols: List<String>,
  private val fetcher: (suspend () -> List<String>)?,
) {
  private var lastKnown: List<String> = initialSymbols
  private var lastFailureFingerprint: String? = null

  suspend fun refresh(): SymbolsRefreshResult {
    val localFetcher = fetcher
    if (localFetcher == null) {
      return SymbolsRefreshResult(lastKnown, hadError = false)
    }

    val fetchedResult = runCatching { localFetcher.invoke() }
    val fetched = fetchedResult.getOrNull()

    if (fetched == null) {
      val err = fetchedResult.exceptionOrNull()
      val fingerprint = listOfNotNull(err?.javaClass?.name, err?.message).joinToString(":").ifBlank { "unknown" }
      if (fingerprint != lastFailureFingerprint) {
        lastFailureFingerprint = fingerprint
        logger.warn(err) { "desired symbols fetch failed; keeping last-known list" }
      }
      return SymbolsRefreshResult(lastKnown, hadError = true)
    }

    lastFailureFingerprint = null
    lastKnown = fetched
    return SymbolsRefreshResult(lastKnown, hadError = false)
  }

  fun current(): List<String> = lastKnown
}
