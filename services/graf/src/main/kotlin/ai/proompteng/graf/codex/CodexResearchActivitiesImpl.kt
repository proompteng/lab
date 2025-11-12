package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.services.GraphPersistence
import io.temporal.activity.Activity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.io.BufferedInputStream
import java.io.InputStream
import java.util.zip.GZIPInputStream

class CodexResearchActivitiesImpl(
  private val argoClient: ArgoWorkflowClient,
  private val graphPersistence: GraphPersistence,
  private val artifactFetcher: MinioArtifactFetcher,
  private val json: Json,
) : CodexResearchActivities {
  override fun submitArgoWorkflow(request: SubmitArgoWorkflowRequest): SubmitArgoWorkflowResult =
    runBlocking { argoClient.submitWorkflow(request) }

  override fun waitForArgoWorkflow(
    workflowName: String,
    timeoutSeconds: Long,
  ): CompletedArgoWorkflow =
    runBlocking {
      val context = Activity.getExecutionContext()
      argoClient.waitForCompletion(workflowName, timeoutSeconds) {
        context.heartbeat("waiting for argo workflow $workflowName")
      }
    }

  override fun downloadArtifact(reference: ArtifactReference): String =
    runBlocking {
      artifactFetcher.open(reference).use { stream ->
        stream.readArtifactPayload()
      }
    }

  override fun persistCodexArtifact(
    payload: String,
    input: CodexResearchWorkflowInput,
  ) {
    runBlocking {
      val artifact = json.decodeFromString(CodexArtifact.serializer(), payload)
      if (artifact.entities.isNotEmpty()) {
        graphPersistence.upsertEntities(EntityBatchRequest(artifact.entities))
      }
      if (artifact.relationships.isNotEmpty()) {
        graphPersistence.upsertRelationships(RelationshipBatchRequest(artifact.relationships))
      }
    }
  }

  private fun InputStream.readArtifactPayload(): String {
    val buffered = BufferedInputStream(this)
    buffered.mark(GZIP_HEADER_BYTES)
    val first = buffered.read()
    val second = buffered.read()
    buffered.reset()
    val payloadStream =
      if (isGzip(first, second)) {
        GZIPInputStream(buffered)
      } else {
        buffered
      }
    return payloadStream.bufferedReader().use { it.readText() }
  }

  private fun isGzip(firstByte: Int, secondByte: Int): Boolean {
    if (firstByte == -1 || secondByte == -1) return false
    val firstMarker = GZIPInputStream.GZIP_MAGIC and 0xFF
    val secondMarker = (GZIPInputStream.GZIP_MAGIC shr 8) and 0xFF
    return firstByte == firstMarker && secondByte == secondMarker
  }

  private companion object {
    private const val GZIP_HEADER_BYTES = 2
  }
}
