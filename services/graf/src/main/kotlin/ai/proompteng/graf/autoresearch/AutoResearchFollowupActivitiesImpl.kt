package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchLauncher
import ai.proompteng.graf.model.CodexResearchRequest
import mu.KotlinLogging
import java.util.UUID

class AutoResearchFollowupActivitiesImpl(
  private val codexResearchLauncher: CodexResearchLauncher,
) : AutoResearchFollowupActivities {
  private val logger = KotlinLogging.logger {}

  override fun handlePlanOutcome(outcome: AutoResearchPlanOutcome): AutoResearchFollowupResult {
    logger.info {
      "AutoResearch plan completed workflowId=${outcome.workflowId} runId=${outcome.runId} " +
        "summary='${outcome.plan.summary}' prioritizedPrompts=${outcome.plan.prioritizedPrompts.size}"
    }
    val launches =
      outcome.plan.prioritizedPrompts.mapIndexedNotNull { index, rawPrompt ->
        val prompt = rawPrompt.trim()
        if (prompt.isBlank()) {
          logger.warn {
            "Skipping empty prioritized prompt index=$index workflowId=${outcome.workflowId}"
          }
          null
        } else {
          val metadata = buildMetadata(outcome, index, prompt)
          val argoWorkflowName = "codex-research-" + UUID.randomUUID().toString()
          val artifactKey = "codex-research/$argoWorkflowName/codex-artifact.json"
          val launch = codexResearchLauncher.startResearch(
            CodexResearchRequest(prompt = prompt, metadata = metadata),
            argoWorkflowName,
            artifactKey,
          )
          logLaunch(outcome, prompt, index, launch, argoWorkflowName, artifactKey)
          AutoResearchFollowupResult.ResearchLaunch(
            prompt = prompt,
            codexWorkflowId = launch.workflowId,
            codexRunId = launch.runId,
            argoWorkflowName = argoWorkflowName,
            artifactKey = artifactKey,
          )
        }
      }
    logger.info {
      "Scheduled ${launches.size} Codex research jobs for workflowId=${outcome.workflowId}"
    }
    return AutoResearchFollowupResult(launches)
  }

  private fun buildMetadata(
    outcome: AutoResearchPlanOutcome,
    promptIndex: Int,
    prompt: String,
  ): Map<String, String> =
    buildMap {
      putAll(outcome.intent.metadata)
      put("autoResearch.workflowId", outcome.workflowId)
      put("autoResearch.runId", outcome.runId)
      put("autoResearch.promptIndex", promptIndex.toString())
      put("autoResearch.promptHash", prompt.hashCode().toString())
      put("objective", outcome.intent.objective)
      outcome.intent.streamId?.let { put("streamId", it) }
      put("plan.summary", outcome.plan.summary.take(200))
    }

  private fun logLaunch(
    outcome: AutoResearchPlanOutcome,
    prompt: String,
    promptIndex: Int,
    launch: CodexResearchLaunchResult,
    argoWorkflowName: String,
    artifactKey: String,
  ) {
    logger.info {
      "Launched Codex research promptIndex=$promptIndex workflowId=${outcome.workflowId} " +
        "codexWorkflowId=${launch.workflowId} argoWorkflow=$argoWorkflowName artifactKey=$artifactKey prompt='${prompt.take(120)}'"
    }
  }
}
