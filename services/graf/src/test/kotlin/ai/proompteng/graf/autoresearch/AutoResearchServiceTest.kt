package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.model.AutoResearchRequest
import ai.proompteng.graf.model.CodexResearchRequest
import io.mockk.CapturingSlot
import io.mockk.confirmVerified
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlin.test.Test
import kotlin.test.assertEquals

class AutoResearchServiceTest {
  private val codexResearchService = mockk<CodexResearchService>()
  private val promptBuilder = mockk<AutoResearchPromptBuilder>()
  private val service = AutoResearchService(codexResearchService, promptBuilder)

  @Test
  fun `startResearch builds prompt and metadata before delegating`() {
    val request = AutoResearchRequest(userPrompt = "Focus on HBM supply chain")
    val metadata = mapOf("autoResearch.promptVersion" to "2026-01-09")
    val launchResult =
      CodexResearchLaunchResult(
        workflowId = "wf-123",
        runId = "run-456",
        startedAt = "2025-11-11T00:00:00Z",
      )
    val capturedRequest: CapturingSlot<CodexResearchRequest> = slot()

    every { promptBuilder.buildPrompt("Focus on HBM supply chain") } returns "FINAL PROMPT"
    every { promptBuilder.buildMetadata("Focus on HBM supply chain", "argo-auto-research") } returns metadata
    every {
      codexResearchService.startResearch(
        capture(capturedRequest),
        "argo-auto-research",
        "artifact-key",
      )
    } returns launchResult

    val result = service.startResearch(request, "argo-auto-research", "artifact-key")

    assertEquals(launchResult, result)
    val codexRequest = capturedRequest.captured
    assertEquals("FINAL PROMPT", codexRequest.prompt)
    assertEquals(metadata, codexRequest.metadata)

    verify(exactly = 1) { promptBuilder.buildPrompt("Focus on HBM supply chain") }
    verify(exactly = 1) { promptBuilder.buildMetadata("Focus on HBM supply chain", "argo-auto-research") }
    verify(exactly = 1) {
      codexResearchService.startResearch(capturedRequest.captured, "argo-auto-research", "artifact-key")
    }
    confirmVerified(promptBuilder, codexResearchService)
  }
}
