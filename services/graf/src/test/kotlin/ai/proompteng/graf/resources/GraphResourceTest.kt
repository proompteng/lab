package ai.proompteng.graf.resources

import ai.proompteng.graf.autoresearch.AutoResearchConfig
import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.config.AgentsConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.AutoResearchLaunchResponse
import ai.proompteng.graf.model.AutoResearchRequest
import ai.proompteng.graf.model.CodexResearchRequest
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
      stage = "Auto Research_stage",
      streamId = AutoResearchConfig.DEFAULT_STREAM_ID,
      defaultOperatorGuidance = AutoResearchConfig.DEFAULT_OPERATOR_GUIDANCE,
      defaultGoalsText = AutoResearchConfig.DEFAULT_GOALS_TEXT,
    )

  private fun resource(env: Map<String, String>) =
    GraphResource(
      graphService,
      codexResearchService,
      minioConfig,
      autoResearchConfig,
      autoResearchService,
      AgentsConfig.fromEnvironment(env),
    )

  private val resource = resource(mapOf("AGENTS_GRAF_AGENT_NAME" to "test-research-agent"))

  @Test
  fun `both research routes reject requests before dispatch when no agent is configured`() {
    val disabled = resource(emptyMap())
    runBlocking {
      assertEquals(503, disabled.startCodexResearch(CodexResearchRequest(prompt = "research")).status)
      assertEquals(503, disabled.startAutoResearch(AutoResearchRequest()).status)
    }
  }

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
    assertTrue(body.agentRunName.startsWith("${autoResearchConfig.agentRunNamePrefix}-"))
    assertEquals("bucket", body.artifactReferences.first().bucket)
    assertEquals("codex-research/${body.agentRunName}/codex-artifact.json", body.artifactReferences.first().key)
    assertEquals("Map new HBM supply", requestSlot.captured.userPrompt)
    assertEquals(body.agentRunName, workflowSlot.captured)
    assertEquals("codex-research/${body.agentRunName}/codex-artifact.json", artifactSlot.captured)
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
    assertTrue(body.agentRunName.startsWith("${autoResearchConfig.agentRunNamePrefix}-"))
    assertTrue(requestSlot.captured.userPrompt.isNullOrBlank())
  }
}
