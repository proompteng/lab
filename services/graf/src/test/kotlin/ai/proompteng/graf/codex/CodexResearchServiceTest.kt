package ai.proompteng.graf.codex

import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import io.temporal.api.workflowservice.v1.GetSystemInfoResponse
import io.temporal.api.workflowservice.v1.WorkflowServiceGrpc
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import io.temporal.serviceclient.WorkflowServiceStubs
import org.junit.jupiter.api.Test

class CodexResearchServiceTest {
  private val workflowClient = mockk<WorkflowClient>(relaxed = true)
  private val workflowServiceStubs = mockk<WorkflowServiceStubs>(relaxed = true)
  private val blockingStub = mockk<WorkflowServiceGrpc.WorkflowServiceBlockingStub>(relaxed = true)

  @Test
  fun `prewarm primes workflow stub and temporal channel`() {
    val workflowStub = mockk<CodexResearchWorkflow>(relaxed = true)
    every { workflowClient.newWorkflowStub(CodexResearchWorkflow::class.java, any<WorkflowOptions>()) } returns workflowStub
    every { workflowServiceStubs.blockingStub() } returns blockingStub
    every { blockingStub.getSystemInfo(any()) } returns GetSystemInfoResponse.getDefaultInstance()

    val service = CodexResearchService(workflowClient, workflowServiceStubs, "graf-test-queue", 120)

    service.prewarm()

    verify { workflowClient.newWorkflowStub(CodexResearchWorkflow::class.java, any<WorkflowOptions>()) }
    verify { blockingStub.getSystemInfo(any()) }
  }
}
