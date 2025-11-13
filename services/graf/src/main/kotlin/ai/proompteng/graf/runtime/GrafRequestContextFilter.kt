package ai.proompteng.graf.runtime

import ai.proompteng.graf.security.parseBearerTokenValue
import ai.proompteng.graf.telemetry.GrafTelemetry
import jakarta.annotation.Priority
import jakarta.ws.rs.Priorities
import jakarta.ws.rs.container.ContainerRequestContext
import jakarta.ws.rs.container.ContainerRequestFilter
import jakarta.ws.rs.container.ContainerResponseContext
import jakarta.ws.rs.container.ContainerResponseFilter
import jakarta.ws.rs.ext.Provider
import org.koin.core.scope.Scope
import org.koin.core.scope.get

@Provider
@Priority(Priorities.USER + 5)
class GrafRequestContextFilter : ContainerRequestFilter, ContainerResponseFilter {
  override fun filter(requestContext: ContainerRequestContext) {
    val scope = GrafKoin.openRequestScope()
    requestContext.setProperty(SCOPE_PROPERTY, scope)

    val grafRequestContext = scope.get<GrafRequestContext>()
    GrafRequestContextHolder.attach(grafRequestContext)

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

  override fun filter(
    requestContext: ContainerRequestContext,
    responseContext: ContainerResponseContext,
  ) {
    GrafRequestContextHolder.detach()
    val scope = requestContext.getProperty(SCOPE_PROPERTY) as? Scope
    scope?.let { GrafKoin.close(it) }
    requestContext.setProperty(SCOPE_PROPERTY, null)
  }

  companion object {
    private const val SCOPE_PROPERTY = "graf.request.scope"
  }
}
