package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoResearchLaunchResponse
import ai.proompteng.graf.model.AutoResearchPlanIntent
import ai.proompteng.graf.model.AutoResearchPlanRequest
import ai.proompteng.graf.model.toIntent
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import mu.KotlinLogging
import java.util.UUID

class AutoResearchPlannerService(
  private val workflowClient: WorkflowClient,
  private val taskQueue: String,
  private val defaultSampleLimit: Int,
  private val workflowStarter: (AutoResearchWorkflow, AutoResearchWorkflowInput) -> WorkflowStartResult =
    { workflow, input ->
      val execution = WorkflowClient.start(workflow::run, input)
      WorkflowStartResult(execution.workflowId, execution.runId)
    },
) {
  private val logger = KotlinLogging.logger {}

  fun startPlan(request: AutoResearchPlanRequest): AutoResearchLaunchResponse {
    val workflowId =
      request.metadata["temporal.workflowId"]?.takeIf { it.isNotBlank() }
        ?: "graf-auto-research-plan-" + UUID.randomUUID().toString()
    logger.info {
      "Dispatching AutoResearch workflow workflowId=$workflowId streamId=${request.streamId ?: "none"} " +
        "sampleLimitOverride=${request.sampleLimitOverride ?: "default"} metadataKeys=${request.metadata.keys}"
    }
    val options =
      WorkflowOptions
        .newBuilder()
        .setTaskQueue(taskQueue)
        .setWorkflowId(workflowId)
        .build()
    val workflow = workflowClient.newWorkflowStub(AutoResearchWorkflow::class.java, options)
    val intent = buildIntent(request)
    val workflowStartAttempt = runCatching { workflowStarter(workflow, AutoResearchWorkflowInput(intent)) }
    workflowStartAttempt.onFailure { error ->
      logger.error(error) { "Failed to start AutoResearch workflow workflowId=$workflowId" }
    }
    val result = workflowStartAttempt.getOrThrow()
    logger.info {
      "AutoResearch workflow started workflowId=${result.workflowId} runId=${result.runId} startedAt=${result.startedAt}"
    }
    return AutoResearchLaunchResponse(
      workflowId = result.workflowId,
      runId = result.runId,
      startedAt = result.startedAt,
    )
  }

  private fun buildIntent(request: AutoResearchPlanRequest): AutoResearchPlanIntent = request.toIntent(defaultSampleLimit)
}

data class WorkflowStartResult(
  val workflowId: String,
  val runId: String,
  val startedAt: String =
    java.time.Instant
      .now()
      .toString(),
)
