package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoresearchPlanIntent
import ai.proompteng.graf.model.AutoresearchPlanRequest
import ai.proompteng.graf.model.AutoresearchPlanResponse
import ai.proompteng.graf.model.toIntent
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import java.util.UUID

class AutoresearchPlannerService(
  private val workflowClient: WorkflowClient,
  private val taskQueue: String,
  private val defaultSampleLimit: Int,
  private val workflowStarter: (AutoresearchWorkflow, AutoresearchWorkflowInput) -> AutoresearchWorkflowResult =
    { workflow, input -> workflow.run(input) },
) {
  fun generatePlan(request: AutoresearchPlanRequest): AutoresearchPlanResponse {
    val workflowId =
      request.metadata["temporal.workflowId"]?.takeIf { it.isNotBlank() }
        ?: "graf-autoresearch-plan-" + UUID.randomUUID().toString()
    val options =
      WorkflowOptions
        .newBuilder()
        .setTaskQueue(taskQueue)
        .setWorkflowId(workflowId)
        .build()
    val workflow = workflowClient.newWorkflowStub(AutoresearchWorkflow::class.java, options)
    val intent = buildIntent(request)
    val result = workflowStarter(workflow, AutoresearchWorkflowInput(intent))
    return AutoresearchPlanResponse(
      workflowId = result.workflowId,
      runId = result.runId,
      startedAt = result.startedAt,
      completedAt = result.completedAt,
      plan = result.plan,
    )
  }

  private fun buildIntent(request: AutoresearchPlanRequest): AutoresearchPlanIntent = request.toIntent(defaultSampleLimit)
}
