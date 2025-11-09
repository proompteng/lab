package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import io.temporal.activity.ActivityInterface

@ActivityInterface
interface CodexResearchActivities {
  fun submitArgoWorkflow(request: SubmitArgoWorkflowRequest): SubmitArgoWorkflowResult

  fun waitForArgoWorkflow(
    workflowName: String,
    timeoutSeconds: Long,
  ): CompletedArgoWorkflow

  fun downloadArtifact(reference: ArtifactReference): String

  fun persistCodexArtifact(
    payload: String,
    input: CodexResearchWorkflowInput,
  )
}
