package ai.proompteng.graf.security

object ApiBearerTokenConfig {
  private const val TOKENS_ENV = "GRAF_API_BEARER_TOKENS"
  private const val LEGACY_TOKEN_ENV = "GRAF_API_BEARER_TOKEN"

  private val parsedTokens: Set<String> =
    loadTokens().also {
      require(it.isNotEmpty()) {
        "At least one bearer token must be provided via $TOKENS_ENV or $LEGACY_TOKEN_ENV"
      }
    }

  val tokens: Set<String>
    get() = parsedTokens

  fun isValid(token: String?): Boolean = token?.trim()?.let(parsedTokens::contains) == true

  private fun loadTokens(): Set<String> {
    System.getenv(TOKENS_ENV)?.takeIf(String::isNotBlank)?.let { raw ->
      return raw
        .split(Regex("[,\\s]+"))
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .toSet()
    }
    System.getenv(LEGACY_TOKEN_ENV)?.takeIf(String::isNotBlank)?.let { token ->
      return setOf(token.trim())
    }
    return emptySet()
  }
}
