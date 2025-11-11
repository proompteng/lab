package ai.proompteng.graf.codex

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.ArtifactReference
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import kotlinx.coroutines.delay
import kotlinx.coroutines.future.await
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement

class ArgoWorkflowClient(
  private val config: ArgoConfig,
  private val httpClient: HttpClient,
  private val minioConfig: MinioConfig,
  private val json: Json,
  private val serviceAccountToken: String,
) {
  private val baseUrl = "${config.apiServer}/apis/argoproj.io/v1alpha1/namespaces/${config.namespace}"
  private val authorizationHeader =
    if (serviceAccountToken.startsWith("Bearer ", ignoreCase = true)) {
      serviceAccountToken
    } else {
      "Bearer $serviceAccountToken"
    }

  suspend fun submitWorkflow(request: SubmitArgoWorkflowRequest): SubmitArgoWorkflowResult {
    val metadataJson =
      request.metadata.takeIf { it.isNotEmpty() }?.let { json.encodeToJsonElement(it) }
    val payload =
      ArgoWorkflowCreatePayload(
        apiVersion = "argoproj.io/v1alpha1",
        kind = "Workflow",
        metadata =
          ArgoMetadata(
            name = request.workflowName,
            labels = mapOf("codex.stage" to "research"),
          ),
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
                    ArgoParameter(name = "artifactEndpoint", value = minioConfig.artifactEndpoint),
                    minioConfig.region
                      ?.takeUnless(String::isBlank)
                      ?.let { ArgoParameter(name = "artifactRegion", value = it) },
                    metadataJson?.let { ArgoParameter(name = "metadata", value = json.encodeToString(it)) },
                  ),
              ),
          ),
      )

    val requestBody = json.encodeToString(payload)
    val httpRequest =
      HttpRequest
        .newBuilder()
        .uri(URI.create("$baseUrl/workflows"))
        .header("Content-Type", "application/json")
        .header("Authorization", authorizationHeader)
        .POST(HttpRequest.BodyPublishers.ofString(requestBody))
        .build()
    val response = httpClient.sendAsync(httpRequest, HttpResponse.BodyHandlers.ofString()).await()
    val responseBody = response.body()
    if (response.statusCode() !in 200..299) {
      throw IllegalStateException("Argo workflow submission failed status=${response.statusCode()} body=$responseBody")
    }
    if (responseBody.contains("\"status\":\"Failure\"")) {
      throw IllegalStateException("Argo workflow submission failed body=$responseBody")
    }
    return SubmitArgoWorkflowResult(request.workflowName)
  }

  suspend fun waitForCompletion(workflowName: String, timeoutSeconds: Long): CompletedArgoWorkflow {
    val deadline = System.currentTimeMillis() + timeoutSeconds * 1000
    while (true) {
      val resource = fetchWorkflow(workflowName)
      val phase = resource.status?.phase
      when (phase) {
        "Succeeded" ->
          return CompletedArgoWorkflow(
            phase = phase,
            finishedAt = resource.status?.finishedAt,
            artifactReferences = resolveArtifactReferences(resource.status),
          )
        "Failed", "Error" ->
          throw IllegalStateException("Argo workflow $workflowName failed with phase $phase")
      }
      if (System.currentTimeMillis() > deadline) {
        throw IllegalStateException("Timed out waiting for Argo workflow $workflowName to complete")
      }
      delay(config.pollIntervalSeconds * 1000)
    }
  }

  private suspend fun fetchWorkflow(name: String): ArgoWorkflowResource {
    val httpRequest =
      HttpRequest
        .newBuilder()
        .uri(URI.create("$baseUrl/workflows/$name"))
        .header("Authorization", authorizationHeader)
        .GET()
        .build()
    val response = httpClient.sendAsync(httpRequest, HttpResponse.BodyHandlers.ofString()).await()
    val body = response.body()
    if (response.statusCode() !in 200..299) {
      throw IllegalStateException("Failed to fetch workflow $name status=${response.statusCode()} body=$body")
    }
    return json.decodeFromString(ArgoWorkflowResource.serializer(), body)
  }

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
        val endpoint = s3.endpoint?.takeIf(String::isNotBlank) ?: minioConfig.artifactEndpoint
        references += ArtifactReference(bucket, key, endpoint, s3.region)
      }
    }
    return references
  }
}

@Serializable
internal data class ArgoWorkflowCreatePayload(
  val apiVersion: String,
  val kind: String,
  val metadata: ArgoMetadata,
  val spec: ArgoWorkflowSpec,
)

@Serializable
internal data class ArgoMetadata(
  val name: String? = null,
  val labels: Map<String, String>? = null,
)

@Serializable
internal data class ArgoWorkflowSpec(
  val serviceAccountName: String,
  val workflowTemplateRef: WorkflowTemplateRef,
  val arguments: ArgoArguments,
)

@Serializable
internal data class WorkflowTemplateRef(val name: String)

@Serializable
internal data class ArgoArguments(val parameters: List<ArgoParameter>)

@Serializable
internal data class ArgoParameter(val name: String, val value: String)

@Serializable
internal data class ArgoWorkflowResource(
  val metadata: ArgoMetadata = ArgoMetadata(),
  val status: ArgoWorkflowStatus? = null,
)

@Serializable
internal data class ArgoWorkflowStatus(
  val phase: String,
  val nodes: Map<String, ArgoWorkflowNode>? = null,
  val finishedAt: String? = null,
)

@Serializable
internal data class ArgoWorkflowNode(val outputs: ArgoWorkflowOutputs? = null)

@Serializable
internal data class ArgoWorkflowOutputs(val artifacts: List<ArgoWorkflowArtifact>? = null)

@Serializable
internal data class ArgoWorkflowArtifact(val name: String, val s3: ArgoS3Artifact? = null)

@Serializable
internal data class ArgoS3Artifact(
  val bucket: String? = null,
  val key: String? = null,
  val endpoint: String? = null,
  val region: String? = null,
)
