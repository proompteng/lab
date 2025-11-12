package ai.proompteng.graf.security

import jakarta.ws.rs.NotAuthorizedException
import jakarta.ws.rs.container.ContainerRequestContext

@Suppress("ktlint:standard:multiline-expression-wrapping")
internal fun parseBearerTokenValue(headerValue: String?): String? {
  val trimmed = headerValue?.trim()
  if (trimmed.isNullOrBlank()) {
    return null
  }
  val token =
    if (trimmed.startsWith("Bearer ", ignoreCase = true)) {
      trimmed.substringAfter(" ").trim()
    } else {
      trimmed
    }
  return token.takeIf(String::isNotBlank)
}

@Suppress("ktlint:standard:multiline-expression-wrapping")
internal fun requireBearerToken(requestContext: ContainerRequestContext): String {
  val authorization = requestContext.headers.getFirst("Authorization")?.trim()
    ?: throw NotAuthorizedException("missing Authorization header")
  return parseBearerTokenValue(
    authorization,
  )
    ?: throw NotAuthorizedException("missing bearer token")
}
