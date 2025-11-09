package ai.proompteng.graf.codex

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.setBody
import io.ktor.http.content.TextContent
import io.ktor.client.request.*
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ArgoWorkflowClientTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun mockHttpClient(engine: MockEngine) =
    HttpClient(engine) {
      install(ContentNegotiation) {
        json(json)
      }
    }

  private fun defaultArgoConfig(
    pollIntervalSeconds: Long = 1L,
    pollTimeoutSeconds: Long = 60L,
  ) =
    ArgoConfig(
      apiServer = "https://kubernetes.default.svc",
      namespace = "argo-workflows",
      workflowTemplateName = "codex-research-workflow",
      serviceAccountName = "graf",
      tokenPath = "/tmp/token",
      caCertPath = "/tmp/ca",
      pollIntervalSeconds = pollIntervalSeconds,
      pollTimeoutSeconds = pollTimeoutSeconds,
    )

  private fun defaultMinioConfig() =
    MinioConfig(
      endpoint = "http://minio:9000",
      bucket = "argo-workflows",
      accessKey = "access",
      secretKey = "secret",
      secure = true,
      region = "us-east-1",
    )

  private fun argoClient(engine: MockEngine, config: ArgoConfig = defaultArgoConfig(), minio: MinioConfig = defaultMinioConfig()) =
    ArgoWorkflowClient(config, mockHttpClient(engine), minio, json)

  @Test
  fun `resolve artifact references returns defaults`() {
    val argoConfig =
      ArgoConfig(
        apiServer = "https://temporal",
        namespace = "argo-workflows",
        workflowTemplateName = "codex-research-workflow",
        serviceAccountName = "graf",
        tokenPath = "/tmp/token",
        caCertPath = "/tmp/ca",
        pollIntervalSeconds = 1L,
        pollTimeoutSeconds = 60L,
      )
    val minioConfig =
      MinioConfig(
        endpoint = "http://minio:9000",
        bucket = "argo-workflows",
        accessKey = "access",
        secretKey = "secret",
        secure = true,
        region = "us-east-1",
      )
    HttpClient(CIO).use { client ->
      val argoClient = ArgoWorkflowClient(argoConfig, client, minioConfig, json)
      val status =
        ArgoWorkflowStatus(
          phase = "Succeeded",
          nodes =
            mapOf(
              "codex" to
                ArgoWorkflowNode(
                  outputs =
                    ArgoWorkflowOutputs(
                      artifacts =
                        listOf(
                          ArgoWorkflowArtifact(
                            name = "codex-artifact",
                            s3 =
                              ArgoS3Artifact(
                                bucket = "argo-workflows",
                                key = "codex-artifact.json",
                                endpoint = "http://minio:9000",
                                region = "us-east-1",
                              ),
                          ),
                        ),
                    ),
                ),
            ),
          finishedAt = "now",
        )
      val references = argoClient.resolveArtifactReferences(status)
      assertEquals(1, references.size)
      assertEquals("argo-workflows", references.first().bucket)
      assertEquals("codex-artifact.json", references.first().key)
    }
  }

  @Test
  fun `submit workflow posts padded payload`() = runBlocking {
    val engine =
      MockEngine { request ->
        assertEquals(HttpMethod.Post, request.method)
        assertTrue(request.url.encodedPath.endsWith("/workflows"))
        val bodyText = (request.body as TextContent).text
        val payload = json.decodeFromString<ArgoWorkflowCreatePayload>(bodyText)
        assertEquals("argoproj.io/v1alpha1", payload.apiVersion)
        assertEquals("Workflow", payload.kind)
        assertEquals("artifact-key", payload.spec.arguments.parameters.first { it.name == "artifactKey" }.value)
        assertEquals("test prompt", payload.spec.arguments.parameters.first { it.name == "prompt" }.value)
        respond(
          """{"metadata": {"name": "codex-workflow", "labels": {"codex.stage": "research"}}}""",
          HttpStatusCode.OK,
          headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
        )
      }
    val client = argoClient(engine)

    val result =
      client.submitWorkflow(
        SubmitArgoWorkflowRequest(
          workflowName = "codex-workflow",
          prompt = "test prompt",
          metadata = emptyMap(),
          artifactKey = "artifact-key",
        ),
      )
    assertEquals("codex-workflow", result.workflowName)
  }

  @Test
  fun `waitForCompletion returns when workflow eventually succeeds`() = runBlocking {
    val statuses =
      listOf(
        ArgoWorkflowResource(
          metadata = ArgoMetadata(name = "codex-workflow", labels = emptyMap()),
          status = ArgoWorkflowStatus(phase = "Running"),
        ),
        ArgoWorkflowResource(
          metadata = ArgoMetadata(name = "codex-workflow", labels = emptyMap()),
          status =
            ArgoWorkflowStatus(
              phase = "Succeeded",
              finishedAt = "now",
              nodes =
                mapOf(
                  "codex" to
                    ArgoWorkflowNode(
                      outputs =
                        ArgoWorkflowOutputs(
                          artifacts =
                            listOf(
                              ArgoWorkflowArtifact(
                                name = "codex-artifact",
                                s3 =
                                  ArgoS3Artifact(
                                    bucket = "bucket",
                                    key = "artifact",
                                    endpoint = "http://minio:9000",
                                    region = "us-east-1",
                                  ),
                              ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
      )
    var calls = 0
    val engine =
      MockEngine { request ->
        assertEquals(HttpMethod.Get, request.method)
        val status = statuses[minOf(calls, statuses.lastIndex)]
        calls++
        respond(
          json.encodeToString(status),
          HttpStatusCode.OK,
          headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
        )
      }
    val client = argoClient(engine, defaultArgoConfig(pollIntervalSeconds = 0, pollTimeoutSeconds = 10))
    val completed = client.waitForCompletion("codex-workflow", timeoutSeconds = 10)
    assertEquals("Succeeded", completed.phase)
    assertEquals("now", completed.finishedAt)
    assertEquals(1, completed.artifactReferences.size)
    assertEquals("artifact", completed.artifactReferences.first().key)
  }

  @Test
  fun `waitForCompletion throws when workflow fails`() = runBlocking {
    val engine =
      MockEngine {
        respond(
          json.encodeToString(
            ArgoWorkflowResource(
              metadata = ArgoMetadata(name = "codex-workflow", labels = emptyMap()),
              status = ArgoWorkflowStatus(phase = "Failed"),
            ),
          ),
          HttpStatusCode.OK,
          headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
        )
      }
    val client = argoClient(engine, defaultArgoConfig(pollIntervalSeconds = 0, pollTimeoutSeconds = 10))
    assertFailsWith<IllegalStateException> { client.waitForCompletion("codex-workflow", timeoutSeconds = 10) }
  }
}
