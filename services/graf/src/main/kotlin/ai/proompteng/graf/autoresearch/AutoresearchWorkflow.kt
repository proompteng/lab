package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoresearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import io.temporal.activity.ActivityOptions
import io.temporal.workflow.Workflow
import io.temporal.workflow.WorkflowInterface
import io.temporal.workflow.WorkflowMethod
import java.time.Duration
import java.time.Instant

@WorkflowInterface
interface AutoresearchWorkflow {
  @WorkflowMethod
  fun run(input: AutoresearchWorkflowInput): AutoresearchWorkflowResult
}

data class AutoresearchWorkflowInput(
  val intent: AutoresearchPlanIntent,
)

data class AutoresearchWorkflowResult(
  val workflowId: String,
  val runId: String,
  val startedAt: String,
  val completedAt: String,
  val plan: GraphRelationshipPlan,
)

class AutoresearchWorkflowImpl : AutoresearchWorkflow {
  private val activities =
    Workflow.newActivityStub(
      AgentActivities::class.java,
      ActivityOptions
        .newBuilder()
        .setScheduleToCloseTimeout(Duration.ofHours(1))
        .setStartToCloseTimeout(Duration.ofHours(1))
        .build(),
    )

  override fun run(input: AutoresearchWorkflowInput): AutoresearchWorkflowResult {
    val info = Workflow.getInfo()
    val startedAt = Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString()
    val plan = activities.generatePlan(input.intent)
    val completedAt = Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString()
    return AutoresearchWorkflowResult(
      workflowId = info.workflowId,
      runId = info.runId,
      startedAt = startedAt,
      completedAt = completedAt,
      plan = plan,
    )
  }
}
