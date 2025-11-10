package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchLauncher
import ai.proompteng.graf.model.AutoResearchPlanIntent
import ai.proompteng.graf.model.CodexResearchRequest
import ai.proompteng.graf.model.GraphRelationshipPlan
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AutoResearchFollowupActivitiesImplTest {
  private val launcher = RecordingLauncher()
  private val activities = AutoResearchFollowupActivitiesImpl(launcher)

  @Test
  fun `handlePlanOutcome launches codex research for each prioritized prompt`() {
    val plan =
      GraphRelationshipPlan(
        objective = "Objective",
        summary = "Plan summary",
        prioritizedPrompts = listOf("Prompt 1", "Prompt 2"),
      )
    val outcome =
      AutoResearchPlanOutcome(
        workflowId = "wf-123",
        runId = "run-123",
        intent = AutoResearchPlanIntent(objective = "Objective", metadata = mapOf("key" to "value"), streamId = "ecosystem"),
        plan = plan,
      )
    val result = activities.handlePlanOutcome(outcome)

    assertEquals(2, result.researchLaunches.size)
    assertEquals(setOf("Prompt 1", "Prompt 2"), result.researchLaunches.map { it.prompt }.toSet())
    assertEquals(2, launcher.requests.size)
    launcher.requests.forEachIndexed { index, request ->
      assertEquals("wf-123", request.metadata["autoResearch.workflowId"])
      assertEquals("run-123", request.metadata["autoResearch.runId"])
      assertEquals(index.toString(), request.metadata["autoResearch.promptIndex"])
      assertEquals("Objective", request.metadata["objective"])
      assertEquals("ecosystem", request.metadata["streamId"])
      assertTrue(request.metadata["plan.summary"]!!.startsWith("Plan summary"))
      assertTrue(request.metadata["autoResearch.promptHash"]!!.isNotBlank())
    }
  }

  @Test
  fun `handlePlanOutcome skips blank prompts`() {
    val plan =
      GraphRelationshipPlan(
        objective = "Objective",
        summary = "Plan summary",
        prioritizedPrompts = listOf("   ", "Valid Prompt"),
      )
    val outcome =
      AutoResearchPlanOutcome(
        workflowId = "wf-123",
        runId = "run-123",
        intent = AutoResearchPlanIntent(objective = "Objective"),
        plan = plan,
      )

    val result = activities.handlePlanOutcome(outcome)

    assertEquals(1, result.researchLaunches.size)
    assertEquals("Valid Prompt", result.researchLaunches.first().prompt)
  }

  private class RecordingLauncher : CodexResearchLauncher {
    data class Request(
      val prompt: String,
      val metadata: Map<String, String>,
    )

    val requests = mutableListOf<Request>()

    override fun startResearch(
      request: CodexResearchRequest,
      argoWorkflowName: String,
      artifactKey: String,
    ): CodexResearchLaunchResult {
      requests += Request(prompt = request.prompt, metadata = request.metadata)
      return CodexResearchLaunchResult("codex-${requests.size}", "run-${requests.size}", "2025-11-10T00:00:00Z")
    }
  }
}
