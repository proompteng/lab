package ai.proompteng.graf.codex

import ai.proompteng.graf.model.CodexResearchRequest
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import java.time.Instant
import java.util.UUID

class CodexResearchService(
  private val workflowClient: WorkflowClient,
  private val taskQueue: String,
  private val argoPollTimeoutSeconds: Long,
  private val workflowStarter:
    (CodexResearchWorkflow, CodexResearchWorkflowInput) -> WorkflowStartResult = { workflow, input ->
      val execution = WorkflowClient.start(workflow::run, input)
      WorkflowStartResult(workflowId = execution.workflowId, runId = execution.runId)
    },
) {
  fun startResearch(
    request: CodexResearchRequest,
    argoWorkflowName: String,
    artifactKey: String,
  ): CodexResearchLaunchResult {
    val workflowId =
      request.metadata["codex.workflow"]?.takeIf { it.isNotBlank() }
        ?: "graf-codex-research-" + UUID.randomUUID().toString()
    val options =
      WorkflowOptions
        .newBuilder()
        .setTaskQueue(taskQueue)
        .setWorkflowId(workflowId)
        .build()
    val workflow = workflowClient.newWorkflowStub(CodexResearchWorkflow::class.java, options)
    val input =
      CodexResearchWorkflowInput(
        prompt = request.prompt,
        metadata = request.metadata,
        catalogMetadata = request.catalog,
        argoWorkflowName = argoWorkflowName,
        artifactKey = artifactKey,
        argoPollTimeoutSeconds = argoPollTimeoutSeconds,
      )
    val execution = workflowStarter(workflow, input)
    return CodexResearchLaunchResult(
      workflowId = workflowId,
      runId = execution.runId,
      startedAt = Instant.now().toString(),
    )
  }
}

data class WorkflowStartResult(
  val workflowId: String,
  val runId: String,
)

data class CodexResearchLaunchResult(
  val workflowId: String,
  val runId: String,
  val startedAt: String,
)
