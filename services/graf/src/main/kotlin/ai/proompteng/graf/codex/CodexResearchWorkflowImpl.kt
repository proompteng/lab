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
        // Must be >= argoConfig.pollTimeoutSeconds (default 2h) otherwise long Codex runs time out early.
        .setScheduleToCloseTimeout(Duration.ofHours(3))
        .setStartToCloseTimeout(Duration.ofHours(3))
        .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(3).build())
        .build(),
    )

  override fun run(input: CodexResearchWorkflowInput): CodexResearchWorkflowResult {
    val activityVersion = Workflow.getVersion(AGENT_RUN_ACTIVITY_CHANGE_ID, Workflow.DEFAULT_VERSION, 1)
    if (activityVersion == Workflow.DEFAULT_VERSION) {
      return runWithLegacyActivityNames(input)
    }
    return runWithAgentRunActivities(input)
  }

  private fun runWithAgentRunActivities(input: CodexResearchWorkflowInput): CodexResearchWorkflowResult {
    val submission =
      submitActivities.submitAgentRun(
        SubmitAgentRunRequest(
          runName = input.argoWorkflowName,
          prompt = input.prompt,
          metadata = input.metadata,
          artifactKey = input.artifactKey,
        ),
      )
    val completed = activities.waitForAgentRun(submission.recordId, input.argoPollTimeoutSeconds)
    val artifactReference =
      completed.artifactReferences.firstOrNull()
        ?: throw IllegalStateException("AgentRun ${submission.resourceName} completed without artifacts")
    val payload = activities.downloadArtifact(artifactReference)
    activities.persistCodexArtifact(payload, input)
    val info = Workflow.getInfo()
    return CodexResearchWorkflowResult(
      workflowId = info.workflowId,
      runId = info.runId,
      argoWorkflowName = submission.runName,
      artifactReferences = completed.artifactReferences,
      status = completed.phase,
    )
  }

  private fun runWithLegacyActivityNames(input: CodexResearchWorkflowInput): CodexResearchWorkflowResult {
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
        ?: throw IllegalStateException("AgentRun ${submission.workflowName} completed without artifacts")
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

  private companion object {
    private const val AGENT_RUN_ACTIVITY_CHANGE_ID = "graf-codex-agentrun-activity-names"
  }
}
