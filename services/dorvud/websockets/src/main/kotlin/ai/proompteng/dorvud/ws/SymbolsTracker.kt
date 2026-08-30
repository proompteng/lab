package ai.proompteng.dorvud.ws

import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

internal data class SymbolsRefreshResult(
  val symbols: List<String>,
  val hadError: Boolean,
  val failureReason: String? = null,
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
      return SymbolsRefreshResult(lastKnown, hadError = false, failureReason = null)
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
      return SymbolsRefreshResult(lastKnown, hadError = true, failureReason = "fetch_error")
    }

    if (fetched.isEmpty() && lastKnown.isNotEmpty()) {
      if (lastFailureFingerprint != "empty_result") {
        lastFailureFingerprint = "empty_result"
        logger.warn { "desired symbols fetch returned empty list; keeping last-known list" }
      }
      return SymbolsRefreshResult(lastKnown, hadError = true, failureReason = "empty_result")
    }

    lastFailureFingerprint = null
    lastKnown = fetched
    return SymbolsRefreshResult(lastKnown, hadError = false, failureReason = null)
  }

  fun current(): List<String> = lastKnown
}
