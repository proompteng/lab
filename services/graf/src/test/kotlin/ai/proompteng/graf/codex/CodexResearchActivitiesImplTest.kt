package ai.proompteng.graf.codex

import ai.proompteng.graf.codex.PromptCatalogDefinition
import ai.proompteng.graf.codex.PromptCitations
import ai.proompteng.graf.codex.PromptEntityExpectation
import ai.proompteng.graf.codex.PromptExpectedArtifact
import ai.proompteng.graf.codex.PromptInputSpec
import ai.proompteng.graf.codex.PromptRelationshipExpectation
import ai.proompteng.graf.codex.PromptScoring
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

  private fun catalogDefinition() =
    PromptCatalogDefinition(
      promptId = "foundries",
      streamId = "foundries",
      objective = "record foundries",
      schemaVersion = 1,
      prompt = "prompt",
      inputs = listOf(PromptInputSpec(name = "window", description = "desc", required = true)),
      expectedArtifact =
        PromptExpectedArtifact(
          entities = listOf(PromptEntityExpectation(label = "Company", description = "desc")),
          relationships =
            listOf(
              PromptRelationshipExpectation(
                type = "LINKS",
                description = "desc",
                fromLabel = "Company",
                toLabel = "Company",
              ),
            ),
        ),
      citations = PromptCitations(required = listOf("sourceUrl"), preferredSources = listOf("nvidia.com")),
      scoringHeuristics = listOf(PromptScoring(metric = "confidence", target = ">=0.7")),
      metadata = mapOf("researchSource" to "graf-codex-foundries", "artifactIdPrefix" to "codex:foundries"),
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
  fun `persistCodexArtifact enriches metadata`() =
    runBlocking {
      val payload = """{
            "entities": [
                {"label": "Node", "properties": {"id": "node:1"}}
            ],
            "relationships": [
                {"type": "LINKS", "fromId": "node:1", "toId": "node:2"}
            ],
            "metadata": {
                "artifactId": "artifact-1",
                "researchSource": "graf-codex-foundries",
                "streamId": "foundries"
            }
        }"""
      coEvery { graphPersistence.upsertEntities(any()) } returns BatchResponse(emptyList())
      coEvery { graphPersistence.upsertRelationships(any()) } returns BatchResponse(emptyList())

      activities.persistCodexArtifact(
        payload,
        CodexResearchWorkflowInput(
          prompt = "prompt",
          metadata = emptyMap(),
          catalogMetadata = catalogDefinition(),
          argoWorkflowName = "name",
          artifactKey = "key",
          argoPollTimeoutSeconds = 7200,
        ),
      )

      coVerify {
        graphPersistence.upsertEntities(match { record ->
          record.entities.all {
            it.artifactId == "artifact-1" && it.researchSource == "graf-codex-foundries" && it.streamId == "foundries"
          }
        })
      }
      coVerify {
        graphPersistence.upsertRelationships(match { record ->
          record.relationships.all {
            it.artifactId == "artifact-1" && it.researchSource == "graf-codex-foundries" && it.streamId == "foundries"
          }
        })
      }
    }
}
