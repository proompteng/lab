package ai.proompteng.graf.autoresearch

import ai.koog.agents.core.agent.AIAgentService
import ai.koog.agents.core.agent.GraphAIAgent
import ai.koog.agents.core.agent.config.AIAgentConfig
import ai.koog.agents.core.feature.writer.FeatureMessageLogWriter
import ai.koog.agents.core.tools.ToolRegistry
import ai.koog.agents.ext.agent.reActStrategy
import ai.koog.agents.features.tracing.feature.Tracing
import ai.koog.agents.features.tracing.writer.TraceFeatureMessageLogWriter
import ai.koog.prompt.dsl.prompt
import ai.koog.prompt.executor.clients.LLMClient
import ai.koog.prompt.executor.clients.openai.OpenAIChatParams
import ai.koog.prompt.executor.clients.openai.OpenAIClientSettings
import ai.koog.prompt.executor.clients.openai.OpenAILLMClient
import ai.koog.prompt.executor.clients.openai.OpenAIModels
import ai.koog.prompt.executor.clients.openai.base.models.ReasoningEffort
import ai.koog.prompt.executor.llms.SingleLLMPromptExecutor
import ai.koog.prompt.llm.LLMProvider
import ai.koog.prompt.llm.LLModel
import ai.koog.prompt.params.LLMParams
import ai.proompteng.graf.config.AutoResearchConfig
import ai.proompteng.graf.model.AutoResearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import java.io.Closeable
import java.lang.AutoCloseable
import io.github.oshai.kotlinlogging.KotlinLogging as OshaiKotlinLogging

