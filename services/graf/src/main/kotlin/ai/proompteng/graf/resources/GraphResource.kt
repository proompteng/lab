package ai.proompteng.graf.resources

import ai.proompteng.graf.autoresearch.AutoResearchConfig
import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.AutoResearchLaunchResponse
import ai.proompteng.graf.model.AutoResearchRequest
import ai.proompteng.graf.model.BatchResponse
import ai.proompteng.graf.model.CleanRequest
import ai.proompteng.graf.model.CleanResponse
import ai.proompteng.graf.model.CodexResearchRequest
import ai.proompteng.graf.model.CodexResearchResponse
import ai.proompteng.graf.model.ComplementRequest
import ai.proompteng.graf.model.ComplementResponse
import ai.proompteng.graf.model.DeleteRequest
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.EntityPatchRequest
import ai.proompteng.graf.model.GraphResponse
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.model.RelationshipPatchRequest
import ai.proompteng.graf.runtime.GrafKoin
import ai.proompteng.graf.services.GraphService
import ai.proompteng.graf.telemetry.GrafRouteTemplate
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.Consumes
import jakarta.ws.rs.DELETE
import jakarta.ws.rs.PATCH
import jakarta.ws.rs.POST
import jakarta.ws.rs.Path
import jakarta.ws.rs.PathParam
import jakarta.ws.rs.Produces
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.koin.core.component.get
import java.util.UUID

@Path("/v1")
@ApplicationScoped
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
class GraphResource(
  private val providedGraphService: GraphService? = null,
  private val providedCodexResearchService: CodexResearchService? = null,
  private val providedMinioConfig: MinioConfig? = null,
  private val providedAutoResearchConfig: AutoResearchConfig? = null,
  private val providedAutoResearchLauncher: AutoResearchLauncher? = null,
) {
  private val graphService: GraphService by lazy { providedGraphService ?: GrafKoin.koin().get<GraphService>() }
  private val codexResearchService: CodexResearchService by lazy {
    providedCodexResearchService ?: GrafKoin.koin().get<CodexResearchService>()
  }
  private val minioConfig: MinioConfig by lazy { providedMinioConfig ?: GrafKoin.koin().get<MinioConfig>() }
  private val autoResearchConfig: AutoResearchConfig by lazy {
    providedAutoResearchConfig ?: GrafKoin.koin().get<AutoResearchConfig>()
  }
  private val autoResearchLauncher: AutoResearchLauncher by lazy {
    providedAutoResearchLauncher ?: GrafKoin.koin().get<AutoResearchLauncher>()
  }

  @POST
  @Path("/entities")
  @GrafRouteTemplate("POST /v1/entities")
  suspend fun upsertEntities(payload: EntityBatchRequest): BatchResponse = graphService.upsertEntities(payload)

  @POST
  @Path("/relationships")
  @GrafRouteTemplate("POST /v1/relationships")
  suspend fun upsertRelationships(payload: RelationshipBatchRequest): BatchResponse = graphService.upsertRelationships(payload)

  @PATCH
  @Path("/entities/{id}")
  @GrafRouteTemplate("PATCH /v1/entities/{id}")
  suspend fun patchEntity(
    @PathParam("id") id: String,
    payload: EntityPatchRequest,
  ): GraphResponse = graphService.patchEntity(id, payload)

  @PATCH
  @Path("/relationships/{id}")
  @GrafRouteTemplate("PATCH /v1/relationships/{id}")
  suspend fun patchRelationship(
    @PathParam("id") id: String,
    payload: RelationshipPatchRequest,
  ): GraphResponse = graphService.patchRelationship(id, payload)

  @DELETE
  @Path("/entities/{id}")
  @GrafRouteTemplate("DELETE /v1/entities/{id}")
  suspend fun deleteEntity(
    @PathParam("id") id: String,
    payload: DeleteRequest,
  ): GraphResponse = graphService.deleteEntity(id, payload)

  @DELETE
  @Path("/relationships/{id}")
  @GrafRouteTemplate("DELETE /v1/relationships/{id}")
  suspend fun deleteRelationship(
    @PathParam("id") id: String,
    payload: DeleteRequest,
  ): GraphResponse = graphService.deleteRelationship(id, payload)

  @POST
  @Path("/complement")
  @GrafRouteTemplate("POST /v1/complement")
  suspend fun complement(payload: ComplementRequest): ComplementResponse = graphService.complement(payload)

  @POST
  @Path("/clean")
  @GrafRouteTemplate("POST /v1/clean")
  suspend fun clean(payload: CleanRequest): CleanResponse = graphService.clean(payload)

  @POST
  @Path("/codex-research")
  @GrafRouteTemplate("POST /v1/codex-research")
  suspend fun startCodexResearch(payload: CodexResearchRequest): Response {
    val argoWorkflowName = "codex-research-${UUID.randomUUID()}"
    val artifactKey = "codex-research/$argoWorkflowName/codex-artifact.json"
    val launch =
      withContext(Dispatchers.IO) {
        codexResearchService.startResearch(payload, argoWorkflowName, artifactKey)
      }
    val artifactReference =
      ArtifactReference(
        bucket = minioConfig.bucket,
        key = artifactKey,
        endpoint = minioConfig.endpoint,
        region = minioConfig.region,
      )
    val responsePayload =
      CodexResearchResponse(
        workflowId = launch.workflowId,
        runId = launch.runId,
        argoWorkflowName = argoWorkflowName,
        artifactReferences = listOf(artifactReference),
        startedAt = launch.startedAt,
      )
    return Response.status(Response.Status.ACCEPTED).entity(responsePayload).build()
  }

  @POST
  @Path("/autoresearch")
  @GrafRouteTemplate("POST /v1/autoresearch")
  suspend fun startAutoResearch(payload: AutoResearchRequest): Response {
    val workflowPrefix = autoResearchConfig.workflowNamePrefix
    val argoWorkflowName = "$workflowPrefix-${UUID.randomUUID()}"
    val artifactKey = "codex-research/$argoWorkflowName/codex-artifact.json"
    val launch =
      withContext(Dispatchers.IO) {
        autoResearchLauncher.startResearch(payload, argoWorkflowName, artifactKey)
      }
    val artifactReference =
      ArtifactReference(
        bucket = minioConfig.bucket,
        key = artifactKey,
        endpoint = minioConfig.endpoint,
        region = minioConfig.region,
      )
    val responsePayload =
      AutoResearchLaunchResponse(
        workflowId = launch.workflowId,
        runId = launch.runId,
        argoWorkflowName = argoWorkflowName,
        artifactReferences = listOf(artifactReference),
        startedAt = launch.startedAt,
      )
    return Response.status(Response.Status.ACCEPTED).entity(responsePayload).build()
  }
}
