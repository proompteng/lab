package ai.proompteng.graf.codex

import ai.proompteng.graf.model.CodexResearchRequest
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.temporal.api.common.v1.WorkflowExecution
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowExecutionAlreadyStarted
import io.temporal.client.WorkflowOptions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CodexResearchServiceTest {
  private val workflowClient = mockk<WorkflowClient>()
  private val workflowStub = mockk<CodexResearchWorkflow>()

  @Test
  fun `startResearch honors metadata workflow id and poll timeout`() {
    every { workflowClient.newWorkflowStub(CodexResearchWorkflow::class.java, any<WorkflowOptions>()) } returns workflowStub
    val inputSlot = slot<CodexResearchWorkflowInput>()
    val execution =
      WorkflowExecution
        .newBuilder()
        .setWorkflowId("custom-id")
        .setRunId("run-1")
        .build()
    val service =
      CodexResearchService(
        workflowClient = workflowClient,
        taskQueue = "queue",
        argoPollTimeoutSeconds = 7200L,
        workflowStarter = { stub, input ->
          inputSlot.captured = input
          assertEquals(workflowStub, stub)
          WorkflowStartResult(execution.workflowId, execution.runId)
        },
      )

    val request = CodexResearchRequest("prompt-text", metadata = mapOf("codex.workflow" to "custom-id"))
    val launch = service.startResearch(request, "argo-name", "artifact-key")

    assertEquals("custom-id", launch.workflowId)
    assertEquals("run-1", launch.runId)
    assertEquals("argo-name", inputSlot.captured.argoWorkflowName)
    assertEquals("artifact-key", inputSlot.captured.artifactKey)
    assertEquals(7200L, inputSlot.captured.argoPollTimeoutSeconds)
  }

  @Test
  fun `startResearch generates random id when metadata missing`() {
    val localWorkflowClient = mockk<WorkflowClient>()
    val workflowStub = mockk<CodexResearchWorkflow>()
    every { localWorkflowClient.newWorkflowStub(any<Class<CodexResearchWorkflow>>(), any<WorkflowOptions>()) } returns workflowStub
    val inputSlot = slot<CodexResearchWorkflowInput>()
    val execution =
      WorkflowExecution
        .newBuilder()
        .setWorkflowId("graf-codex-research-static")
        .setRunId("run-2")
        .build()
    val service =
      CodexResearchService(
        workflowClient = localWorkflowClient,
        taskQueue = "queue",
        argoPollTimeoutSeconds = 3600L,
        workflowStarter = { _, input ->
          inputSlot.captured = input
          WorkflowStartResult(execution.workflowId, execution.runId)
        },
      )

    val request = CodexResearchRequest("prompt-text")
    val launch = service.startResearch(request, "argo-name", "artifact-key")

    assertTrue(launch.workflowId.startsWith("graf-codex-research-"))
    assertEquals("run-2", launch.runId)
    assertEquals(3600L, inputSlot.captured.argoPollTimeoutSeconds)
  }

  @Test
  fun `startResearch handles WorkflowExecutionAlreadyStarted`() {
    val execution = WorkflowExecution.newBuilder().setWorkflowId("wf-existing").setRunId("run-existing").build()
    val exception = WorkflowExecutionAlreadyStarted(execution, "already started", null)
    every { workflowClient.newWorkflowStub(CodexResearchWorkflow::class.java, any<WorkflowOptions>()) } returns workflowStub
    val service =
      CodexResearchService(
        workflowClient = workflowClient,
        taskQueue = "queue",
        argoPollTimeoutSeconds = 60L,
        workflowStarter = { _, _ -> throw exception },
      )

    val request = CodexResearchRequest(prompt = "Investigate", metadata = mapOf("codex.workflow" to "wf-existing"))
    val result = service.startResearch(request, argoWorkflowName = "argo", artifactKey = "artifact")

    assertEquals("wf-existing", result.workflowId)
    assertEquals("run-existing", result.runId)
  }
}
