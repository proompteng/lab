package ai.proompteng.graf.config

import kotlin.math.max

data class AutoResearchConfig(
  val enabled: Boolean,
  val openAiApiKey: String?,
  val openAiBaseUrl: String?,
  val model: String,
  val maxIterations: Int,
  val graphSampleLimit: Int,
  val traceLoggingEnabled: Boolean,
  val traceLogLevel: String,
) {
  val isReady: Boolean
    get() = enabled && !openAiApiKey.isNullOrBlank()

  companion object {
    private const val DEFAULT_MODEL = "gpt-5"
    private const val DEFAULT_ITERATIONS = 16
    private const val DEFAULT_GRAPH_SAMPLE_LIMIT = 25
    private const val DEFAULT_TRACE_LOG_LEVEL = "INFO"

    fun fromEnvironment(): AutoResearchConfig = fromEnvironment(System.getenv())

    internal fun fromEnvironment(env: Map<String, String>): AutoResearchConfig {
      val enabled = env["AGENT_ENABLED"]?.let { it.equals("true", ignoreCase = true) || it == "1" } ?: true
      val apiKey =
        env["AGENT_OPENAI_API_KEY"]?.takeIf { it.isNotBlank() }
          ?: env["OPENAI_API_KEY"]?.takeIf { it.isNotBlank() }
      val baseUrl =
        env["AGENT_OPENAI_BASE_URL"]?.takeIf { it.isNotBlank() }
          ?: env["OPENAI_API_BASE_URL"]?.takeIf { it.isNotBlank() }
      val model = env["AGENT_MODEL"]?.takeIf { it.isNotBlank() } ?: DEFAULT_MODEL
      val iterations =
        env["AGENT_MAX_ITERATIONS"]?.toIntOrNull()?.let { max(1, it) } ?: DEFAULT_ITERATIONS
      val graphSampleLimit =
        env["AGENT_GRAPH_SAMPLE_LIMIT"]?.toIntOrNull()?.let { max(1, it) } ?: DEFAULT_GRAPH_SAMPLE_LIMIT
      val traceLoggingEnabled =
        env["AGENT_TRACE_LOGGING"]?.let { it.equals("true", ignoreCase = true) || it == "1" } ?: true
      val traceLogLevel = env["AGENT_TRACE_LOG_LEVEL"]?.takeIf { it.isNotBlank() } ?: DEFAULT_TRACE_LOG_LEVEL
      return AutoResearchConfig(
        enabled = enabled,
        openAiApiKey = apiKey,
        openAiBaseUrl = baseUrl,
        model = model,
        maxIterations = iterations,
        graphSampleLimit = graphSampleLimit,
        traceLoggingEnabled = traceLoggingEnabled,
        traceLogLevel = traceLogLevel,
      )
    }
  }
}
