package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.config.AutoResearchConfig
import ai.proompteng.graf.model.AutoResearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import kotlinx.serialization.json.Json

class AutoResearchPromptBuilder(
  private val config: AutoResearchConfig,
  private val json: Json,
) {
  fun build(intent: AutoResearchPlanIntent): String {
    val sampleLimit = intent.sampleLimit ?: config.graphSampleLimit
    val focusLine =
      intent.focus?.takeIf { it.isNotBlank() }?.let { "Primary focus or entity: $it" }
        ?: "Focus on the highest-value relationship gaps."
    val streamHint =
      intent.streamId?.let { "Research stream: $it" }
        ?: "Research stream: ${config.defaultStreamId} (configured default)."
    val metadataLines = buildMetadataLines(intent)
    val schemaSample = buildSchemaSample(intent)
    return buildString {
      appendLine("You are the ${config.knowledgeBaseName} relationship planner (stage ${config.knowledgeBaseStage}).")
      appendLine("Objective: ${intent.objective}")
      appendLine("Operator guidance: ${config.operatorGuidance}")
      appendLine(focusLine)
      appendLine(streamHint)
      appendLine("Default graph sample limit: $sampleLimit")
      appendLine("Metadata:")
      metadataLines.forEach { appendLine(it) }
      appendLine()
      appendLine("Return ONLY valid JSON that matches the GraphRelationshipPlan schema shown below:")
      appendLine(schemaSample)
      appendLine()
      appendLine(
        "Use the graph_state_tool before proposing relationships so you know which entities already exist. Pass limit=$sampleLimit unless you need a smaller window.",
      )
      appendLine(
        "Surface 3-5 prioritized prompts that downstream Codex runs can execute to validate or expand the relationships.",
      )
    }
  }

  private fun buildMetadataLines(intent: AutoResearchPlanIntent): List<String> {
    val lines = mutableListOf(
      "- knowledgeBase: ${config.knowledgeBaseName}",
      "- stage: ${config.knowledgeBaseStage}",
      "- defaultStreamId: ${config.defaultStreamId}",
    )
    if (intent.metadata.isEmpty()) {
      lines += "- (Callers may attach metadata via the plan request.)"
    } else {
      lines += "- Additional request metadata:"
      lines += intent.metadata.entries.map { (key, value) -> "  - $key: $value" }
    }
    return lines
  }

  private fun buildSchemaSample(intent: AutoResearchPlanIntent): String {
    val schemaSample =
      GraphRelationshipPlan(
        objective = intent.objective,
        summary = "Outline the relationship-building priority that keeps the knowledge base healthy and current.",
        currentSignals =
          listOf("Two foundational partners are missing documented certifications for upstream tooling."),
        candidateRelationships =
          listOf(
            GraphRelationshipPlan.CandidateRelationship(
              fromId = "organization:aurora-analytics",
              toId = "platform:atlas-insights",
              relationshipType = "ENRICHES",
              rationale =
                "Aurora telemetry coverage closes the visibility gap for sensor firmware updates in Atlas Insights.",
              confidence = "medium",
              requiredEvidence = listOf("Signed data-sharing agreement"),
              suggestedArtifacts = listOf("temporal://streams/aurora/2025-11-09"),
            ),
          ),
        prioritizedPrompts =
          listOf("Summarize the November incidents for Aurora Analytics and describe the follow-up actions needed."),
        missingData = listOf("Need proof of Atlas Insights certification for robotics workloads."),
        recommendedTools = listOf("graph_state_tool", "codex:search"),
      )
    return json.encodeToString(schemaSample)
  }
}

