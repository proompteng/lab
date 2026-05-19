package ai.proompteng.graf.codex

import ai.proompteng.graf.config.AgentsConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.model.ArtifactReference
import kotlinx.coroutines.delay
import kotlinx.coroutines.future.await
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets

class AgentRunClient(
  private val config: AgentsConfig,
  private val httpClient: HttpClient,
  private val minioConfig: MinioConfig,
  private val json: Json,
  serviceAccountToken: String?,
) {
  private val authorizationHeader =
    (config.bearerToken ?: serviceAccountToken)
      ?.takeIf(String::isNotBlank)
      ?.let { token ->
        if (token.startsWith("Bearer ", ignoreCase = true)) token else "Bearer $token"
      }

  suspend fun submitRun(request: SubmitAgentRunRequest): SubmitAgentRunResult {
    val payload =
      AgentRunSubmitPayload(
        agentRef = AgentRunRef(name = config.agentName),
        namespace = config.namespace,
        idempotencyKey = request.runName,
        implementation =
          AgentRunImplementation(
            text = request.prompt,
            summary = "Graf Codex research ${request.runName}",
          ),
        goal = AgentRunGoal(objective = request.prompt),
        runtime =
          AgentRunRuntime(
            type = "job",
            config = mapOf("serviceAccountName" to config.serviceAccountName),
          ),
        parameters =
          buildMap {
            put("stage", "research")
            put("artifactKey", request.artifactKey)
            put("artifactBucket", minioConfig.bucket)
            put("artifactEndpoint", minioConfig.artifactEndpoint)
            minioConfig.region?.takeUnless(String::isBlank)?.let { put("artifactRegion", it) }
            put("metadata", json.encodeToString(request.metadata))
            request.metadata.forEach { (key, value) ->
              if (key.isNotBlank() && value.isNotBlank() && key != "prompt") {
                put(key, value)
              }
            }
          },
        secrets = config.secrets,
        policy =
          config.secretBindingRef
            ?.takeIf(String::isNotBlank)
            ?.let { AgentRunPolicy(secretBindingRef = it) },
        ttlSecondsAfterFinished = config.ttlSecondsAfterFinished,
      )

    val httpRequest =
      requestBuilder("/v1/agent-runs")
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", request.runName)
        .POST(HttpRequest.BodyPublishers.ofString(json.encodeToString(payload)))
        .build()
    val response = httpClient.sendAsync(httpRequest, HttpResponse.BodyHandlers.ofString()).await()
    val body = response.body()
    if (response.statusCode() !in 200..299) {
      throw IllegalStateException("AgentRun submission failed status=${response.statusCode()} body=$body")
    }

    val parsed = json.decodeFromString(AgentRunSubmitResponse.serializer(), body)
    if (!parsed.ok) {
      throw IllegalStateException("AgentRun submission failed body=$body")
    }

    val recordId = parsed.agentRun?.id ?: request.runName
    val resourceName = parsed.resource?.metadata?.name ?: parsed.agentRun?.externalRunId ?: parsed.existingAgentRunName
    if (recordId.isNullOrBlank() || resourceName.isNullOrBlank()) {
      throw IllegalStateException("AgentRun submission response missing record/resource id body=$body")
    }
    return SubmitAgentRunResult(
      runName = request.runName,
      recordId = recordId,
      resourceName = resourceName,
      artifactKey = request.artifactKey,
    )
  }

  suspend fun waitForCompletion(
    runNameOrRecordId: String,
    timeoutSeconds: Long,
    onPoll: () -> Unit = {},
  ): CompletedAgentRun {
    val deadline = System.currentTimeMillis() + timeoutSeconds * 1000
    var recordId = runNameOrRecordId
    var fallbackArtifactKey: String? = null

    while (true) {
      val response =
        fetchAgentRun(recordId)
          ?: run {
            val record = findAgentRunRecord(runNameOrRecordId)
            recordId = record.id
            fallbackArtifactKey = extractArtifactKey(record.payload)
            fetchAgentRun(record.id)
          }
      val record = response?.agentRun
      val resource = response?.resource
      fallbackArtifactKey = fallbackArtifactKey ?: record?.payload?.let(::extractArtifactKey)
      val phase = resource?.status?.phase ?: record?.status
      when (phase) {
        "Succeeded" ->
          return CompletedAgentRun(
            phase = phase,
            finishedAt = resource?.status?.finishedAt,
            artifactReferences = resolveArtifactReferences(resource?.status, fallbackArtifactKey),
          )
        "Failed", "Error", "Cancelled" ->
          throw IllegalStateException("AgentRun $runNameOrRecordId failed with phase $phase")
      }

      if (System.currentTimeMillis() > deadline) {
        throw IllegalStateException("Timed out waiting for AgentRun $runNameOrRecordId to complete")
      }
      onPoll()
      delay(config.pollIntervalSeconds * 1000)
    }
  }

  private suspend fun fetchAgentRun(id: String): AgentRunReadResponse? {
    val namespace = URLEncoder.encode(config.namespace, StandardCharsets.UTF_8)
    val httpRequest = requestBuilder("/v1/agent-runs/$id?namespace=$namespace").GET().build()
    val response = httpClient.sendAsync(httpRequest, HttpResponse.BodyHandlers.ofString()).await()
    val body = response.body()
    if (response.statusCode() == 404) return null
    if (response.statusCode() !in 200..299) {
      throw IllegalStateException("Failed to fetch AgentRun $id status=${response.statusCode()} body=$body")
    }
    return json.decodeFromString(AgentRunReadResponse.serializer(), body)
  }

  private suspend fun findAgentRunRecord(runName: String): AgentRunRecordResponse {
    val query = "/v1/agent-runs?agentName=${urlEncode(config.agentName)}&limit=500"
    val httpRequest = requestBuilder(query).GET().build()
    val response = httpClient.sendAsync(httpRequest, HttpResponse.BodyHandlers.ofString()).await()
    val body = response.body()
    if (response.statusCode() !in 200..299) {
      throw IllegalStateException("Failed to list AgentRuns status=${response.statusCode()} body=$body")
    }
    val listResponse = json.decodeFromString(AgentRunListResponse.serializer(), body)
    return listResponse.runs.firstOrNull { record ->
      record.deliveryId == runName ||
        extractString(record.payload, "request", "idempotencyKey") == runName ||
        extractString(record.payload, "request", "parameters", "autoResearch.agentRun") == runName ||
        extractString(record.payload, "request", "parameters", "autoResearch.argoWorkflow") == runName
    } ?: throw IllegalStateException("AgentRun record not found for request $runName")
  }

  private fun requestBuilder(pathAndQuery: String): HttpRequest.Builder {
    val builder = HttpRequest.newBuilder().uri(URI.create("${config.baseUrl}$pathAndQuery"))
    authorizationHeader?.let { builder.header("Authorization", it) }
    return builder
  }

  internal fun resolveArtifactReferences(
    status: AgentRunStatus?,
    fallbackArtifactKey: String? = null,
  ): List<ArtifactReference> {
    val artifacts =
      status
        ?.artifacts
        ?.mapNotNull { artifact ->
          val key = artifact.key?.takeIf(String::isNotBlank) ?: return@mapNotNull null
          ArtifactReference(
            bucket = artifact.bucket?.takeIf(String::isNotBlank) ?: minioConfig.bucket,
            key = key,
            endpoint = artifact.endpoint?.takeIf(String::isNotBlank) ?: minioConfig.endpoint,
            region = artifact.region ?: minioConfig.region,
          )
        }?.takeIf { it.isNotEmpty() }
    if (artifacts != null) return artifacts

    return fallbackArtifactKey
      ?.takeIf(String::isNotBlank)
      ?.let {
        listOf(
          ArtifactReference(
            bucket = minioConfig.bucket,
            key = it,
            endpoint = minioConfig.endpoint,
            region = minioConfig.region,
          ),
        )
      } ?: emptyList()
  }
}

