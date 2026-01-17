package ai.proompteng.graf.resources

import ai.proompteng.graf.model.HealthzResponse
import ai.proompteng.graf.model.ServiceStatusResponse
import ai.proompteng.graf.telemetry.GrafRouteTemplate
import jakarta.ws.rs.GET
import jakarta.ws.rs.Path
import jakarta.ws.rs.Produces
import jakarta.ws.rs.core.MediaType

@Path("/")
class ServiceResource {
  private val buildVersion = ServiceEnvironment.get("GRAF_VERSION") ?: "dev"
  private val buildCommit = ServiceEnvironment.get("GRAF_COMMIT") ?: "unknown"

  @GET
  @GrafRouteTemplate("GET /")
  @Produces(MediaType.APPLICATION_JSON)
  fun root(): ServiceStatusResponse =
    ServiceStatusResponse(
      service = "graf",
      status = "ok",
      version = buildVersion,
      commit = buildCommit,
    )

  @GET
  @Path("healthz")
  @GrafRouteTemplate("GET /healthz")
  @Produces(MediaType.APPLICATION_JSON)
  fun healthz(): HealthzResponse =
    HealthzResponse(
      status = "ok",
      port = ServiceEnvironment.get("PORT"),
    )
}

internal object ServiceEnvironment {
  fun get(name: String): String? = System.getenv(name)
}
