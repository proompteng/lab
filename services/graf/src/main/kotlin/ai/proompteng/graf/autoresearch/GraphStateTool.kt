package ai.proompteng.graf.autoresearch

import ai.koog.agents.core.tools.SimpleTool
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import mu.KotlinLogging

class GraphStateTool(
  private val snapshotProvider: GraphSnapshotProvider,
  private val json: Json,
  private val defaultLimit: Int,
) : SimpleTool<GraphContextQuery>() {
  private val logger = KotlinLogging.logger {}
  override val argsSerializer = GraphContextQuery.serializer()
  override val name: String = "graph_state_tool"
  override val description: String =
    "Inspect the NVIDIA Graf Neo4j knowledge graph. Provide a focus keyword, nodeId, or relationshipId to sample the latest state."

  override suspend fun doExecute(args: GraphContextQuery): String {
    val safeArgs =
      args.copy(
        limit = args.limit?.takeIf { it > 0 } ?: defaultLimit,
      )
    val start = System.currentTimeMillis()
    logger.info {
      "graph_state_tool invoked focus='${safeArgs.focus}' nodeId=${safeArgs.nodeId ?: "none"} " +
        "relationshipId=${safeArgs.relationshipId ?: "none"} limit=${safeArgs.limit}"
    }
    val report = snapshotProvider.fetch(safeArgs)
    val durationMs = System.currentTimeMillis() - start
    logger.info {
      "graph_state_tool completed focus='${safeArgs.focus}' sampledNodes=${report.sampledNodes.size} " +
        "sampledRelationships=${report.sampledRelationships.size} durationMs=$durationMs"
    }
    return json.encodeToString(GraphSnapshotReport.serializer(), report)
  }
}
