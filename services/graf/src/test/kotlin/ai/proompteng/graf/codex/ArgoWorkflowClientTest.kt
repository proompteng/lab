package ai.proompteng.graf.codex

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.net.http.HttpClient
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.text.Charsets

class ArgoWorkflowClientTest {
  private val json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
      explicitNulls = false
    }
  private val minioConfig =
    MinioConfig(
      endpoint = "http://minio:9000",
      bucket = "argo-workflows",
      accessKey = "access",
      secretKey = "secret",
      secure = true,
      region = "us-east-1",
    )

  private fun baseClient(apiServer: String) =
    ArgoWorkflowClient(
      defaultArgoConfig(apiServer),
      HttpClient.newHttpClient(),
      minioConfig,
      json,
      "graf-token",
    )

  private fun defaultArgoConfig(apiServer: String = "https://kubernetes.default.svc") =
    ArgoConfig(
      apiServer = apiServer,
      namespace = "argo-workflows",
      workflowTemplateName = "codex-research-workflow",
      serviceAccountName = "graf",
      tokenPath = "/tmp/token",
      caCertPath = "/tmp/ca",
      pollIntervalSeconds = 0L,
      pollTimeoutSeconds = 10L,
    )

  @Test
  fun `resolveArtifactReferences returns provided buckets`() {
    val client = baseClient("https://unused")
    val status =
      ArgoWorkflowStatus(
        phase = "Succeeded",
        nodes =
          mapOf(
            "node" to
              ArgoWorkflowNode(
                outputs =
                  ArgoWorkflowOutputs(
                    artifacts =
                      listOf(
                        ArgoWorkflowArtifact(
                          name = "codex",
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
        finishedAt = "now",
      )
    val refs = client.resolveArtifactReferences(status)
    assertEquals(1, refs.size)
    assertEquals("artifact", refs.first().key)
  }

  @Test
  fun `submitWorkflow posts payload and honors Bearer token`() {
    MockWebServer().use { server ->
      server.start()
      val response = MockResponse().setResponseCode(200).setBody("{}")
      server.enqueue(response)
      val client = baseClient(server.url("/").toString().removeSuffix("/"))
      runBlocking {
        val result =
          client.submitWorkflow(
            SubmitArgoWorkflowRequest(
              workflowName = "codex-test",
              prompt = "hello {{ world }}",
              metadata = mapOf("note" to "{{ inputs.proto_ref }}"),
              artifactKey = "codex-test/artifact.json",
            ),
          )
        assertEquals("codex-test", result.workflowName)
      }
      val recorded = server.takeRequest()
      assertEquals(
        "/apis/argoproj.io/v1alpha1/namespaces/argo-workflows/workflows",
        recorded.path,
      )
      assertEquals("Bearer graf-token", recorded.getHeader("Authorization"))
      val payload =
        json.decodeFromString(ArgoWorkflowCreatePayload.serializer(), recorded.body.readUtf8())
      val promptParam = payload.spec.arguments.parameters.first { it.name == "prompt" }
      val decodedPrompt = String(Base64.getDecoder().decode(promptParam.value), Charsets.UTF_8)
      assertEquals("hello {{ world }}", decodedPrompt)
      val metadataParam = payload.spec.arguments.parameters.first { it.name == "metadata" }
      val decodedMetadata = String(Base64.getDecoder().decode(metadataParam.value), Charsets.UTF_8)
      assertTrue(decodedMetadata.contains("\"note\":\"{{ inputs.proto_ref }}\""))
    }
  }

  @Test
  fun `submitWorkflow throws when server reports failure`() {
    MockWebServer().use { server ->
      server.start()
      val response =
        MockResponse()
          .setResponseCode(200)
          .setBody("{\"status\":\"Failure\"}")
      server.enqueue(response)
      val client = baseClient(server.url("/").toString().removeSuffix("/"))
      runBlocking {
        assertFailsWith<IllegalStateException> {
          client.submitWorkflow(
            SubmitArgoWorkflowRequest(
              workflowName = "codex-test",
              prompt = "hello",
              metadata = emptyMap(),
              artifactKey = "codex-test/artifact.json",
            ),
          )
        }
      }
    }
  }

  @Test
  fun `waitForCompletion polls until success`() {
    MockWebServer().use { server ->
      server.start()
      val statuses =
        listOf(
          ArgoWorkflowResource(status = ArgoWorkflowStatus(phase = "Running")),
          ArgoWorkflowResource(
            status =
              ArgoWorkflowStatus(
                phase = "Succeeded",
                finishedAt = "now",
                nodes =
                  mapOf(
                    "node" to
                      ArgoWorkflowNode(
                        outputs =
                          ArgoWorkflowOutputs(
                            artifacts =
                              listOf(
                                ArgoWorkflowArtifact(
                                  name = "codex",
                                  s3 =
                                    ArgoS3Artifact(
                                      bucket = "my-bucket",
                                      key = "artifact",
                                      endpoint = "http://minio:9000",
                                    ),
                                ),
                              ),
                          ),
                      ),
                  ),
              ),
          ),
        )
      statuses.forEach { server.enqueue(MockResponse().setBody(json.encodeToString(it))) }
      val client = baseClient(server.url("/").toString().removeSuffix("/"))
      runBlocking {
        val completed = client.waitForCompletion("codex", timeoutSeconds = 5)
        assertEquals("Succeeded", completed.phase)
        assertEquals("now", completed.finishedAt)
        assertEquals(1, completed.artifactReferences.size)
        assertEquals("artifact", completed.artifactReferences.first().key)
      }
    }
  }

  @Test
  fun `waitForCompletion invokes onPoll callback`() {
    MockWebServer().use { server ->
      server.start()
      val statuses =
        listOf(
          ArgoWorkflowResource(status = ArgoWorkflowStatus(phase = "Running")),
          ArgoWorkflowResource(status = ArgoWorkflowStatus(phase = "Running")),
          ArgoWorkflowResource(status = ArgoWorkflowStatus(phase = "Succeeded")),
        )
      statuses.forEach { server.enqueue(MockResponse().setBody(json.encodeToString(it))) }
      val client = baseClient(server.url("/").toString().removeSuffix("/"))
      val polls = AtomicInteger(0)
      runBlocking {
        client.waitForCompletion("codex", timeoutSeconds = 5) { polls.incrementAndGet() }
      }
      assertEquals(2, polls.get())
    }
  }

  @Test
  fun `waitForCompletion throws when workflow fails`() {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(
        MockResponse()
          .setBody(
            json.encodeToString(
              ArgoWorkflowResource(status = ArgoWorkflowStatus(phase = "Failed")),
            ),
          ),
      )
      val client = baseClient(server.url("/").toString().removeSuffix("/"))
      runBlocking {
        assertFailsWith<IllegalStateException> { client.waitForCompletion("codex", timeoutSeconds = 5) }
      }
    }
  }
}
