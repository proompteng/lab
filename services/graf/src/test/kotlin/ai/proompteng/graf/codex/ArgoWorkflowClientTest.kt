package ai.proompteng.graf.codex

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class ArgoWorkflowClientTest {
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
      val argoClient = ArgoWorkflowClient(argoConfig, client, minioConfig, Json { ignoreUnknownKeys = true })
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
}
