package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.EntityRequest
import ai.proompteng.graf.model.RelationshipRequest
import ai.proompteng.graf.codex.PromptCatalogDefinition
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class CodexResearchWorkflowInput(
  val prompt: String,
  val metadata: Map<String, String> = emptyMap(),
  val catalogMetadata: PromptCatalogDefinition,
  val argoWorkflowName: String,
  val artifactKey: String,
  val argoPollTimeoutSeconds: Long,
)

@Serializable
data class CodexResearchWorkflowResult(
  val workflowId: String,
  val runId: String,
  val argoWorkflowName: String,
  val artifactReferences: List<ArtifactReference>,
  val status: String,
)

@Serializable
data class CodexArtifact(
  val entities: List<EntityRequest> = emptyList(),
  val relationships: List<RelationshipRequest> = emptyList(),
  val metadata: Map<String, JsonElement> = emptyMap(),
)
