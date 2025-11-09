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
import java.io.ByteArrayInputStream
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
}
