package ai.proompteng.graf.autoresearch

data class AutoResearchConfig(
  val knowledgeBaseName: String,
  val stage: String,
  val streamId: String,
  val defaultOperatorGuidance: String,
  val defaultGoalsText: String,
) {
  val workflowNamePrefix: String
    get() = sanitizeWorkflowPrefix(stage)

  companion object {
    const val DEFAULT_KNOWLEDGE_BASE_NAME = "Graf AutoResearch Knowledge Base"
    const val DEFAULT_STAGE = "auto-research"
    const val DEFAULT_STREAM_ID = "auto-research"
    const val DEFAULT_OPERATOR_GUIDANCE =
      "Continue expanding the Graf knowledge graph with the highest-signal suppliers, fabs, customers, partners, investors, and regulators whose announcements affect the target knowledge base over the next 12 months."
    private const val DEFAULT_GOALS_PAYLOAD =
      "1. Publish at least ten high-confidence updates or stop only when no credible leads remain.\n" +
        "2. Focus on developments announced within the past nine months that materially affect " +
        "the knowledge base's resilience, customer landscape, or dependencies.\n" +
        "3. Persist facts only when backed by two independent, credible sources; " +
        "otherwise record them in followUpGaps."
    const val DEFAULT_GOALS_TEXT = DEFAULT_GOALS_PAYLOAD

    fun fromEnvironment(): AutoResearchConfig = fromEnvMap(System.getenv())

    internal fun fromEnvMap(env: Map<String, String?>): AutoResearchConfig {
      val knowledgeBaseName =
        env["AUTO_RESEARCH_KB_NAME"]
          .orEmpty()
          .trim()
          .takeIf(String::isNotEmpty)
          ?: DEFAULT_KNOWLEDGE_BASE_NAME
      val stage =
        env["AUTO_RESEARCH_STAGE"].orEmpty().trim().takeIf(String::isNotEmpty) ?: DEFAULT_STAGE
      val streamId =
        env["AUTO_RESEARCH_STREAM_ID"].orEmpty().trim().takeIf(String::isNotEmpty) ?: DEFAULT_STREAM_ID
      val operatorGuidance =
        env["AUTO_RESEARCH_OPERATOR_GUIDANCE"]
          .orEmpty()
          .trim()
          .takeIf(String::isNotEmpty)
          ?: DEFAULT_OPERATOR_GUIDANCE
      val defaultGoals =
        env["AUTO_RESEARCH_DEFAULT_GOALS"]
          .orEmpty()
          .trim()
          .takeIf(String::isNotEmpty)
          ?: DEFAULT_GOALS_TEXT
      return AutoResearchConfig(knowledgeBaseName, stage, streamId, operatorGuidance, defaultGoals)
    }

    private fun sanitizeWorkflowPrefix(rawStage: String): String {
      val normalized = rawStage.trim().lowercase()
      val cleaned =
        normalized
          .replace(Regex("[^a-z0-9-]"), "-")
          .replace(Regex("-+"), "-")
          .trim('-')
      val truncated = cleaned.take(DNS_SUBDOMAIN_MAX_LENGTH).trim('-')
      return truncated.takeIf(String::isNotBlank) ?: DEFAULT_STAGE
    }

    private const val DNS_SUBDOMAIN_MAX_LENGTH = 63
  }
}
