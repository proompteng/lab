package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoresearchLaunchResponse
import ai.proompteng.graf.model.AutoresearchPlanIntent
import ai.proompteng.graf.model.AutoresearchPlanRequest
import ai.proompteng.graf.model.toIntent
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import java.util.UUID

class AutoresearchPlannerService(
  private val workflowClient: WorkflowClient,
  private val taskQueue: String,
  private val defaultSampleLimit: Int,
  private val workflowStarter: (AutoresearchWorkflow, AutoresearchWorkflowInput) -> WorkflowStartResult =
    { workflow, input ->
      val execution = WorkflowClient.start(workflow::run, input)
      WorkflowStartResult(execution.workflowId, execution.runId)
    },
) {
  fun startPlan(request: AutoresearchPlanRequest): AutoresearchLaunchResponse {
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
    return AutoresearchLaunchResponse(
      workflowId = result.workflowId,
      runId = result.runId,
      startedAt = result.startedAt,
    )
  }

  private fun buildIntent(request: AutoresearchPlanRequest): AutoresearchPlanIntent = request.toIntent(defaultSampleLimit)
}

data class WorkflowStartResult(
  val workflowId: String,
  val runId: String,
  val startedAt: String =
    java.time.Instant
      .now()
      .toString(),
)