private fun urlEncode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8)

private fun extractArtifactKey(payload: JsonElement?): String? = extractString(payload, "request", "parameters", "artifactKey")

private fun extractString(
  payload: JsonElement?,
  vararg path: String,
): String? {
  var cursor = payload ?: return null
  for (segment in path) {
    cursor = cursor.jsonObject[segment] ?: return null
  }
  return cursor.jsonPrimitive.contentOrNull
}

@Serializable
internal data class AgentRunSubmitPayload(
  val agentRef: AgentRunRef,
  val namespace: String,
  val idempotencyKey: String,
  val implementation: AgentRunImplementation,
  val goal: AgentRunGoal,
  val runtime: AgentRunRuntime,
  val parameters: Map<String, String>,
  val secrets: List<String> = emptyList(),
  val policy: AgentRunPolicy? = null,
  val ttlSecondsAfterFinished: Long,
)

@Serializable
internal data class AgentRunRef(
  val name: String,
)

@Serializable
internal data class AgentRunImplementation(
  val text: String,
  val summary: String? = null,
)

@Serializable
internal data class AgentRunGoal(
  val objective: String,
)

@Serializable
internal data class AgentRunRuntime(
  val type: String,
  val config: Map<String, String>,
)

@Serializable
internal data class AgentRunPolicy(
  val secretBindingRef: String,
)

@Serializable
internal data class AgentRunSubmitResponse(
  val ok: Boolean = false,
  val agentRun: AgentRunRecordResponse? = null,
  val resource: AgentRunResource? = null,
  val idempotent: Boolean = false,
  val existingAgentRunName: String? = null,
)

@Serializable
internal data class AgentRunReadResponse(
  val ok: Boolean = false,
  val agentRun: AgentRunRecordResponse? = null,
  val resource: AgentRunResource? = null,
)

@Serializable
internal data class AgentRunListResponse(
  val ok: Boolean = false,
  val runs: List<AgentRunRecordResponse> = emptyList(),
)

@Serializable
internal data class AgentRunRecordResponse(
  val id: String,
  val agentName: String? = null,
  val deliveryId: String? = null,
  val status: String? = null,
  val externalRunId: String? = null,
  val payload: JsonElement? = null,
)

@Serializable
internal data class AgentRunResource(
  val metadata: AgentRunMetadata? = null,
  val status: AgentRunStatus? = null,
)

@Serializable
internal data class AgentRunMetadata(
  val name: String? = null,
)

@Serializable
internal data class AgentRunStatus(
  val phase: String? = null,
  val finishedAt: String? = null,
  val artifacts: List<AgentRunStatusArtifact> = emptyList(),
)

@Serializable
internal data class AgentRunStatusArtifact(
  val name: String? = null,
  val path: String? = null,
  val key: String? = null,
  val url: String? = null,
  val bucket: String? = null,
  val endpoint: String? = null,
  val region: String? = null,
)
