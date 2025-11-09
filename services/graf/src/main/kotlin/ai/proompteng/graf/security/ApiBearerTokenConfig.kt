package ai.proompteng.graf.security

object ApiBearerTokenConfig {
    private const val tokensEnv = "GRAF_API_BEARER_TOKENS"
    private const val legacyTokenEnv = "GRAF_API_BEARER_TOKEN"

    private val parsedTokens: Set<String> = loadTokens().also {
        require(it.isNotEmpty()) {
            "At least one bearer token must be provided via $tokensEnv or $legacyTokenEnv"
        }
    }

    val tokens: Set<String>
        get() = parsedTokens

    fun isValid(token: String?): Boolean {
        return token?.trim()?.let(parsedTokens::contains) == true
    }

    private fun loadTokens(): Set<String> {
        System.getenv(tokensEnv)?.takeIf(String::isNotBlank)?.let { raw ->
            return raw
                .split(Regex("[,\\s]+"))
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .toSet()
        }
        System.getenv(legacyTokenEnv)?.takeIf(String::isNotBlank)?.let { token ->
            return setOf(token.trim())
        }
        return emptySet()
    }
}
