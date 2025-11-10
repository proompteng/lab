package ai.proompteng.graf.routes

import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.AutoResearchLaunchResponse
import ai.proompteng.graf.model.AutoResearchRequest
import ai.proompteng.graf.services.GraphService
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.mockk.CapturingSlot
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GraphRoutesTest {
  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }

  @Test
  fun `POST AutoResearch launches Codex workflow with optional user prompt`() =
    testApplication {
      val graphService = mockk<GraphService>(relaxed = true)
      val codexResearchService = mockk<CodexResearchService>(relaxed = true)
      val autoResearchService = mockk<AutoResearchLauncher>()
      val capturedRequest: CapturingSlot<AutoResearchRequest> = slot()
      val capturedWorkflowName = slot<String>()
      val capturedArtifactKey = slot<String>()
      every { autoResearchService.startResearch(capture(capturedRequest), capture(capturedWorkflowName), capture(capturedArtifactKey)) } returns
        CodexResearchLaunchResult(
          workflowId = "wf-123",
          runId = "run-123",
          startedAt = "2025-11-10T00:00:00Z",
        )

      application {
        install(ContentNegotiation) { json(this@GraphRoutesTest.json) }
        val minioConfig =
          MinioConfig(
            endpoint = "http://minio",
            bucket = "bucket",
            accessKey = "key",
            secretKey = "secret",
            secure = false,
            region = "us-east-1",
          )
        routing {
          graphRoutes(graphService, codexResearchService, minioConfig, autoResearchService)
        }
      }

      val response =
        client.post("/autoresearch") {
          header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
          setBody(json.encodeToString(AutoResearchRequest.serializer(), AutoResearchRequest(userPrompt = "Map new HBM supply")))
        }

      assertEquals(HttpStatusCode.Accepted, response.status)
      val body = json.decodeFromString(AutoResearchLaunchResponse.serializer(), response.bodyAsText())
      assertEquals("wf-123", body.workflowId)
      assertEquals("run-123", body.runId)
      assertTrue(body.argoWorkflowName.startsWith("auto-research-"))
      assertEquals("bucket", body.artifactReferences.first().bucket)
      assertEquals("codex-research/${body.argoWorkflowName}/codex-artifact.json", body.artifactReferences.first().key)

      verify(exactly = 1) { autoResearchService.startResearch(any(), any(), any()) }
      assertEquals("Map new HBM supply", capturedRequest.captured.userPrompt)
      assertEquals(body.argoWorkflowName, capturedWorkflowName.captured)
      assertEquals("codex-research/${body.argoWorkflowName}/codex-artifact.json", capturedArtifactKey.captured)
    }

  @Test
  fun `POST AutoResearch works without user prompt`() =
    testApplication {
      val autoResearchService = mockk<AutoResearchLauncher>()
      every { autoResearchService.startResearch(any(), any(), any()) } returns
        CodexResearchLaunchResult(
          workflowId = "wf-999",
          runId = "run-999",
          startedAt = "2025-11-10T00:10:00Z",
        )

      application {
        install(ContentNegotiation) { json(this@GraphRoutesTest.json) }
        val minioConfig =
          MinioConfig(
            endpoint = "http://minio",
            bucket = "bucket",
            accessKey = "key",
            secretKey = "secret",
            secure = false,
            region = "us-east-1",
          )
        routing {
          graphRoutes(mockk(relaxed = true), mockk(relaxed = true), minioConfig, autoResearchService)
        }
      }

      val response =
        client.post("/autoresearch") {
          header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
          setBody("{}")
        }

      assertEquals(HttpStatusCode.Accepted, response.status)
      val body = json.decodeFromString(AutoResearchLaunchResponse.serializer(), response.bodyAsText())
      assertEquals("wf-999", body.workflowId)
      assertTrue(body.argoWorkflowName.startsWith("auto-research-"))
    }
}
