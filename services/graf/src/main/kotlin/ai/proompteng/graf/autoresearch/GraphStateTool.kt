package ai.proompteng.graf.autoresearch

import ai.koog.agents.core.tools.SimpleTool
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

class GraphStateTool(
  private val snapshotProvider: GraphSnapshotProvider,
  private val json: Json,
  private val defaultLimit: Int,
) : SimpleTool<GraphContextQuery>() {
  override val argsSerializer = GraphContextQuery.serializer()
  override val name: String = "graph_state_tool"
  override val description: String =
    "Inspect the NVIDIA Graf Neo4j knowledge graph. Provide a focus keyword, nodeId, or relationshipId to sample the latest state."

  override suspend fun doExecute(args: GraphContextQuery): String {
    val safeArgs =
      args.copy(
        limit = args.limit?.takeIf { it > 0 } ?: defaultLimit,
      )
    val report = snapshotProvider.fetch(safeArgs)
    return json.encodeToString(GraphSnapshotReport.serializer(), report)
  }
}
