package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.codex.CodexResearchLaunchResult
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.model.AutoResearchRequest
import ai.proompteng.graf.model.CodexResearchRequest
import mu.KotlinLogging
import java.time.Clock
import java.time.Instant

interface AutoResearchLauncher {
  fun startResearch(
    request: AutoResearchRequest,
    argoWorkflowName: String,
    artifactKey: String,
  ): CodexResearchLaunchResult
}

class AutoResearchService(
  private val codexResearchService: CodexResearchService,
  private val promptBuilder: AutoResearchPromptBuilder,
) : AutoResearchLauncher {
  private val logger = KotlinLogging.logger {}

  override fun startResearch(
    request: AutoResearchRequest,
    argoWorkflowName: String,
    artifactKey: String,
  ): CodexResearchLaunchResult {
    val userPrompt = request.userPrompt
    val finalPrompt = promptBuilder.buildPrompt(userPrompt)
    val metadata = promptBuilder.buildMetadata(userPrompt, argoWorkflowName)
    val launch =
      codexResearchService.startResearch(
        CodexResearchRequest(prompt = finalPrompt, metadata = metadata),
        argoWorkflowName,
        artifactKey,
      )
    logger.info {
      "AutoResearch Codex workflow launched workflowId=${launch.workflowId} " +
        "argoWorkflow=$argoWorkflowName userPromptProvided=${!userPrompt.isNullOrBlank()}"
    }
    return launch
  }
}

class AutoResearchPromptBuilder(
  private val config: AutoResearchConfig,
  private val clock: Clock = Clock.systemUTC(),
) {
  fun buildPrompt(userPrompt: String?): String {
    val timestamp = Instant.now(clock).toString()
    val operatorGuidance = userPrompt?.trim()?.takeIf { it.isNotEmpty() } ?: config.defaultOperatorGuidance
    val goalBlock =
      config.defaultGoalsText
        .trim()
        .lines()
        .joinToString("\n") { "|${it.trim()}" }
    val headerLine =
      "${config.knowledgeBaseName} · v$PROMPT_VERSION · stage ${config.stage} · UTC $timestamp"
    return """
      |$headerLine
      |
      |# ROLE AND OBJECTIVE
      |You are an autonomous Codex agent growing the ${config.knowledgeBaseName} knowledge graph. Operate in stage ${config.stage} and prioritize high-confidence suppliers, fabs, hyperscalers, investors, regulators, and key personnel.
      |
      |# INSTRUCTION HIERARCHY
      |1) Follow this system prompt.
      |2) Follow Operator guidance below if it does not conflict with this prompt.
      |3) If anything is unclear, choose the safest default and proceed without asking questions.
      |
      |# GOALS
      |
      $goalBlock
      |
      |# TOOLING CHECKS (RUN BEFORE RESEARCH)
      |1) Verify `/usr/local/bin/codex-graf` is executable (e.g., `command -v /usr/local/bin/codex-graf`).
      |2) Verify `CODEX_GRAF_BASE_URL` is set.
      |If a check fails, record the error in the final summary JSON and stop after emitting it. Do not invent tool output.
      |
      |# TOOLS
      |- Use `/usr/local/bin/codex-graf --endpoint <path>` for every ingest payload. Emit a single JSON line per call (`{"entities":[...]} or {"relationships":[...]}`) that already includes `artifactId`, `researchSource`, and `streamId` = "${config.streamId}".
      |- Use `/v1/complement` for enrichment gaps and `/v1/clean` for cleanup, tagging each payload with the same metadata.
      |- Keep tool usage intentional. Use web/search only to validate facts, prefer primary sources, and never change the Graf base URL.
      |
      |# OUTPUT FORMAT (STRICT)
      |1) Ingest JSON lines as described above (no commentary, one object per line).
      |2) Final summary JSON: `{"persisted":[],"evidence":{"id":["url"]},"followUpGaps":[],"errors":[],"finalArtifactFile":"codex-artifact.json"}` capturing every persisted id, evidence URLs, unresolved gaps, and command failures.
      |If blocked, output only the final summary JSON with `errors` filled and `persisted` empty.
      |
      |# RUNTIME RULES
      |- Reuse existing node/edge IDs whenever possible; avoid duplicates.
      |- Log every mutation via `codex-graf` immediately and mark failed shell commands inside `errors`.
      |- Track evidence for each persisted record and stop only after the goals plus checklist are complete.
      |- When sources conflict, prefer authoritative sources but preserve both URLs in evidence.
      |- Do not ask clarifying questions; proceed with defaults unless a tooling check fails.
      |
      |# CHECKLIST
      |- Verified codex-graf availability and base URL (or logged the failure).
      |- Logged all Graf mutations with artifact + stream metadata.
      |- Captured evidence URLs in the final summary.
      |- Listed follow-up gaps for unresolved leads.
      |- Verified all shell commands exited successfully.
      |
      |Operator guidance:
      |$operatorGuidance
      """.trimMargin()
  }

  fun buildMetadata(
    userPrompt: String?,
    argoWorkflowName: String,
  ): Map<String, String> {
    val timestamp = Instant.now(clock).toString()
    val trimmed = userPrompt?.trim()?.takeIf { it.isNotEmpty() }
    return buildMap {
      put("codex.stage", config.stage)
      put("streamId", config.streamId)
      put("autoResearch.promptVersion", PROMPT_VERSION)
      put("autoResearch.generatedAt", timestamp)
      put("autoResearch.argoWorkflow", argoWorkflowName)
      trimmed?.let { put("autoResearch.userPrompt", it.take(MAX_METADATA_LENGTH)) }
    }
  }
}

private const val PROMPT_VERSION = "2026-01-09"
private const val MAX_METADATA_LENGTH = 800