class AutoResearchAgentService(
  private val config: AutoResearchConfig,
  snapshotProvider: GraphSnapshotProvider,
  private val json: Json,
) : Closeable {
  private val llmClient: LLMClient
  private val promptExecutor: SingleLLMPromptExecutor
  private val agentService: AIAgentService<String, String, *>
  private val logger = KotlinLogging.logger {}
  private val traceLogger = OshaiKotlinLogging.logger("AutoResearchAgentTrace")

  private val llmModel: LLModel = resolveModel(config.model)

  init {
    require(config.isReady) { "AutoResearch agent requested but configuration is disabled or incomplete" }
    llmClient = buildLlmClient(config)
    promptExecutor = SingleLLMPromptExecutor(llmClient)
    val graphStateTool = GraphStateTool(snapshotProvider, json, config.graphSampleLimit)
    val planValidationTool = GraphPlanValidationTool(json)
    val promptParams = buildPromptParams()
    val basePrompt =
      prompt(
        id = "graf-auto-research-agent",
        params = promptParams,
      ) {
        system(SYSTEM_PROMPT)
      }
    val agentConfig =
      AIAgentConfig(
        prompt = basePrompt,
        model = llmModel,
        maxAgentIterations = config.maxIterations,
      )
    val traceFeatureInstaller: GraphAIAgent.FeatureContext.() -> Unit =
      if (config.traceLoggingEnabled) {
        val logLevel =
          resolveTraceLogLevel(config.traceLogLevel) { warning ->
            logger.warn { warning }
          }
        logger.info { "AutoResearch agent trace logging enabled level=$logLevel" }
        val installer: GraphAIAgent.FeatureContext.() -> Unit =
          {
            install(Tracing) {
              addMessageProcessor(
                TraceFeatureMessageLogWriter(
                  traceLogger,
                  logLevel = logLevel,
                ),
              )
            }
          }
        installer
      } else {
        logger.debug { "AutoResearch agent trace logging disabled" }
        val noop: GraphAIAgent.FeatureContext.() -> Unit = {}
        noop
      }

    agentService =
      AIAgentService(
        promptExecutor,
        agentConfig,
        reActStrategy(),
        ToolRegistry {
          tool(graphStateTool)
          tool(planValidationTool)
        },
        traceFeatureInstaller,
      )
  }

  suspend fun generatePlan(intent: AutoResearchPlanIntent): GraphRelationshipPlan {
    val sampleLimit = intent.sampleLimit ?: config.graphSampleLimit
    val metadataKeys = if (intent.metadata.isEmpty()) "none" else intent.metadata.keys.joinToString()
    logger.info {
      "AutoResearch agent generating plan objective='${intent.objective}' streamId=${intent.streamId ?: "none"} " +
        "sampleLimit=$sampleLimit metadataKeys=$metadataKeys"
    }
    val input = buildAgentInput(intent)
    val raw = agentService.createAgentAndRun(input)
    val payload = extractJson(raw)
    val plan =
      runCatching { json.decodeFromString(GraphRelationshipPlan.serializer(), payload) }
        .getOrElse { failure ->
          logger.error(failure) { "AutoResearch agent returned invalid plan objective='${intent.objective}'" }
          throw IllegalStateException("AutoResearch agent returned unparsable plan: ${failure.message}", failure)
        }
    return plan.copy(
      objective = plan.objective.ifBlank { intent.objective },
    )
  }

  fun defaultSampleLimit(): Int = config.graphSampleLimit

  override fun close() {
    (llmClient as? AutoCloseable)?.close()
  }

  private fun buildAgentInput(intent: AutoResearchPlanIntent): String {
    val metadataBlock =
      if (intent.metadata.isEmpty()) {
        "No metadata was provided."
      } else {
        intent.metadata.entries.joinToString(separator = "\n") { (key, value) -> "- $key: $value" }
      }
    val focusLine =
      intent.focus?.takeIf { it.isNotBlank() }?.let { "Primary focus or entity: $it" }
        ?: "Focus on the highest-value relationship gaps."
    val streamHint =
      intent.streamId?.let { "Research stream: $it" } ?: "No explicit stream assigned."
    val schemaSample =
      json.encodeToString(
        GraphRelationshipPlan(
          objective = intent.objective,
          summary = "Outline the relationship-building priority for NVIDIA supply tiers.",
          currentSignals = listOf("Only one certified HBM3 supplier captured."),
          candidateRelationships =
            listOf(
              GraphRelationshipPlan.CandidateRelationship(
                fromId = "company:hynix",
                toId = "facility:cheongju-fab",
                relationshipType = "SUPPLIES",
                rationale = "HBM3 capacity expansion announced in Sep 2025.",
                confidence = "high",
                requiredEvidence = listOf("Link to official capacity announcement"),
                suggestedArtifacts = listOf("temporal://streams/hbm3"),
              ),
            ),
          prioritizedPrompts = listOf("Gather 2025 wafer capacity disclosures for Tier-2 OSAT partners."),
          missingData = listOf("Need contract details for NVIDIA ↔︎ ASE Singapore."),
          recommendedTools = listOf("graph_state_tool", "codex:search"),
        ),
      )
    val sampleLimit = intent.sampleLimit ?: config.graphSampleLimit
    return buildString {
      appendLine("You are the NVIDIA Graf relationship planner.")
      appendLine("Objective: ${intent.objective}")
      appendLine(focusLine)
      appendLine(streamHint)
      appendLine("Default graph sample limit: $sampleLimit")
      appendLine("Metadata:")
      appendLine(metadataBlock)
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

  private fun extractJson(raw: String): String {
    val trimmed = raw.trim()
    val fenced =
      when {
        trimmed.startsWith("```json", ignoreCase = true) ->
          trimmed.removePrefix("```json").substringBeforeLast("```").trim()
        trimmed.startsWith("```", ignoreCase = true) -> trimmed.removePrefix("```").substringBeforeLast("```").trim()
        else -> trimmed
      }
    val start = fenced.indexOf('{')
    val end = fenced.lastIndexOf('}')
    if (start == -1 || end == -1 || end <= start) {
      throw IllegalStateException("AutoResearch agent response did not include JSON payload: $raw")
    }
    return fenced.substring(start, end + 1)
  }

  private fun buildPromptParams(): LLMParams = promptParamsForModel(llmModel, config)

  private fun buildLlmClient(config: AutoResearchConfig): LLMClient {
    val apiKey =
      requireNotNull(config.openAiApiKey?.takeIf { it.isNotBlank() }) {
        "OPENAI_API_KEY (or AGENT_OPENAI_API_KEY) must be configured when the AutoResearch agent is enabled"
      }
    val settings = config.openAiBaseUrl?.let { OpenAIClientSettings(baseUrl = it) } ?: OpenAIClientSettings()
    return OpenAILLMClient(apiKey, settings)
  }

  private fun resolveModel(modelId: String?): LLModel {
    val normalized = modelId?.trim()?.lowercase()
    return when (normalized) {
      "gpt-5" -> OpenAIModels.Chat.GPT5
      "gpt-5-mini" -> OpenAIModels.Chat.GPT5Mini
      "gpt-5-nano" -> OpenAIModels.Chat.GPT5Nano
      "gpt-4o" -> OpenAIModels.Chat.GPT4o
      "gpt-4o-mini" -> OpenAIModels.CostOptimized.GPT4oMini
      else -> OpenAIModels.Chat.GPT5
    }
  }

  companion object {
    private val SYSTEM_PROMPT =
      """
      You are the NVIDIA Graf relationship architect described in the OpenAI Cookbook orchestration patterns.
      - Study the current Neo4j graph via graph_state_tool before proposing actions.
      - Identify the highest-value relationship gaps across the entire NVIDIA ecosystem: partners, manufacturers, suppliers, investors, research alliances, or operational dependencies (not just supply chain nodes).
      - For every suggested relationship or entity delta, cite the missing evidence, confidence, and the concrete actions downstream Codex researchers should perform next.
      - Always emit strict JSON that matches the GraphRelationshipPlan schema: every field (objective, summary, currentSignals, candidateRelationships, prioritizedPrompts, missingData, recommendedTools) must be present. `candidateRelationships` entries must include fromId, toId, relationshipType, rationale, confidence, requiredEvidence, and suggestedArtifacts.
      - Before providing your final answer, call graph_plan_validator with the JSON you intend to return so the schema is validated.
      - Never wrap the JSON in Markdown fences or add commentary—the response_format already enforces the schema, so return only the JSON document.
      """.trimIndent()

    internal fun resolveTraceLogLevel(
      level: String,
      warn: (String) -> Unit = {},
    ): FeatureMessageLogWriter.LogLevel =
      runCatching { FeatureMessageLogWriter.LogLevel.valueOf(level.trim().uppercase()) }
        .getOrElse {
          warn("Unknown trace log level '$level', defaulting to INFO")
          FeatureMessageLogWriter.LogLevel.INFO
        }
  }
}

internal fun promptParamsForModel(
  model: LLModel,
  config: AutoResearchConfig,
): LLMParams {
  val provider = model.provider
  val providerId = provider.id
  val providerClass = provider::class.simpleName.orEmpty()
  val isOpenAi = providerId.contains("openai", ignoreCase = true) || providerClass.contains("OpenAI", ignoreCase = true)
  return if (isOpenAi) {
    OpenAIChatParams(
      reasoningEffort = ReasoningEffort.HIGH,
    ).copy(schema = GraphRelationshipPlanSchema.llmSchema)
  } else {
    LLMParams(temperature = DEFAULT_FALLBACK_TEMPERATURE)
  }
}

private const val DEFAULT_FALLBACK_TEMPERATURE = 0.2
