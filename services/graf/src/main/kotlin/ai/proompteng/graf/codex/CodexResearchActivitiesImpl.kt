package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.services.GraphPersistence
import io.temporal.activity.Activity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
      val artifact = parseCodexArtifact(payload)
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

  private fun parseCodexArtifact(payload: String): CodexArtifact {
    val trimmed = payload.trim()
    if (trimmed.isEmpty()) return CodexArtifact()
    try {
      return json.decodeFromString(CodexArtifact.serializer(), trimmed)
    } catch (ex: SerializationException) {
      val arrayArtifacts = parseArtifactArray(trimmed)
      if (arrayArtifacts != null) {
        return mergeArtifacts(arrayArtifacts)
      }
      val chunks = splitJsonObjects(trimmed)
      if (chunks.isNotEmpty()) {
        val artifacts =
          chunks.mapNotNull { chunk ->
            runCatching { json.decodeFromString(CodexArtifact.serializer(), chunk) }.getOrNull()
          }
        if (artifacts.isNotEmpty()) {
          return mergeArtifacts(artifacts)
        }
      }
      throw ex
    }
  }

  private fun parseArtifactArray(payload: String): List<CodexArtifact>? {
    val trimmed = payload.trim()
    if (!trimmed.startsWith("[")) return null
    return runCatching {
      json.decodeFromString(ListSerializer(CodexArtifact.serializer()), trimmed)
    }.getOrNull()
  }

  private fun mergeArtifacts(artifacts: List<CodexArtifact>): CodexArtifact {
    if (artifacts.size == 1) return artifacts.first()
    val mergedEntities = artifacts.flatMap { it.entities }
    val mergedRelationships = artifacts.flatMap { it.relationships }
    val mergedMetadata =
      artifacts.fold(mutableMapOf<String, JsonElement>()) { acc, artifact ->
        artifact.metadata.forEach { (key, value) -> acc[key] = value }
        acc
      }
    return CodexArtifact(
      entities = mergedEntities,
      relationships = mergedRelationships,
      metadata = mergedMetadata,
    )
  }

  private fun splitJsonObjects(payload: String): List<String> {
    val chunks = mutableListOf<String>()
    var depth = 0
    var inString = false
    var escape = false
    var startIndex = -1
    payload.forEachIndexed { index, ch ->
      if (inString) {
        if (escape) {
          escape = false
        } else {
          when (ch) {
            '\\' -> escape = true
            '"' -> inString = false
          }
        }
        return@forEachIndexed
      }
      when (ch) {
        '"' -> inString = true
        '{' -> {
          if (depth == 0) startIndex = index
          depth += 1
        }
        '}' -> {
          depth -= 1
          if (depth == 0 && startIndex >= 0) {
            chunks.add(payload.substring(startIndex, index + 1))
            startIndex = -1
          }
        }
      }
    }
    return chunks
  }

  private companion object {
    private const val CODEX_ARTIFACT_FILENAME = "codex-artifact.json"
  }
}
