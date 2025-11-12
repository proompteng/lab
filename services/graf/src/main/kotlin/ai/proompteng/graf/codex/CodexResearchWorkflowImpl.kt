package ai.proompteng.graf.codex

import io.temporal.activity.ActivityOptions
import io.temporal.common.RetryOptions
import io.temporal.workflow.Workflow
import java.time.Duration

class CodexResearchWorkflowImpl : CodexResearchWorkflow {
  private val submitActivities: CodexResearchActivities =
    Workflow.newActivityStub(
      CodexResearchActivities::class.java,
      ActivityOptions
        .newBuilder()
        .setScheduleToCloseTimeout(Duration.ofHours(2))
        .setStartToCloseTimeout(Duration.ofHours(2))
        .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(1).build())
        .build(),
    )
  private val activities: CodexResearchActivities =
    Workflow.newActivityStub(
      CodexResearchActivities::class.java,
      ActivityOptions
        .newBuilder()
        .setScheduleToCloseTimeout(Duration.ofHours(1))
        .setStartToCloseTimeout(Duration.ofHours(1))
        .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(3).build())
        .build(),
    )

  override fun run(input: CodexResearchWorkflowInput): CodexResearchWorkflowResult {
    val submission =
      submitActivities.submitArgoWorkflow(
        SubmitArgoWorkflowRequest(
          workflowName = input.argoWorkflowName,
          prompt = input.prompt,
          metadata = input.metadata,
          artifactKey = input.artifactKey,
        ),
      )
    val completed = activities.waitForArgoWorkflow(submission.workflowName, input.argoPollTimeoutSeconds)
    val artifactReference =
      completed.artifactReferences.firstOrNull()
        ?: throw IllegalStateException("Argo workflow ${submission.workflowName} completed without artifacts")
    val payload = activities.downloadArtifact(artifactReference)
    activities.persistCodexArtifact(payload, input)
    val info = Workflow.getInfo()
    return CodexResearchWorkflowResult(
      workflowId = info.workflowId,
      runId = info.runId,
      argoWorkflowName = submission.workflowName,
      artifactReferences = completed.artifactReferences,
      status = completed.phase,
    )
  }
}
