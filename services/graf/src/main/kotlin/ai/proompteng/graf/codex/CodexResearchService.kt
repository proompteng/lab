package ai.proompteng.graf.codex

import ai.proompteng.graf.model.CodexResearchRequest
import ai.proompteng.graf.telemetry.GrafTelemetry
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.trace.StatusCode
import io.temporal.api.workflowservice.v1.GetSystemInfoRequest
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowExecutionAlreadyStarted
import io.temporal.client.WorkflowOptions
import io.temporal.serviceclient.WorkflowServiceStubs
import mu.KotlinLogging
import java.time.Instant
import java.util.UUID

class CodexResearchService(
  private val workflowClient: WorkflowClient,
  private val workflowServiceStubs: WorkflowServiceStubs,
  private val taskQueue: String,
  private val argoPollTimeoutSeconds: Long,
  private val workflowStarter: (CodexResearchWorkflow, CodexResearchWorkflowInput) -> WorkflowStartResult = { workflow, input ->
    val execution = WorkflowClient.start(workflow::run, input)
    WorkflowStartResult(workflowId = execution.workflowId, runId = execution.runId)
  },
) : CodexResearchLauncher {
  private val logger = KotlinLogging.logger {}

  fun prewarm() {
    runCatching {
      workflowClient.newWorkflowStub(
        CodexResearchWorkflow::class.java,
        WorkflowOptions
          .newBuilder()
          .setTaskQueue(taskQueue)
          .build(),
      )
      workflowServiceStubs
        .blockingStub()
        .getSystemInfo(GetSystemInfoRequest.getDefaultInstance())
    }.onFailure { error ->
      logger.warn(error) { "Codex Temporal prewarm failed" }
    }
  }

  override fun startResearch(
    request: CodexResearchRequest,
    argoWorkflowName: String,
    artifactKey: String,
  ): CodexResearchLaunchResult {
    val attributes =
      Attributes
        .builder()
        .put(AttributeKey.stringKey("graf.codex.argo_workflow"), argoWorkflowName)
        .put(AttributeKey.stringKey("graf.codex.artifact_key"), artifactKey)
        .apply {
          request.metadata["codex.workflow"]?.let {
            put(AttributeKey.stringKey("graf.codex.metadata.workflow"), it)
          }
        }.build()
    val span =
      GrafTelemetry
        .tracer
        .spanBuilder("graf.codex.startResearch")
        .setAllAttributes(attributes)
        .startSpan()
    val scope = span.makeCurrent()
    try {
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
          argoPollTimeoutSeconds = argoPollTimeoutSeconds,
        )
      val execution =
        try {
          workflowStarter(workflow, input).also {
            GrafTelemetry.recordWorkflowLaunch(artifactKey, argoWorkflowName, request.metadata)
          }
        } catch (ex: WorkflowExecutionAlreadyStarted) {
          WorkflowStartResult(workflowId = workflowId, runId = ex.execution.runId)
        }
      return CodexResearchLaunchResult(
        workflowId = workflowId,
        runId = execution.runId,
        startedAt = Instant.now().toString(),
      )
    } catch (error: Throwable) {
      span.recordException(error)
      span.setStatus(StatusCode.ERROR)
      throw error
    } finally {
      scope.close()
      span.end()
    }
  }
}

interface CodexResearchLauncher {
  fun startResearch(
    request: CodexResearchRequest,
    argoWorkflowName: String,
    artifactKey: String,
  ): CodexResearchLaunchResult
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
