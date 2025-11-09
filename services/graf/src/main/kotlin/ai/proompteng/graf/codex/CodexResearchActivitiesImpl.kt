package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.services.GraphPersistence
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

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
      argoClient.waitForCompletion(workflowName, timeoutSeconds)
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
      val artifactIdPrefix = input.catalogMetadata.metadata["artifactIdPrefix"]
      val artifactId =
        artifact.metadata["artifactId"]?.asStringOrNull()
          ?: artifactIdPrefix?.let { prefix -> "$prefix-${UUID.randomUUID()}" }
          ?: "graf-codex-${UUID.randomUUID()}"
      val researchSource =
        artifact.metadata["researchSource"]?.asStringOrNull()
          ?: input.catalogMetadata.metadata["researchSource"]
          ?: "graf-codex-${input.catalogMetadata.promptId}"
      val streamId =
        artifact.metadata["streamId"]?.asStringOrNull() ?: input.catalogMetadata.streamId

      if (artifact.entities.isNotEmpty()) {
        val enrichedEntities =
          artifact.entities.map { entity ->
            entity.copy(
              artifactId = entity.artifactId.takeUnless { it.isNullOrBlank() } ?: artifactId,
              researchSource =
                entity.researchSource.takeUnless { it.isNullOrBlank() } ?: researchSource,
              streamId = entity.streamId.takeUnless { it.isNullOrBlank() } ?: streamId,
            )
          }
        graphPersistence.upsertEntities(EntityBatchRequest(enrichedEntities))
      }

      if (artifact.relationships.isNotEmpty()) {
        val enrichedRelationships =
          artifact.relationships.map { relationship ->
            relationship.copy(
              artifactId =
                relationship.artifactId.takeUnless { it.isNullOrBlank() } ?: artifactId,
              researchSource =
                relationship.researchSource.takeUnless { it.isNullOrBlank() } ?: researchSource,
              streamId = relationship.streamId.takeUnless { it.isNullOrBlank() } ?: streamId,
            )
          }
        graphPersistence.upsertRelationships(RelationshipBatchRequest(enrichedRelationships))
      }
    }
  }
}

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonPrimitive -> content
    else -> null
  }
