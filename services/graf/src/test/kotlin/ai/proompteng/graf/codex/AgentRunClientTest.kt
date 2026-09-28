package ai.proompteng.graf.codex

import ai.proompteng.graf.config.AgentsConfig
import ai.proompteng.graf.config.MinioConfig
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.net.http.HttpClient
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class AgentRunClientTest {
  private val json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
      explicitNulls = false
    }
  private val minioConfig =
    MinioConfig(
      endpoint = "http://minio:9000",
      bucket = "agents-artifacts",
      accessKey = "access",
      secretKey = "secret",
      secure = false,
      region = "us-east-1",
    )

  private fun baseClient(baseUrl: String) =
    AgentRunClient(
      defaultAgentsConfig(baseUrl),
      HttpClient.newHttpClient(),
      minioConfig,
      json,
      "graf-token",
    )

  private fun defaultAgentsConfig(baseUrl: String = "http://agents.agents.svc.cluster.local") =
    AgentsConfig(
      baseUrl = baseUrl,
      namespace = "agents",
      agentName = "graf-codex-agent",
      serviceAccountName = "agents-sa",
      tokenPath = null,
      bearerToken = null,
      pollIntervalSeconds = 0L,
      pollTimeoutSeconds = 10L,
      ttlSecondsAfterFinished = 7200L,
      secretBindingRef = "codex-github-token",
      secrets = listOf("github-token", "codex-auth"),
    )

  @Test
  fun `resolveArtifactReferences returns provided objects`() {
    val client = baseClient("https://unused")
    val status =
      AgentRunStatus(
        phase = "Succeeded",
        artifacts =
          listOf(
            AgentRunStatusArtifact(
              name = "codex",
              bucket = "bucket",
              key = "artifact",
              endpoint = "http://minio:9000",
              region = "us-east-1",
            ),
          ),
      )

    val refs = client.resolveArtifactReferences(status)

    assertEquals(1, refs.size)
    assertEquals("bucket", refs.first().bucket)
    assertEquals("artifact", refs.first().key)
    assertEquals("http://minio:9000", refs.first().endpoint)
  }

  @Test
  fun `submitRun posts AgentRun payload and honors Bearer token`() {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(
        MockResponse()
          .setResponseCode(201)
          .setBody(
            """
            {
              "ok": true,
              "agentRun": {
                "id": "record-1",
                "agentName": "graf-codex-agent",
                "deliveryId": "codex-test",
                "status": "Pending",
                "externalRunId": "graf-codex-agent-abc"
              },
              "resource": {
                "metadata": { "name": "graf-codex-agent-abc" },
                "status": { "phase": "Pending" }
              }
            }
            """.trimIndent(),
          ),
      )
      val client = baseClient(server.url("/").toString().removeSuffix("/"))

      runBlocking {
        val result =
          client.submitRun(
            SubmitAgentRunRequest(
              runName = "codex-test",
              prompt = "hello {{ world }}",
              metadata = mapOf("note" to "{{ inputs.proto_ref }}"),
              artifactKey = "codex-test/artifact.json",
            ),
          )
        assertEquals("record-1", result.recordId)
        assertEquals("graf-codex-agent-abc", result.resourceName)
      }

      val recorded = server.takeRequest()
      assertEquals("/v1/agent-runs", recorded.path)
      assertEquals("Bearer graf-token", recorded.getHeader("Authorization"))
      assertEquals("codex-test", recorded.getHeader("Idempotency-Key"))
      val payload = json.decodeFromString(AgentRunSubmitPayload.serializer(), recorded.body.readUtf8())
      assertEquals("graf-codex-agent", payload.agentRef.name)
      assertEquals("agents", payload.namespace)
      assertEquals("job", payload.runtime.type)
      assertEquals("agents-sa", payload.runtime.config["serviceAccountName"])
      assertEquals("hello {{ world }}", payload.implementation.text)
      assertEquals("hello {{ world }}", payload.goal.objective)
      assertEquals("codex-test/artifact.json", payload.parameters["artifactKey"])
      assertTrue(payload.parameters.getValue("metadata").contains("\"note\":\"{{ inputs.proto_ref }}\""))
      assertEquals("codex-github-token", payload.policy?.secretBindingRef)
    }
  }

  @Test
  fun `submitRun throws when Agents reports failure`() {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(MockResponse().setResponseCode(403).setBody("{\"error\":\"denied\"}"))
      val client = baseClient(server.url("/").toString().removeSuffix("/"))

      runBlocking {
        assertFailsWith<IllegalStateException> {
          client.submitRun(
            SubmitAgentRunRequest(
              runName = "codex-test",
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
  fun `waitForCompletion polls record endpoint until success`() {
    MockWebServer().use { server ->
      server.start()
      val responses =
        listOf(
          AgentRunReadResponse(
            ok = true,
            agentRun = AgentRunRecordResponse(id = "record-1", status = "Running", externalRunId = "run-1"),
            resource = AgentRunResource(metadata = AgentRunMetadata("run-1"), status = AgentRunStatus("Running")),
          ),
          AgentRunReadResponse(
            ok = true,
            agentRun = AgentRunRecordResponse(id = "record-1", status = "Succeeded", externalRunId = "run-1"),
            resource =
              AgentRunResource(
                metadata = AgentRunMetadata("run-1"),
                status =
                  AgentRunStatus(
                    phase = "Succeeded",
                    finishedAt = "now",
                    artifacts = listOf(AgentRunStatusArtifact(name = "codex", key = "artifact")),
                  ),
              ),
          ),
        )
      responses.forEach { server.enqueue(MockResponse().setBody(json.encodeToString(it))) }
      val client = baseClient(server.url("/").toString().removeSuffix("/"))

      runBlocking {
        val completed = client.waitForCompletion("record-1", timeoutSeconds = 5)
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
      val responses =
        listOf(
          AgentRunReadResponse(
            ok = true,
            agentRun = AgentRunRecordResponse(id = "record-1", status = "Running"),
            resource = AgentRunResource(status = AgentRunStatus("Running")),
          ),
          AgentRunReadResponse(
            ok = true,
            agentRun = AgentRunRecordResponse(id = "record-1", status = "Running"),
            resource = AgentRunResource(status = AgentRunStatus("Running")),
          ),
          AgentRunReadResponse(
            ok = true,
            agentRun = AgentRunRecordResponse(id = "record-1", status = "Succeeded"),
            resource = AgentRunResource(status = AgentRunStatus("Succeeded")),
          ),
        )
      responses.forEach { server.enqueue(MockResponse().setBody(json.encodeToString(it))) }
      val client = baseClient(server.url("/").toString().removeSuffix("/"))
      val polls = AtomicInteger(0)

      runBlocking {
        client.waitForCompletion("record-1", timeoutSeconds = 5) { polls.incrementAndGet() }
      }

      assertEquals(2, polls.get())
    }
  }

  @Test
  fun `waitForCompletion throws when AgentRun fails`() {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(
        MockResponse()
          .setBody(
            json.encodeToString(
              AgentRunReadResponse(
                ok = true,
                agentRun = AgentRunRecordResponse(id = "record-1", status = "Failed"),
                resource = AgentRunResource(status = AgentRunStatus("Failed")),
              ),
            ),
          ),
      )
      val client = baseClient(server.url("/").toString().removeSuffix("/"))

      runBlocking {
        assertFailsWith<IllegalStateException> { client.waitForCompletion("record-1", timeoutSeconds = 5) }
      }
    }
  }
}
