package ai.proompteng.graf.security

import ai.proompteng.graf.model.ErrorResponse
import ai.proompteng.graf.security.requireBearerToken
import ai.proompteng.graf.telemetry.GrafTelemetry
import jakarta.annotation.Priority
import jakarta.ws.rs.NotAuthorizedException
import jakarta.ws.rs.Priorities
import jakarta.ws.rs.container.ContainerRequestContext
import jakarta.ws.rs.container.ContainerRequestFilter
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import jakarta.ws.rs.ext.ExceptionMapper
import jakarta.ws.rs.ext.Provider
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

@Provider
@Priority(Priorities.AUTHENTICATION)
class GrafBearerTokenFilter : ContainerRequestFilter {
  override fun filter(requestContext: ContainerRequestContext) {
    val path = requestContext.uriInfo.path
    if (!path.startsWith("v1")) {
      return
    }
    val token = requireBearerToken(requestContext)
    if (!ApiBearerTokenConfig.isValid(token)) {
      throw NotAuthorizedException("invalid bearer token")
    }
  }

  private fun extractBearerToken(requestContext: ContainerRequestContext): String {
    val authorization =
      requestContext.headers.getFirst("Authorization")?.trim()
        ?: throw NotAuthorizedException("missing Authorization header")
    val token =
      if (authorization.startsWith("Bearer ", ignoreCase = true)) {
        authorization.substringAfter(" ").trim()
      } else {
        authorization
      }
    return token.takeIf(String::isNotBlank) ?: throw NotAuthorizedException("missing bearer token")
  }
}

@Provider
class IllegalArgumentExceptionMapper : ExceptionMapper<IllegalArgumentException> {
  override fun toResponse(exception: IllegalArgumentException): Response {
    logger.warn(exception) { exception.message ?: "bad request" }
    return Response
      .status(Response.Status.BAD_REQUEST)
      .entity(ErrorResponse(exception.message ?: "bad request"))
      .type(MediaType.APPLICATION_JSON)
      .build()
  }
}

@Provider
class GenericExceptionMapper : ExceptionMapper<Throwable> {
  override fun toResponse(exception: Throwable): Response {
    logger.error(exception) { "unhandled Graf exception" }
    logger.info { "spanId=${GrafTelemetry.currentSpanId()} traceId=${GrafTelemetry.currentTraceId()}" }
    return Response
      .status(Response.Status.INTERNAL_SERVER_ERROR)
      .entity(ErrorResponse("internal server error"))
      .type(MediaType.APPLICATION_JSON)
      .build()
  }
}
