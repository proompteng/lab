package ai.proompteng.graf.routes

import ai.proompteng.graf.autoresearch.AutoresearchPlannerService
import ai.proompteng.graf.autoresearch.AutoresearchWorkflow
import ai.proompteng.graf.autoresearch.AutoresearchWorkflowResult
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.AutoresearchPlanRequest
import ai.proompteng.graf.model.GraphRelationshipPlan
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
  fun `POST autoresearch returns planner response`() =
    testApplication {
      val graphService = mockk<GraphService>(relaxed = true)
      val plan =
        GraphRelationshipPlan(
          objective = "test",
          summary = "summary",
          candidateRelationships = emptyList(),
          currentSignals = emptyList(),
          prioritizedPrompts = emptyList(),
          missingData = emptyList(),
          recommendedTools = emptyList(),
        )
      val workflowResult =
        AutoresearchWorkflowResult(
          workflowId = "wf",
          runId = "run",
          startedAt = "start",
          completedAt = "done",
          plan = plan,
        )
      val workflowClient = mockk<WorkflowClient>()
      every { workflowClient.newWorkflowStub(AutoresearchWorkflow::class.java, any<WorkflowOptions>()) } returns mockk(relaxed = true)
      val plannerService =
        AutoresearchPlannerService(workflowClient, "queue", defaultSampleLimit = 5) { _, _ -> workflowResult }

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
          setBody(json.encodeToString(AutoresearchPlanRequest.serializer(), AutoresearchPlanRequest(objective = "test")))
        }

      assertEquals(HttpStatusCode.OK, response.status)
      assertTrue(response.bodyAsText().contains("\"workflowId\":\"wf\""))
    }

  @Test
  fun `POST autoresearch returns 503 when agent disabled`() =
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
          setBody(json.encodeToString(AutoresearchPlanRequest.serializer(), AutoresearchPlanRequest(objective = "test")))
        }
      assertEquals(HttpStatusCode.ServiceUnavailable, response.status)
    }
}
