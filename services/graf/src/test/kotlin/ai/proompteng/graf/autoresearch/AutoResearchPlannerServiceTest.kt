package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoResearchPlanRequest
import io.mockk.every
import io.mockk.mockk
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

class AutoResearchPlannerServiceTest {
  private val workflowClient = mockk<WorkflowClient>()
  private val workflowStub = mockk<AutoResearchWorkflow>()

  @Test
  fun `generatePlan returns workflow result`() {
    val request =
      AutoResearchPlanRequest(
        objective = "Map Tier-1 suppliers",
        focus = "memory",
        metadata = mapOf("stream" to "tier1"),
        sampleLimitOverride = 10,
      )
    val expectedResult =
      WorkflowStartResult(
        workflowId = "wf-1",
        runId = "run-1",
        startedAt = "2025-11-09T12:00:00Z",
      )
    every { workflowClient.newWorkflowStub(AutoResearchWorkflow::class.java, any<WorkflowOptions>()) } returns workflowStub

    val service =
      AutoResearchPlannerService(workflowClient, "queue", defaultSampleLimit = 5) { stub, input ->
        assertSame(workflowStub, stub, "expected planner to use the WorkflowClient stub")
        assertEquals(request.objective, input.intent.objective)
        assertEquals(request.sampleLimitOverride, input.intent.sampleLimit)
        expectedResult
      }

    val response = service.startPlan(request)
    assertEquals(expectedResult.workflowId, response.workflowId)
    assertEquals(expectedResult.runId, response.runId)
  }
}
