package ai.proompteng.graf.resources

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
  fun root(): Map<String, String?> =
    mapOf(
      "service" to "graf",
      "status" to "ok",
      "version" to buildVersion,
      "commit" to buildCommit,
    )

  @GET
  @Path("healthz")
  @GrafRouteTemplate("GET /healthz")
  @Produces(MediaType.APPLICATION_JSON)
  fun healthz(): Map<String, String?> =
    mapOf(
      "status" to "ok",
      "port" to ServiceEnvironment.get("PORT"),
    )
}

internal object ServiceEnvironment {
  fun get(name: String): String? = System.getenv(name)
}
