package ai.proompteng.graf.codex

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.ArtifactReference
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement

class ArgoWorkflowClient(
  private val config: ArgoConfig,
  private val httpClient: HttpClient,
  private val minioConfig: MinioConfig,
  private val json: Json,
) {
  private val baseUrl = "${config.apiServer}/apis/argoproj.io/v1alpha1/namespaces/${config.namespace}"

  suspend fun submitWorkflow(request: SubmitArgoWorkflowRequest): SubmitArgoWorkflowResult {
    val metadataJson =
      request.metadata
        .takeIf { it.isNotEmpty() }
        ?.let { json.encodeToJsonElement(it) }
    val payload =
      ArgoWorkflowCreatePayload(
        metadata = ArgoMetadata(name = request.workflowName, labels = mapOf("codex.stage" to "research")),
        spec =
          ArgoWorkflowSpec(
            serviceAccountName = config.serviceAccountName,
            workflowTemplateRef = WorkflowTemplateRef(name = config.workflowTemplateName),
            arguments =
              ArgoArguments(
                parameters =
                  listOfNotNull(
                    ArgoParameter(name = "prompt", value = request.prompt),
                    ArgoParameter(name = "artifactKey", value = request.artifactKey),
                    ArgoParameter(name = "artifactBucket", value = minioConfig.bucket),
                    ArgoParameter(name = "artifactEndpoint", value = minioConfig.endpoint),
                    minioConfig.region
                      ?.takeUnless(String::isBlank)
                      ?.let { ArgoParameter(name = "artifactRegion", value = it) },
                    metadataJson?.let { ArgoParameter(name = "metadata", value = json.encodeToString(it)) },
                  ),
              ),
          ),
      )
    val response: ArgoWorkflowResource =
      httpClient
        .post("$baseUrl/workflows") {
          contentType(ContentType.Application.Json)
          setBody(payload)
        }.body()
    return SubmitArgoWorkflowResult(response.metadata.name)
  }

  suspend fun waitForCompletion(
    workflowName: String,
    timeoutSeconds: Long,
  ): CompletedArgoWorkflow {
    val deadline = System.currentTimeMillis() + timeoutSeconds * 1000
    while (true) {
      val resource = fetchWorkflow(workflowName)
      val phase = resource.status?.phase
      when (phase) {
        "Succeeded" -> return CompletedArgoWorkflow(
          phase = phase,
          finishedAt = resource.status.finishedAt,
          artifactReferences = resolveArtifactReferences(resource.status),
        )
        "Failed", "Error" -> throw IllegalStateException("Argo workflow $workflowName failed with phase $phase")
      }
      if (System.currentTimeMillis() > deadline) {
        throw IllegalStateException("Timed out waiting for Argo workflow $workflowName to complete")
      }
      delay(config.pollIntervalSeconds * 1000)
    }
  }

  private suspend fun fetchWorkflow(name: String): ArgoWorkflowResource = httpClient.get("$baseUrl/workflows/$name").body()

  internal fun resolveArtifactReferences(status: ArgoWorkflowStatus?): List<ArtifactReference> {
    if (status == null) {
      return emptyList()
    }
    val references = mutableListOf<ArtifactReference>()
    status.nodes?.values?.forEach { node ->
      node.outputs?.artifacts?.forEach { artifact ->
        val s3 = artifact.s3 ?: return@forEach
        val bucket = s3.bucket?.takeIf(String::isNotBlank) ?: minioConfig.bucket
        val key = s3.key ?: return@forEach
        val endpoint = s3.endpoint?.takeIf(String::isNotBlank) ?: minioConfig.endpoint
        references += ArtifactReference(bucket, key, endpoint, s3.region)
      }
    }
    return references
  }
}

@Serializable
data class ArgoWorkflowCreatePayload(
  val metadata: ArgoMetadata,
  val spec: ArgoWorkflowSpec,
)

@Serializable
data class ArgoMetadata(
  val name: String,
  val labels: Map<String, String>,
)

@Serializable
data class ArgoWorkflowSpec(
  val serviceAccountName: String,
  val workflowTemplateRef: WorkflowTemplateRef,
  val arguments: ArgoArguments,
)

@Serializable
data class WorkflowTemplateRef(
  val name: String,
)

@Serializable
data class ArgoArguments(
  val parameters: List<ArgoParameter>,
)

@Serializable
data class ArgoParameter(
  val name: String,
  val value: String,
)

@Serializable
data class ArgoWorkflowResource(
  val metadata: ArgoMetadata,
  val status: ArgoWorkflowStatus? = null,
)

@Serializable
data class ArgoWorkflowStatus(
  val phase: String,
  val nodes: Map<String, ArgoWorkflowNode>? = null,
  val finishedAt: String? = null,
)

@Serializable
data class ArgoWorkflowNode(
  val outputs: ArgoWorkflowOutputs? = null,
)

@Serializable
data class ArgoWorkflowOutputs(
  val artifacts: List<ArgoWorkflowArtifact>? = null,
)

@Serializable
data class ArgoWorkflowArtifact(
  val name: String,
  val s3: ArgoS3Artifact? = null,
)

@Serializable
data class ArgoS3Artifact(
  val bucket: String? = null,
  val key: String? = null,
  val endpoint: String? = null,
  val region: String? = null,
)
