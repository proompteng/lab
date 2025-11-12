package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.services.GraphPersistence
import io.temporal.activity.Activity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

class CodexResearchActivitiesImpl(
  private val argoClient: ArgoWorkflowClient,
  private val graphPersistence: GraphPersistence,
  private val artifactFetcher: MinioArtifactFetcher,
  private val json: Json,
) : CodexResearchActivities {
  override fun submitArgoWorkflow(request: SubmitArgoWorkflowRequest): SubmitArgoWorkflowResult =
    runBlocking { argoClient.submitWorkflow(request) }

  override fun waitForArgoWorkflow(
    workflowName: String,
    timeoutSeconds: Long,
  ): CompletedArgoWorkflow =
    runBlocking {
      val context = Activity.getExecutionContext()
      argoClient.waitForCompletion(workflowName, timeoutSeconds) {
        context.heartbeat("waiting for argo workflow $workflowName")
      }
    }

  override fun downloadArtifact(reference: ArtifactReference): String =
    runBlocking {
      artifactFetcher.open(reference).use { stream ->
        stream.readBytes().decodeToString()
      }
    }

  override fun persistCodexArtifact(
    payload: String,
    input: CodexResearchWorkflowInput,
  ) {
    runBlocking {
      val artifact = json.decodeFromString(CodexArtifact.serializer(), payload)
      if (artifact.entities.isNotEmpty()) {
        graphPersistence.upsertEntities(EntityBatchRequest(artifact.entities))
      }
      if (artifact.relationships.isNotEmpty()) {
        graphPersistence.upsertRelationships(RelationshipBatchRequest(artifact.relationships))
      }
    }
  }
}
