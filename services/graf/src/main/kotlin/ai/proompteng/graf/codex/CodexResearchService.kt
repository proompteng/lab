package ai.proompteng.graf.codex

import ai.proompteng.graf.model.CodexResearchRequest
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import java.time.Instant
import java.util.UUID

class CodexResearchService(
  private val workflowClient: WorkflowClient,
  private val taskQueue: String,
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
        argoWorkflowName = argoWorkflowName,
        artifactKey = artifactKey,
      )
    val execution = WorkflowClient.start(workflow::run, input)
    return CodexResearchLaunchResult(
      workflowId = workflowId,
      runId = execution.runId,
      startedAt = Instant.now().toString(),
    )
  }
}

data class CodexResearchLaunchResult(
  val workflowId: String,
  val runId: String,
  val startedAt: String,
)
