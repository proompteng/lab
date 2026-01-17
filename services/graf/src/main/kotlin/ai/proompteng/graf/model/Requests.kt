package ai.proompteng.graf.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class EntityRequest(
  val id: String? = null,
  val label: String? = null,
  @SerialName("type")
  val type: String? = null,
  val name: String? = null,
  val properties: Map<String, JsonElement> = emptyMap(),
  val artifactId: String? = null,
  val researchSource: String? = null,
  val streamId: String? = null,
)

@Serializable
data class EntityBatchRequest(
  val entities: List<EntityRequest>,
)

@Serializable
data class RelationshipRequest(
  val id: String? = null,
  val type: String,
  val fromId: String,
  val toId: String,
  val properties: Map<String, JsonElement> = emptyMap(),
  val artifactId: String? = null,
  val researchSource: String? = null,
  val streamId: String? = null,
)

@Serializable
data class RelationshipBatchRequest(
  val relationships: List<RelationshipRequest>,
)

@Serializable
data class EntityPatchRequest(
  val set: Map<String, JsonElement> = emptyMap(),
  val remove: List<String> = emptyList(),
  val artifactId: String? = null,
  val researchSource: String? = null,
)

@Serializable
data class RelationshipPatchRequest(
  val set: Map<String, JsonElement> = emptyMap(),
  val remove: List<String> = emptyList(),
  val artifactId: String? = null,
  val researchSource: String? = null,
)

@Serializable
data class DeleteRequest(
  val artifactId: String? = null,
  val reason: String? = null,
)

@Serializable
data class ComplementRequest(
  val id: String,
  val hints: Map<String, JsonElement> = emptyMap(),
  val artifactId: String? = null,
)

@Serializable
data class CleanRequest(
  val artifactId: String? = null,
  val olderThanHours: Int? = null,
)

@Serializable
data class GraphResponse(
  val id: String,
  val message: String,
  val artifactId: String? = null,
)

@Serializable
data class BatchResponse(
  val results: List<GraphResponse>,
)

@Serializable
data class ComplementResponse(
  val id: String,
  val message: String,
  val artifactId: String? = null,
)

@Serializable
data class CleanResponse(
  val affected: Long,
  val message: String,
)

@Serializable
data class CodexResearchRequest(
  val prompt: String,
  val metadata: Map<String, String> = emptyMap(),
)

@Serializable
data class ArtifactReference(
  val bucket: String,
  val key: String,
  val endpoint: String,
  val region: String? = null,
)

@Serializable
data class CodexResearchResponse(
  val workflowId: String,
  val runId: String,
  val argoWorkflowName: String,
  val artifactReferences: List<ArtifactReference>,
  val startedAt: String? = null,
)

@Serializable
data class AutoResearchRequest(
  @SerialName("user_prompt")
  val userPrompt: String? = null,
)

@Serializable
data class AutoResearchLaunchResponse(
  val workflowId: String,
  val runId: String,
  val argoWorkflowName: String,
  val artifactReferences: List<ArtifactReference> = emptyList(),
  val startedAt: String,
  val message: String = "AutoResearch Codex workflow started",
)
