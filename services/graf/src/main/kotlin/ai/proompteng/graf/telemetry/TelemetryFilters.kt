package ai.proompteng.graf.telemetry

import ai.proompteng.graf.formatAccessLog
import jakarta.annotation.Priority
import jakarta.ws.rs.Priorities
import jakarta.ws.rs.container.ContainerRequestContext
import jakarta.ws.rs.container.ContainerRequestFilter
import jakarta.ws.rs.container.ContainerResponseContext
import jakarta.ws.rs.container.ContainerResponseFilter
import jakarta.ws.rs.container.ResourceInfo
import jakarta.ws.rs.core.Context
import jakarta.ws.rs.ext.Provider
import mu.KotlinLogging

private const val ROUTE_TEMPLATE_PROPERTY = "graf.route.template"
private const val START_TIME_PROPERTY = "graf.request.start"
private val logger = KotlinLogging.logger {}

@Provider
@Priority(Priorities.USER)
class GrafTelemetryRequestFilter : ContainerRequestFilter {
  @Context
  lateinit var resourceInfo: ResourceInfo

  override fun filter(requestContext: ContainerRequestContext) {
    val routeTemplate =
      resourceInfo.resourceMethod?.getAnnotation(GrafRouteTemplate::class.java)?.value
        ?: resourceInfo.resourceClass?.getAnnotation(GrafRouteTemplate::class.java)?.value
        ?: "${requestContext.method} ${requestContext.uriInfo.path}"
    requestContext.setProperty(ROUTE_TEMPLATE_PROPERTY, routeTemplate)
    requestContext.setProperty(START_TIME_PROPERTY, System.nanoTime())
  }
}

@Provider
@Priority(Priorities.USER)
class GrafTelemetryResponseFilter : ContainerResponseFilter {
  override fun filter(requestContext: ContainerRequestContext, responseContext: ContainerResponseContext) {
    val start = requestContext.getProperty(START_TIME_PROPERTY) as? Long ?: return
    val durationMs = (System.nanoTime() - start) / 1_000_000
    val method = requestContext.method
    val status = responseContext.status ?: 200
    val route =
      requestContext.getProperty(ROUTE_TEMPLATE_PROPERTY) as? String
        ?: "$method ${requestContext.uriInfo.path}"
    GrafTelemetry.recordHttpRequest(method, status, durationMs, route)
    logger.info { formatAccessLog(method, requestContext.uriInfo.path, status, durationMs) }
  }
}
