package ai.proompteng.graf.autoresearch

import ai.koog.agents.core.agent.AIAgentService
import ai.koog.agents.core.agent.config.AIAgentConfig
import ai.koog.agents.core.tools.ToolRegistry
import ai.koog.agents.ext.agent.reActStrategy
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
import ai.proompteng.graf.config.AutoresearchConfig
import ai.proompteng.graf.model.AutoresearchPlanIntent
import ai.proompteng.graf.model.GraphRelationshipPlan
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.Closeable
import java.lang.AutoCloseable

class AutoresearchAgentService(
  private val config: AutoresearchConfig,
  snapshotProvider: GraphSnapshotProvider,
  private val json: Json,
) : Closeable {
  private val llmClient: LLMClient
  private val promptExecutor: SingleLLMPromptExecutor
  private val agentService: AIAgentService<String, String, *>

  private val llmModel: LLModel = resolveModel(config.model)

  init {
    require(config.isReady) { "Autoresearch agent requested but configuration is disabled or incomplete" }
    llmClient = buildLlmClient(config)
    promptExecutor = SingleLLMPromptExecutor(llmClient)
    val graphStateTool = GraphStateTool(snapshotProvider, json, config.graphSampleLimit)
    val promptParams = buildPromptParams()
    val basePrompt =
      prompt(
        id = "graf-autoresearch-agent",
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
    agentService =
      AIAgentService(
        promptExecutor = promptExecutor,
        agentConfig = agentConfig,
        strategy = reActStrategy(),
        toolRegistry =
          ToolRegistry {
            tool(graphStateTool)
          },
      )
  }

  suspend fun generatePlan(intent: AutoresearchPlanIntent): GraphRelationshipPlan {
    val input = buildAgentInput(intent)
    val raw = agentService.createAgentAndRun(input)
    val payload = extractJson(raw)
    val plan =
      runCatching { json.decodeFromString(GraphRelationshipPlan.serializer(), payload) }
        .getOrElse { failure ->
          throw IllegalStateException("Autoresearch agent returned unparsable plan: ${failure.message}", failure)
        }
    return plan.copy(
      objective = plan.objective.ifBlank { intent.objective },
    )
  }

  override fun close() {
    (llmClient as? AutoCloseable)?.close()
  }

  private fun buildAgentInput(intent: AutoresearchPlanIntent): String {
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
      throw IllegalStateException("Autoresearch agent response did not include JSON payload: $raw")
    }
    return fenced.substring(start, end + 1)
  }

  private fun buildPromptParams() =
    if (llmModel.provider == LLMProvider.OpenAI) {
      OpenAIChatParams(
        temperature = config.temperature,
        reasoningEffort = ReasoningEffort.HIGH,
      )
    } else {
      LLMParams(temperature = config.temperature)
    }

  private fun buildLlmClient(config: AutoresearchConfig): LLMClient {
    val apiKey =
      requireNotNull(config.openAiApiKey?.takeIf { it.isNotBlank() }) {
        "OPENAI_API_KEY (or AGENT_OPENAI_API_KEY) must be configured when the autoresearch agent is enabled"
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
      - Always emit strict JSON that matches the GraphRelationshipPlan schema—no commentary outside of the JSON payload.
      """.trimIndent()
  }
}
