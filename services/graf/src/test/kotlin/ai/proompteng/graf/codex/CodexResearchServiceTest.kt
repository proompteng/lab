package ai.proompteng.graf.codex

import ai.proompteng.graf.model.CodexResearchRequest
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.temporal.api.common.v1.WorkflowExecution
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CodexResearchServiceTest {
  @Test
  fun `startResearch honors metadata workflow id and poll timeout`() {
    val workflowClient = mockk<WorkflowClient>()
    val workflowStub = mockk<CodexResearchWorkflow>()
    every { workflowClient.newWorkflowStub(CodexResearchWorkflow::class.java, any<WorkflowOptions>()) } returns workflowStub

    val inputSlot = slot<CodexResearchWorkflowInput>()
    val execution =
      WorkflowExecution
        .newBuilder()
        .setWorkflowId("custom-id")
        .setRunId("run-1")
        .build()
    val starter: (CodexResearchWorkflow, CodexResearchWorkflowInput) -> WorkflowStartResult =
      { _, input ->
        inputSlot.captured = input
        WorkflowStartResult(execution.workflowId, execution.runId)
      }
    val service =
      CodexResearchService(
        workflowClient,
        "task-queue",
        argoPollTimeoutSeconds = 7200L,
        workflowStarter = starter,
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
    val workflowClient = mockk<WorkflowClient>()
    val workflowStub = mockk<CodexResearchWorkflow>()
    every { workflowClient.newWorkflowStub(any<Class<CodexResearchWorkflow>>(), any<WorkflowOptions>()) } returns workflowStub
    val inputSlot = slot<CodexResearchWorkflowInput>()
    val execution =
      WorkflowExecution
        .newBuilder()
        .setWorkflowId("graf-codex-research-static")
        .setRunId("run-2")
        .build()
    val starter: (CodexResearchWorkflow, CodexResearchWorkflowInput) -> WorkflowStartResult =
      { _, input ->
        inputSlot.captured = input
        WorkflowStartResult(execution.workflowId, execution.runId)
      }
    val service =
      CodexResearchService(
        workflowClient,
        "task-queue",
        argoPollTimeoutSeconds = 3600L,
        workflowStarter = starter,
      )
    val request = CodexResearchRequest("prompt-text")
    val launch = service.startResearch(request, "argo-name", "artifact-key")

    assertTrue(launch.workflowId.startsWith("graf-codex-research-"))
    assertEquals("run-2", launch.runId)
    assertEquals(3600L, inputSlot.captured.argoPollTimeoutSeconds)
  }
}
