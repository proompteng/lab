package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.services.GraphPersistence
import io.temporal.activity.Activity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.apache.commons.compress.archivers.ArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.zip.GZIPInputStream
import kotlin.io.copyTo
import kotlin.io.readBytes
import kotlin.text.Charsets

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
    val rawBytes = this.readBytes()
    val uncompressed = rawBytes.decompressIfNeeded()
    val payload = uncompressed.extractTarPayload() ?: uncompressed
    return payload.toString(Charsets.UTF_8)
  }

  private fun ByteArray.decompressIfNeeded(): ByteArray {
    if (!isGzip(this)) return this
    return GZIPInputStream(ByteArrayInputStream(this)).use { it.readBytes() }
  }

  private fun ByteArray.extractTarPayload(): ByteArray? =
    try {
      TarArchiveInputStream(ByteArrayInputStream(this)).use { tar ->
        var firstJsonEntry: ByteArray? = null
        var entry: ArchiveEntry? = tar.nextEntry
        while (entry != null) {
          if (!entry.isDirectory) {
            val entryBytes = tar.readCurrentEntryBytes()
            val entryName = entry.name.substringAfterLast('/')
            when {
              entryName == CODEX_ARTIFACT_FILENAME -> return entryBytes
              entryName.endsWith(".json") && firstJsonEntry == null -> firstJsonEntry = entryBytes
            }
          }
          entry = tar.nextEntry
        }
        firstJsonEntry
      }
    } catch (ex: Exception) {
      null
    }

  private fun isGzip(bytes: ByteArray): Boolean {
    if (bytes.size < 2) return false
    val firstMarker = GZIPInputStream.GZIP_MAGIC and 0xFF
    val secondMarker = (GZIPInputStream.GZIP_MAGIC shr 8) and 0xFF
    return (bytes[0].toInt() and 0xFF) == firstMarker && (bytes[1].toInt() and 0xFF) == secondMarker
  }

  private fun TarArchiveInputStream.readCurrentEntryBytes(): ByteArray {
    val buffer = ByteArrayOutputStream()
    this.copyTo(buffer)
    return buffer.toByteArray()
  }

  private companion object {
    private const val CODEX_ARTIFACT_FILENAME = "codex-artifact.json"
  }
}
