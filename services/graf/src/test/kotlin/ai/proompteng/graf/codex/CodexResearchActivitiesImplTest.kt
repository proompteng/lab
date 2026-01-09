package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.BatchResponse
import ai.proompteng.graf.services.GraphPersistence
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals

class CodexResearchActivitiesImplTest {
  private val graphPersistence = mockk<GraphPersistence>(relaxed = true)
  private val artifactFetcher = mockk<MinioArtifactFetcher>()
  private val activities =
    CodexResearchActivitiesImpl(
      argoClient = mockk(relaxed = true),
      graphPersistence = graphPersistence,
      artifactFetcher = artifactFetcher,
      json = Json { ignoreUnknownKeys = true },
    )

  @Test
  fun `downloadArtifact returns payload`() =
    runBlocking {
      val reference = ArtifactReference("bucket", "key", "https://minio", null)
      val payload = """{"data":"value"}"""
      val stream = ByteArrayInputStream(payload.toByteArray())
      every { artifactFetcher.open(reference) } returns stream

      val result = activities.downloadArtifact(reference)

      assertEquals(payload, result)
      verify {
        artifactFetcher.open(reference)
      }
    }

  @Test
  fun `downloadArtifact inflates gzip payload`() =
    runBlocking {
      val reference = ArtifactReference("bucket", "key", "https://minio", null)
      val payload = """{"data":"value"}"""
      val zipped =
        ByteArrayOutputStream().use { baos ->
          GZIPOutputStream(baos).use { gzip ->
            gzip.write(payload.toByteArray())
          }
          baos.toByteArray()
        }
      every { artifactFetcher.open(reference) } returns ByteArrayInputStream(zipped)

      val result = activities.downloadArtifact(reference)

      assertEquals(payload, result)
      verify {
        artifactFetcher.open(reference)
      }
    }

  @Test
  fun `downloadArtifact extracts codex artifact from gzipped tar`() =
    runBlocking {
      val reference = ArtifactReference("bucket", "key", "https://minio", null)
      val payload = """{"data":"from-tar"}"""
      val tarBytes = tarArchive("codex-artifact.json" to payload)
      val gzipped = gzip(tarBytes)
      every { artifactFetcher.open(reference) } returns ByteArrayInputStream(gzipped)

      val result = activities.downloadArtifact(reference)

      assertEquals(payload, result)
      verify {
        artifactFetcher.open(reference)
      }
    }

  @Test
  fun `downloadArtifact extracts first json file from tar archive`() =
    runBlocking {
      val reference = ArtifactReference("bucket", "key", "https://minio", null)
      val payload = """{"data":"fallback"}"""
      val tarBytes =
        tarArchive(
          "notes.txt" to "skip",
          "nested/results.json" to payload,
        )
      every { artifactFetcher.open(reference) } returns ByteArrayInputStream(tarBytes)

      val result = activities.downloadArtifact(reference)

      assertEquals(payload, result)
      verify {
        artifactFetcher.open(reference)
      }
    }

  @Test
  fun `persistCodexArtifact succeeds when artifact comes from tarball`() =
    runBlocking {
      val reference = ArtifactReference("bucket", "key", "https://minio", null)
      val payload = """{"entities":[{"label":"Node","properties":{"id":"node:tar"}}]}"""
      val tarBytes = tarArchive("codex-artifact.json" to payload)
      val gzipped = gzip(tarBytes)
      every { artifactFetcher.open(reference) } returns ByteArrayInputStream(gzipped)
      coEvery { graphPersistence.upsertEntities(any()) } returns BatchResponse(emptyList())

      val artifactJson = activities.downloadArtifact(reference)
      activities.persistCodexArtifact(
        artifactJson,
        CodexResearchWorkflowInput(
          prompt = "prompt",
          metadata = emptyMap(),
          argoWorkflowName = "name",
          artifactKey = "key",
          argoPollTimeoutSeconds = 7200,
        ),
      )

      coVerify {
        graphPersistence.upsertEntities(
          match { request ->
            request.entities
              .single()
              .properties["id"]
              ?.jsonPrimitive
              ?.content == "node:tar"
          },
        )
      }
    }

  @Test
  fun `persistCodexArtifact writes entities and relationships`() =
    runBlocking {
      val payload = """{
            "entities": [
                {"label": "Node", "properties": {"id": "node:1"}}
            ],
            "relationships": [
                {"type": "LINKS", "fromId": "node:1", "toId": "node:2"}
            ]
        }"""
      coEvery { graphPersistence.upsertEntities(any()) } returns BatchResponse(emptyList())
      coEvery { graphPersistence.upsertRelationships(any()) } returns BatchResponse(emptyList())

      activities.persistCodexArtifact(
        payload,
        CodexResearchWorkflowInput(
          prompt = "prompt",
          metadata = emptyMap(),
          argoWorkflowName = "name",
          artifactKey = "key",
          argoPollTimeoutSeconds = 7200,
        ),
      )

      coVerify { graphPersistence.upsertEntities(match { it.entities.size == 1 }) }
      coVerify { graphPersistence.upsertRelationships(match { it.relationships.size == 1 }) }
    }

  @Test
  fun `persistCodexArtifact merges concatenated json objects`() =
    runBlocking {
      val payload =
        """{"entities":[{"label":"Node","properties":{"id":"node:1"}}]}
           {"relationships":[{"type":"LINKS","fromId":"node:1","toId":"node:2"}]}"""
      coEvery { graphPersistence.upsertEntities(any()) } returns BatchResponse(emptyList())
      coEvery { graphPersistence.upsertRelationships(any()) } returns BatchResponse(emptyList())

      activities.persistCodexArtifact(
        payload,
        CodexResearchWorkflowInput(
          prompt = "prompt",
          metadata = emptyMap(),
          argoWorkflowName = "name",
          artifactKey = "key",
          argoPollTimeoutSeconds = 7200,
        ),
      )

      coVerify { graphPersistence.upsertEntities(match { it.entities.size == 1 }) }
      coVerify { graphPersistence.upsertRelationships(match { it.relationships.size == 1 }) }
    }

  private fun tarArchive(vararg files: Pair<String, String>): ByteArray {
    val tarBytes = ByteArrayOutputStream()
    TarArchiveOutputStream(tarBytes).use { tar ->
      files.forEach { (name, content) ->
        val bytes = content.toByteArray()
        val entry = TarArchiveEntry(name)
        entry.size = bytes.size.toLong()
        tar.putArchiveEntry(entry)
        tar.write(bytes)
        tar.closeArchiveEntry()
      }
      tar.finish()
    }
    return tarBytes.toByteArray()
  }

  private fun gzip(data: ByteArray): ByteArray {
    val zipped = ByteArrayOutputStream()
    GZIPOutputStream(zipped).use { gzip ->
      gzip.write(data)
    }
    return zipped.toByteArray()
  }
}
