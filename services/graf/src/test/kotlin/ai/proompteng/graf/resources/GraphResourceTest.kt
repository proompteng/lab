package ai.proompteng.graf.resources

import ai.proompteng.graf.autoresearch.AutoResearchConfig
import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.AutoResearchLaunchResponse
import ai.proompteng.graf.model.AutoResearchRequest
import ai.proompteng.graf.services.GraphService
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import jakarta.ws.rs.core.Response
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GraphResourceTest {
  private val graphService = mockk<GraphService>(relaxed = true)
  private val codexResearchService = mockk<CodexResearchService>(relaxed = true)
  private val autoResearchService = mockk<AutoResearchLauncher>()
  private val minioConfig =
    MinioConfig(
      endpoint = "http://minio",
      bucket = "bucket",
      accessKey = "key",
      secretKey = "secret",
      secure = false,
      region = "us-east-1",
    )
  private val autoResearchConfig =
    AutoResearchConfig(
      knowledgeBaseName = "Test knowledge base",
      stage = AutoResearchConfig.DEFAULT_STAGE,
      streamId = AutoResearchConfig.DEFAULT_STREAM_ID,
      defaultOperatorGuidance = AutoResearchConfig.DEFAULT_OPERATOR_GUIDANCE,
      defaultGoalsText = AutoResearchConfig.DEFAULT_GOALS_TEXT,
    )
  private val resource =
    GraphResource(graphService, codexResearchService, minioConfig, autoResearchConfig, autoResearchService)

  @Test
  fun `POST autoresearch with user prompt returns accepted`() {
    val requestSlot = slot<AutoResearchRequest>()
    val workflowSlot = slot<String>()
    val artifactSlot = slot<String>()
    every { autoResearchService.startResearch(capture(requestSlot), capture(workflowSlot), capture(artifactSlot)) } returns
      CodexResearchLaunchResult(
        workflowId = "wf-123",
        runId = "run-123",
        startedAt = "2025-11-10T00:00:00Z",
      )

    val response =
      runBlocking { resource.startAutoResearch(AutoResearchRequest(userPrompt = "Map new HBM supply")) }
    assertEquals(Response.Status.ACCEPTED.statusCode, response.status)
    val body = response.entity as AutoResearchLaunchResponse
    assertEquals("wf-123", body.workflowId)
    assertEquals("run-123", body.runId)
    assertTrue(body.argoWorkflowName.startsWith("${autoResearchConfig.workflowNamePrefix}-"))
    assertEquals("bucket", body.artifactReferences.first().bucket)
    assertEquals("codex-research/${body.argoWorkflowName}/codex-artifact.json", body.artifactReferences.first().key)
    assertEquals("Map new HBM supply", requestSlot.captured.userPrompt)
    assertEquals(body.argoWorkflowName, workflowSlot.captured)
    assertEquals("codex-research/${body.argoWorkflowName}/codex-artifact.json", artifactSlot.captured)
  }

  @Test
  fun `POST autoresearch without prompt still accepted`() {
    val requestSlot = slot<AutoResearchRequest>()
    every { autoResearchService.startResearch(capture(requestSlot), any(), any()) } returns
      CodexResearchLaunchResult(
        workflowId = "wf-999",
        runId = "run-999",
        startedAt = "2025-11-10T00:10:00Z",
      )

    val response = runBlocking { resource.startAutoResearch(AutoResearchRequest()) }
    assertEquals(Response.Status.ACCEPTED.statusCode, response.status)
    val body = response.entity as AutoResearchLaunchResponse
    assertEquals("wf-999", body.workflowId)
    assertTrue(body.argoWorkflowName.startsWith("${autoResearchConfig.workflowNamePrefix}-"))
    assertTrue(requestSlot.captured.userPrompt.isNullOrBlank())
  }
}
