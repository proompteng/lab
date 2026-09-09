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
        // Must be >= Agents poll timeout (default 2h) otherwise long Codex runs time out early.
        .setScheduleToCloseTimeout(Duration.ofHours(3))
        .setStartToCloseTimeout(Duration.ofHours(3))
        .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(3).build())
        .build(),
    )

  override fun run(input: CodexResearchWorkflowInput): CodexResearchWorkflowResult {
    val submission =
      submitActivities.submitAgentRun(
        SubmitAgentRunRequest(
          runName = input.agentRunName,
          prompt = input.prompt,
          metadata = input.metadata,
          artifactKey = input.artifactKey,
        ),
      )
    val completed = activities.waitForAgentRun(submission.recordId, input.agentRunPollTimeoutSeconds)
    val artifactReference =
      completed.artifactReferences.firstOrNull()
        ?: throw IllegalStateException("AgentRun ${submission.resourceName} completed without artifacts")
    val payload = activities.downloadArtifact(artifactReference)
    activities.persistCodexArtifact(payload, input)
    val info = Workflow.getInfo()
    return CodexResearchWorkflowResult(
      workflowId = info.workflowId,
      runId = info.runId,
      agentRunName = submission.runName,
      artifactReferences = completed.artifactReferences,
      status = completed.phase,
    )
  }
}
