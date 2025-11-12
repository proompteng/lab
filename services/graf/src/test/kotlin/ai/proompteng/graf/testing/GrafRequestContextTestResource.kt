package ai.proompteng.graf.testing

import ai.proompteng.graf.di.GrafRequestContext
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.GET
import jakarta.ws.rs.Path
import jakarta.ws.rs.Produces
import jakarta.ws.rs.core.MediaType

@Path("/test/request-context")
@ApplicationScoped
class GrafRequestContextTestResource
  @Inject
  constructor(
    private val grafRequestContext: GrafRequestContext,
  ) {
    @GET
    @Produces(MediaType.APPLICATION_JSON)
    fun info(): Map<String, String?> =
      mapOf(
        "requestId" to grafRequestContext.requestId,
        "bearerPrincipal" to grafRequestContext.bearerPrincipal,
        "traceId" to grafRequestContext.traceId,
        "spanId" to grafRequestContext.spanId,
      )
  }
