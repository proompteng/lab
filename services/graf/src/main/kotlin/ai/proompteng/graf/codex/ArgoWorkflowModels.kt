package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference

data class SubmitArgoWorkflowRequest(
  val workflowName: String,
  val prompt: String,
  val metadata: Map<String, String>,
  val artifactKey: String,
)

data class SubmitArgoWorkflowResult(
  val workflowName: String,
)

data class CompletedArgoWorkflow(
  val phase: String,
  val finishedAt: String?,
  val artifactReferences: List<ArtifactReference>,
)
