package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoResearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import io.temporal.activity.ActivityOptions
import io.temporal.common.RetryOptions
import io.temporal.workflow.Workflow
import io.temporal.workflow.WorkflowInterface
import io.temporal.workflow.WorkflowMethod
import org.slf4j.Logger
import java.time.Duration
import java.time.Instant

@WorkflowInterface
interface AutoResearchWorkflow {
  @WorkflowMethod
  fun run(input: AutoResearchWorkflowInput): AutoResearchWorkflowResult
}

data class AutoResearchWorkflowInput(
  val intent: AutoResearchPlanIntent,
)

data class AutoResearchWorkflowResult(
  val workflowId: String,
  val runId: String,
  val startedAt: String,
  val completedAt: String,
  val plan: GraphRelationshipPlan,
)

class AutoResearchWorkflowImpl : AutoResearchWorkflow {
  private val activities =
    Workflow.newActivityStub(
      AgentActivities::class.java,
      ActivityOptions
        .newBuilder()
        .setScheduleToCloseTimeout(Duration.ofHours(1))
        .setStartToCloseTimeout(Duration.ofHours(1))
        .build(),
    )
  private val followupActivities =
    Workflow.newActivityStub(
      AutoResearchFollowupActivities::class.java,
      ActivityOptions
        .newBuilder()
        .setScheduleToCloseTimeout(Duration.ofMinutes(5))
        .setStartToCloseTimeout(Duration.ofMinutes(5))
        .setRetryOptions(
          RetryOptions
            .newBuilder()
            .setMaximumAttempts(3)
            .build(),
        )
        .build(),
    )
  private val logger: Logger = Workflow.getLogger(AutoResearchWorkflowImpl::class.java)

  override fun run(input: AutoResearchWorkflowInput): AutoResearchWorkflowResult {
    val info = Workflow.getInfo()
    val metadataKeys = if (input.intent.metadata.isEmpty()) "none" else input.intent.metadata.keys.joinToString()
    logger.info(
      "Starting AutoResearch workflowId={} runId={} objective='{}' streamId={} sampleLimit={} metadataKeys={}",
      info.workflowId,
      info.runId,
      input.intent.objective,
      input.intent.streamId ?: "none",
      input.intent.sampleLimit ?: "default",
      metadataKeys,
    )
    val startedAt = Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString()
    val plan = activities.generatePlan(input.intent)
    logger.info(
      "AutoResearch plan generated workflowId={} relationships={} prioritizedPrompts={} signals={}",
      info.workflowId,
      plan.candidateRelationships.size,
      plan.prioritizedPrompts.size,
      plan.currentSignals.size,
    )
    followupActivities.handlePlanOutcome(
      AutoResearchPlanOutcome(
        workflowId = info.workflowId,
        runId = info.runId,
        intent = input.intent,
        plan = plan,
      ),
    )
    val completedAt = Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString()
    return AutoResearchWorkflowResult(
      workflowId = info.workflowId,
      runId = info.runId,
      startedAt = startedAt,
      completedAt = completedAt,
      plan = plan,
    )
  }
}
