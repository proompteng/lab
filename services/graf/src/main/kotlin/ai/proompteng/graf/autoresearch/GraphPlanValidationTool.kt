package ai.proompteng.graf.autoresearch

import ai.koog.agents.core.tools.SimpleTool
import ai.proompteng.graf.model.GraphRelationshipPlan
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import mu.KotlinLogging

class GraphPlanValidationTool(
  private val json: Json,
) : SimpleTool<GraphPlanValidationTool.Args>() {
  private val logger = KotlinLogging.logger {}
  override val argsSerializer = Args.serializer()
  override val name: String = "graph_plan_validator"
  override val description: String =
    "Validate that a GraphRelationshipPlan JSON payload matches the required schema before presenting your final answer."

  override suspend fun doExecute(args: Args): String {
    logger.info { "graph_plan_validator invoked" }
    val plan =
      runCatching {
        json.decodeFromString(GraphRelationshipPlan.serializer(), args.planJson)
      }.getOrElse { failure ->
        logger.warn(failure) { "graph_plan_validator failed" }
        throw IllegalArgumentException("Plan JSON is invalid: ${failure.message}", failure)
      }
    val normalized = json.encodeToString(GraphRelationshipPlan.serializer(), plan)
    logger.info { "graph_plan_validator succeeded" }
    return normalized
  }

  @Serializable
  data class Args(
    val planJson: String,
  )
}
