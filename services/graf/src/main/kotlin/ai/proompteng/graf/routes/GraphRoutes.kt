package ai.proompteng.graf.routes

import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.codex.PromptCatalog
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.CleanRequest
import ai.proompteng.graf.model.CodexResearchRequest
import ai.proompteng.graf.model.CodexResearchResponse
import ai.proompteng.graf.model.ComplementRequest
import ai.proompteng.graf.model.DeleteRequest
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.EntityPatchRequest
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.model.RelationshipPatchRequest
import ai.proompteng.graf.services.GraphService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import java.util.UUID

fun Route.graphRoutes(
  service: GraphService,
  codexResearchService: CodexResearchService,
  minioConfig: MinioConfig,
  promptCatalog: PromptCatalog,
) {
  post("/entities") {
    val payload = call.receive<EntityBatchRequest>()
    val response = service.upsertEntities(payload)
    call.respond(HttpStatusCode.OK, response)
  }

  post("/relationships") {
    val payload = call.receive<RelationshipBatchRequest>()
    val response = service.upsertRelationships(payload)
    call.respond(HttpStatusCode.OK, response)
  }

  patch("/entities/{id}") {
    val id = call.parameters["id"] ?: throw IllegalArgumentException("entity id missing")
    val payload = call.receive<EntityPatchRequest>()
    val response = service.patchEntity(id, payload)
    call.respond(HttpStatusCode.OK, response)
  }

  patch("/relationships/{id}") {
    val id = call.parameters["id"] ?: throw IllegalArgumentException("relationship id missing")
    val payload = call.receive<RelationshipPatchRequest>()
    val response = service.patchRelationship(id, payload)
    call.respond(HttpStatusCode.OK, response)
  }

  delete("/entities/{id}") {
    val id = call.parameters["id"] ?: throw IllegalArgumentException("entity id missing")
    val payload = call.receive<DeleteRequest>()
    val response = service.deleteEntity(id, payload)
    call.respond(HttpStatusCode.OK, response)
  }

  delete("/relationships/{id}") {
    val id = call.parameters["id"] ?: throw IllegalArgumentException("relationship id missing")
    val payload = call.receive<DeleteRequest>()
    val response = service.deleteRelationship(id, payload)
    call.respond(HttpStatusCode.OK, response)
  }

  post("/complement") {
    val payload = call.receive<ComplementRequest>()
    val response = service.complement(payload)
    call.respond(HttpStatusCode.OK, response)
  }

  post("/clean") {
    val payload = call.receive<CleanRequest>()
    val response = service.clean(payload)
    call.respond(HttpStatusCode.OK, response)
  }

  post("/codex-research") {
    val payload = call.receive<CodexResearchRequest>()
    val catalog = promptCatalog.findById(payload.catalog.promptId)
      ?: throw IllegalArgumentException("Unknown promptId ${payload.catalog.promptId}")
    val enrichedMetadata =
      payload.metadata + mapOf(
        "catalogPromptId" to catalog.promptId,
        "catalogSchemaVersion" to catalog.schemaVersion.toString(),
        "catalogObjective" to catalog.objective,
      )
    val enrichedRequest = payload.copy(metadata = enrichedMetadata, catalog = catalog)
    val argoWorkflowName = "codex-research-${UUID.randomUUID()}"
    val artifactKey = "codex-research/$argoWorkflowName/codex-artifact.json"
    val launch = codexResearchService.startResearch(enrichedRequest, argoWorkflowName, artifactKey)
    val artifactReference =
      ArtifactReference(
        bucket = minioConfig.bucket,
        key = artifactKey,
        endpoint = minioConfig.endpoint,
        region = minioConfig.region,
      )
    call.respond(
      HttpStatusCode.Accepted,
      CodexResearchResponse(
        workflowId = launch.workflowId,
        runId = launch.runId,
        argoWorkflowName = argoWorkflowName,
        artifactReferences = listOf(artifactReference),
        startedAt = launch.startedAt,
      ),
    )
  }
}
