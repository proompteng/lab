package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoresearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import io.temporal.activity.ActivityInterface
import io.temporal.activity.ActivityMethod
import kotlinx.coroutines.runBlocking

@ActivityInterface
interface AgentActivities {
  @ActivityMethod
  fun generatePlan(intent: AutoresearchPlanIntent): GraphRelationshipPlan
}

class AgentActivitiesImpl(
  private val agentService: AutoresearchAgentService,
) : AgentActivities {
  override fun generatePlan(intent: AutoresearchPlanIntent): GraphRelationshipPlan = runBlocking { agentService.generatePlan(intent) }
}
