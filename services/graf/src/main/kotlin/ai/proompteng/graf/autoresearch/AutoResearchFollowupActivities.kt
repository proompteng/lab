package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.AutoResearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import io.temporal.activity.ActivityInterface
import io.temporal.activity.ActivityMethod

@ActivityInterface
interface AutoResearchFollowupActivities {
  @ActivityMethod
  fun handlePlanOutcome(outcome: AutoResearchPlanOutcome): AutoResearchFollowupResult
}

data class AutoResearchPlanOutcome(
  val workflowId: String,
  val runId: String,
  val intent: AutoResearchPlanIntent,
  val plan: GraphRelationshipPlan,
)

data class AutoResearchFollowupResult(
  val researchLaunches: List<ResearchLaunch>,
) {
  data class ResearchLaunch(
    val prompt: String,
    val codexWorkflowId: String,
    val codexRunId: String,
    val argoWorkflowName: String,
    val artifactKey: String,
  )
}
