package ai.proompteng.graf.routes

import ai.proompteng.graf.autoresearch.AutoResearchPlannerService
import ai.proompteng.graf.autoresearch.AutoResearchWorkflow
import ai.proompteng.graf.autoresearch.WorkflowStartResult
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.AutoResearchPlanRequest
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
import io.mockk.every
import io.mockk.mockk
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowOptions
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
  fun `POST AutoResearch returns planner response`() =
    testApplication {
      val graphService = mockk<GraphService>(relaxed = true)
      val workflowClient = mockk<WorkflowClient>()
      every { workflowClient.newWorkflowStub(AutoResearchWorkflow::class.java, any<WorkflowOptions>()) } returns
        mockk<AutoResearchWorkflow>(relaxed = true)
      val plannerService =
        AutoResearchPlannerService(workflowClient, "queue", defaultSampleLimit = 5) { _, _ ->
          WorkflowStartResult("wf", "run", "start")
        }

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
          graphRoutes(graphService, mockk(relaxed = true), minioConfig, plannerService)
        }
      }

      val response =
        client.post("/autoresearch") {
          header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
          setBody(json.encodeToString(AutoResearchPlanRequest.serializer(), AutoResearchPlanRequest(objective = "test")))
        }

      assertEquals(HttpStatusCode.Accepted, response.status)
      assertTrue(response.bodyAsText().contains("\"workflowId\":\"wf\""))
    }

  @Test
  fun `POST AutoResearch returns 503 when agent disabled`() =
    testApplication {
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
          graphRoutes(mockk(relaxed = true), mockk(relaxed = true), minioConfig, null)
        }
      }

      val response =
        client.post("/autoresearch") {
          header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
          setBody(json.encodeToString(AutoResearchPlanRequest.serializer(), AutoResearchPlanRequest(objective = "test")))
        }
      assertEquals(HttpStatusCode.ServiceUnavailable, response.status)
    }

}
