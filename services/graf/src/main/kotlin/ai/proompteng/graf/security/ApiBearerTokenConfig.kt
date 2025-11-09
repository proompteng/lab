package ai.proompteng.graf.security

object ApiBearerTokenConfig {
  private const val TOKENS_ENV = "GRAF_API_BEARER_TOKENS"
  private const val LEGACY_TOKEN_ENV = "GRAF_API_BEARER_TOKEN"

  @Volatile
  private var parsedTokens: Set<String> =
    loadTokens().also {
      require(it.isNotEmpty()) {
        "At least one bearer token must be provided via $TOKENS_ENV or $LEGACY_TOKEN_ENV"
      }
    }

  val tokens: Set<String>
    get() = parsedTokens

  fun isValid(token: String?): Boolean = token?.trim()?.let(parsedTokens::contains) == true

  internal fun overrideTokensForTests(tokens: Set<String>) {
    parsedTokens = tokens
  }

  private fun loadTokens(): Set<String> {
    System.getenv(TOKENS_ENV)?.takeIf(String::isNotBlank)?.let { raw ->
      return parseTokens(raw)
    }
    System.getenv(LEGACY_TOKEN_ENV)?.takeIf(String::isNotBlank)?.let { token ->
      return setOf(token.trim())
    }
    System.getProperty(TOKENS_ENV)?.takeIf(String::isNotBlank)?.let { raw ->
      return parseTokens(raw)
    }
    return emptySet()
  }

  private fun parseTokens(raw: String): Set<String> =
    raw
      .split(Regex("[,\\s]+"))
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .toSet()
}
