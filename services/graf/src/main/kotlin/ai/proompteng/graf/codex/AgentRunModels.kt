package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import kotlinx.serialization.Serializable

@Serializable
data class SubmitAgentRunRequest(
  val runName: String,
  val prompt: String,
  val metadata: Map<String, String> = emptyMap(),
  val artifactKey: String,
)

@Serializable
data class SubmitAgentRunResult(
  val runName: String,
  val recordId: String,
  val resourceName: String,
  val artifactKey: String,
)

@Serializable
data class CompletedAgentRun(
  val phase: String,
  val finishedAt: String? = null,
  val artifactReferences: List<ArtifactReference> = emptyList(),
)
