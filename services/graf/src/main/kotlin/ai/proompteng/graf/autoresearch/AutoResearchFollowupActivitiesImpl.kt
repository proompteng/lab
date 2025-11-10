package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchLauncher
import ai.proompteng.graf.model.CodexResearchRequest
import mu.KotlinLogging

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
          val suffix = deterministicSuffix(outcome.workflowId, index)
          val codexWorkflowId = "graf-codex-research-$suffix"
          val argoWorkflowName = "codex-research-$suffix"
          val artifactKey = "codex-research/$argoWorkflowName/codex-artifact.json"
          val metadata = buildMetadata(outcome, index, prompt, codexWorkflowId)
          val launch =
            codexResearchLauncher.startResearch(
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
    codexWorkflowId: String,
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
      put("codex.workflowId", codexWorkflowId)
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

  private fun deterministicSuffix(
    workflowId: String,
    promptIndex: Int,
  ): String {
    val normalized =
      workflowId
        .lowercase()
        .replace("[^a-z0-9-]".toRegex(), "-")
        .replace("-+".toRegex(), "-")
        .trim('-')
    val safe = if (normalized.isBlank()) "auto-research" else normalized
    return "$safe-$promptIndex"
  }
}
