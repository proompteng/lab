package ai.proompteng.graf.codex

import ai.proompteng.graf.model.CodexResearchRequest
import ai.proompteng.graf.codex.WorkflowStartResult
import ai.proompteng.graf.codex.CodexResearchWorkflowInput
import io.mockk.every
import io.mockk.mockk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import io.temporal.client.WorkflowOptions
import io.temporal.client.WorkflowExecutionAlreadyStarted
import io.temporal.api.common.v1.WorkflowExecution

class CodexResearchServiceTest {
  private val workflowClient = mockk<io.temporal.client.WorkflowClient>()
  private val workflowStub = mockk<CodexResearchWorkflow>()

  @Test
  fun `startResearch builds workflow stub and invocation`() {
    every { workflowClient.newWorkflowStub(CodexResearchWorkflow::class.java, any<io.temporal.client.WorkflowOptions>()) } returns workflowStub

    val service =
      CodexResearchService(
        workflowClient = workflowClient,
        taskQueue = "queue",
        argoPollTimeoutSeconds = 60,
        workflowStarter = { stub: CodexResearchWorkflow, input: CodexResearchWorkflowInput ->
          assertEquals(workflowStub, stub)
          assertEquals("argo-name", input.argoWorkflowName)
          assertEquals("artifact.json", input.artifactKey)
          WorkflowStartResult(workflowId = "wf", runId = "run")
        },
      )

    val request = CodexResearchRequest(prompt = "Investigate", metadata = mapOf("stream" to "ecosystem"))
    val result = service.startResearch(request, argoWorkflowName = "argo-name", artifactKey = "artifact.json")

    assertTrue(result.workflowId.startsWith("graf-codex-research-"))
    assertEquals("run", result.runId)
    assertTrue(result.startedAt.isNotBlank())
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
        argoPollTimeoutSeconds = 60,
        workflowStarter = { _, _ -> throw exception },
      )

    val request = CodexResearchRequest(prompt = "Investigate", metadata = mapOf("codex.workflow" to "wf-existing"))
    val result = service.startResearch(request, argoWorkflowName = "argo", artifactKey = "artifact")

    assertEquals("wf-existing", result.workflowId)
    assertEquals("run-existing", result.runId)
  }
}
