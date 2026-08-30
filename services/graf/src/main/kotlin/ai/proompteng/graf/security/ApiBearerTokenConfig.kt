package ai.proompteng.graf.security

object ApiBearerTokenConfig {
  private const val TOKENS_ENV = "GRAF_API_BEARER_TOKENS"
  private const val LEGACY_TOKEN_ENV = "GRAF_API_BEARER_TOKEN"

  @Volatile
  private var parsedTokens: Set<String>? = null

  init {
    ensureTokens()
  }

  val tokens: Set<String>
    get() = ensureTokens()

  fun isValid(token: String?): Boolean = token?.trim()?.let(ensureTokens()::contains) == true

  internal fun overrideTokensForTests(tokens: Set<String>) {
    parsedTokens = tokens
  }

  private fun ensureTokens(): Set<String> {
    parsedTokens?.let { return it }
    val loaded = loadTokens()
    require(loaded.isNotEmpty()) {
      "At least one bearer token must be provided via $TOKENS_ENV or $LEGACY_TOKEN_ENV"
    }
    parsedTokens = loaded
    return loaded
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
