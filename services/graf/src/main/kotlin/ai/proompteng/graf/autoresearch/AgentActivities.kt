package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoResearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import io.temporal.activity.ActivityInterface
import io.temporal.activity.ActivityMethod
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging

@ActivityInterface
interface AgentActivities {
  @ActivityMethod
  fun generatePlan(intent: AutoResearchPlanIntent): GraphRelationshipPlan
}

class AgentActivitiesImpl(
  private val agentService: AutoResearchAgentService,
) : AgentActivities {
  private val logger = KotlinLogging.logger {}

  override fun generatePlan(intent: AutoResearchPlanIntent): GraphRelationshipPlan =
    runBlocking {
      val start = System.currentTimeMillis()
      val sampleLimit = intent.sampleLimit ?: agentService.defaultSampleLimit()
      val metadataKeys = if (intent.metadata.isEmpty()) "none" else intent.metadata.keys.joinToString()
      logger.info {
        "AgentActivities dispatch objective='${intent.objective}' streamId=${intent.streamId ?: "none"} " +
          "sampleLimit=$sampleLimit metadataKeys=$metadataKeys"
      }
      val plan = agentService.generatePlan(intent)
      val durationMs = System.currentTimeMillis() - start
      logger.info {
        "AgentActivities completed objective='${intent.objective}' relationships=${plan.candidateRelationships.size} " +
          "prompts=${plan.prioritizedPrompts.size} durationMs=$durationMs"
      }
      plan
    }
}
