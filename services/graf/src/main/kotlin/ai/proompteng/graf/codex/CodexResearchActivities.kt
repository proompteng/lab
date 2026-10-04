package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import io.temporal.activity.ActivityInterface

@ActivityInterface
interface CodexResearchActivities {
  fun submitAgentRun(request: SubmitAgentRunRequest): SubmitAgentRunResult

  fun waitForAgentRun(
    runNameOrRecordId: String,
    timeoutSeconds: Long,
  ): CompletedAgentRun

  fun downloadArtifact(reference: ArtifactReference): String

  fun persistCodexArtifact(
    payload: String,
    input: CodexResearchWorkflowInput,
  )
}
