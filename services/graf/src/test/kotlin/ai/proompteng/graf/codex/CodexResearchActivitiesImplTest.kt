package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.model.BatchResponse
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.GraphResponse
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.services.GraphPersistence
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class CodexResearchActivitiesImplTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun activities(
    argo: ArgoWorkflowClient = mockk(),
    persistence: GraphPersistence = mockk(),
    fetcher: MinioArtifactFetcher = mockk(),
  ) =
    CodexResearchActivitiesImpl(argo, persistence, fetcher, json)

  @Test
  fun `downloadArtifact returns streamed content`() = runBlocking {
    val fetcher = mockk<MinioArtifactFetcher>()
    val reference = ArtifactReference("bucket", "key", "endpoint")
    every { fetcher.open(reference) } returns "payload".byteInputStream()

    val activities = activities(fetcher = fetcher)
    val content = activities.downloadArtifact(reference)
    assertEquals("payload", content)
  }

  @Test
  fun `persistCodexArtifact throws when payload is malformed`() {
    val activities = activities()
    val input = CodexResearchWorkflowInput(
      prompt = "test",
      metadata = emptyMap(),
      argoWorkflowName = "workflow",
      artifactKey = "artifact-key",
      argoPollTimeoutSeconds = 10,
    )

    assertFailsWith<SerializationException> { activities.persistCodexArtifact("not json", input) }
  }

  @Test
  fun `persistCodexArtifact upserts entities and relationships`() {
    val persistence = mockk<GraphPersistence>()
    val entitySlot = slot<EntityBatchRequest>()
    val relationshipSlot = slot<RelationshipBatchRequest>()
    coEvery { persistence.upsertEntities(capture(entitySlot)) } returns BatchResponse(emptyList())
    coEvery { persistence.upsertRelationships(capture(relationshipSlot)) } returns BatchResponse(emptyList())

    val activities = activities(persistence = persistence)
    val payload =
      """
        {
          "entities": [
            {
              "id": "entity-1",
              "label": "Company",
              "properties": {},
              "artifactId": "artifact",
              "streamId": "test-stream"
            }
          ],
          "relationships": [
            {
              "id": "rel-1",
              "type": "PARTNERS_WITH",
              "fromId": "entity-1",
              "toId": "entity-2",
              "properties": {},
              "artifactId": "artifact",
              "streamId": "test-stream"
            }
          ]
        }
      """.trimIndent()

    val input = CodexResearchWorkflowInput(
      prompt = "test",
      metadata = emptyMap(),
      argoWorkflowName = "workflow",
      artifactKey = "artifact-key",
      argoPollTimeoutSeconds = 10,
    )

    activities.persistCodexArtifact(payload, input)

    coVerify(exactly = 1) { persistence.upsertEntities(any()) }
    coVerify(exactly = 1) { persistence.upsertRelationships(any()) }
    assertEquals("entity-1", entitySlot.captured.entities.first().id)
    assertEquals("PARTNERS_WITH", relationshipSlot.captured.relationships.first().type)
  }
}
