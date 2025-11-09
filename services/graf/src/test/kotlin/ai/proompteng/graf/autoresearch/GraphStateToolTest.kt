package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.autoresearch.GraphRelationshipSummary
import ai.proompteng.graf.autoresearch.GraphSnapshotReport
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class GraphStateToolTest {
  private val json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
      explicitNulls = false
    }

  @Test
  fun `tool uses default sample limit when not provided`() =
    runBlocking {
      val recorder = RecordingSnapshotProvider()
      val tool = GraphStateTool(recorder, json, defaultLimit = 25)

      val payload =
        tool.doExecute(
          GraphContextQuery(
            focus = "memory",
            limit = null,
          ),
        )

      assertEquals(25, recorder.lastQuery?.limit)
      val decoded = json.decodeFromString(GraphSnapshotReport.serializer(), payload)
      assertEquals("memory", decoded.focus)
    }

  private class RecordingSnapshotProvider : GraphSnapshotProvider {
    var lastQuery: GraphContextQuery? = null
      private set

    override suspend fun fetch(query: GraphContextQuery): GraphSnapshotReport {
      lastQuery = query
      return GraphSnapshotReport(
        focus = query.focus,
        sampleLimit = query.limit ?: 0,
        metrics = GraphMetrics(totalNodes = 0, totalRelationships = 0),
        sampledRelationships =
          listOf(
            GraphRelationshipSummary(
              id = "rel-1",
              type = "SUPPLIES",
              fromId = "a",
              toId = "b",
            ),
          ),
      )
    }
  }
}
