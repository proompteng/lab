package ai.proompteng.graf.di

import ai.proompteng.graf.security.parseBearerTokenValue
import ai.proompteng.graf.telemetry.GrafTelemetry
import jakarta.annotation.Priority
import jakarta.ws.rs.Priorities
import jakarta.ws.rs.container.ContainerRequestContext
import jakarta.ws.rs.container.ContainerRequestFilter
import jakarta.ws.rs.ext.Provider

@Provider
@Priority(Priorities.USER + 5)
class GrafRequestContextFilter(
  private val grafRequestContext: GrafRequestContext,
) : ContainerRequestFilter {
  override fun filter(requestContext: ContainerRequestContext) {
    val requestId =
      requestContext.headers
        .getFirst("X-Request-Id")
        ?.takeIf(String::isNotBlank)
        ?: requestContext.headers
          .getFirst("X-Request-ID")
          ?.takeIf(String::isNotBlank)
        ?: grafRequestContext.requestId
    grafRequestContext.requestId = requestId

    grafRequestContext.bearerPrincipal =
      parseBearerTokenValue(
        requestContext.headers.getFirst("Authorization"),
      )

    grafRequestContext.traceId = GrafTelemetry.currentTraceId()
    grafRequestContext.spanId = GrafTelemetry.currentSpanId()
  }
}
