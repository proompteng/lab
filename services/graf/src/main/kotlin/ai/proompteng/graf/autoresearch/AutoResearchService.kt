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
  private val promptBuilder: AutoResearchPromptBuilder = AutoResearchPromptBuilder(),
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
  private val clock: Clock = Clock.systemUTC(),
) {
  fun buildPrompt(userPrompt: String?): String {
    val timestamp = Instant.now(clock).toString()
    val operatorGuidance = userPrompt?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_USER_GUIDANCE
    return """
      Codex AutoResearch · v$PROMPT_VERSION · UTC $timestamp

      ROLE – Autonomous Codex agent growing the NVIDIA Graf Neo4j graph with high-confidence suppliers, fabs, hyperscalers, investors, regulators, and key personnel.

      GOALS
      1. Publish at least ten high-confidence updates or stop only when no credible leads remain.
      2. Focus on developments announced within the past nine months that materially affect NVIDIA's resilience, customer landscape, or dependencies.
      3. Persist facts only when backed by two independent, credible sources; otherwise record them in followUpGaps.

      TOOLS
      - Use `/usr/local/bin/codex-graf --endpoint <path>` for every ingest payload. Emit a single JSON line per call (`{"entities":[...]} or {"relationships":[...]}`) that already includes `artifactId`, `researchSource`, and `streamId` = "$AUTO_RESEARCH_STREAM_ID".
      - Use `/v1/complement` for enrichment gaps and `/v1/clean` for cleanup, tagging each payload with the same metadata.
      - Keep tool usage intentional—limit exploratory web/search calls unless needed to validate a fact, and never change the Graf base URL.

      OUTPUTS
      1. Ingest JSON lines as described above (no commentary, one object per line).
      2. Final summary JSON: `{"persisted":[],"evidence":{"id":["url"]},"followUpGaps":[],"errors":[],"finalArtifactFile":"codex-artifact.json"}` capturing every persisted id, evidence URLs, unresolved gaps, and command failures.

      RUNTIME RULES
      - Reuse existing node/edge IDs whenever possible; avoid duplicates.
      - Log every mutation via `codex-graf` immediately and mark failed shell commands inside `errors`.
      - Track evidence for each persisted record and stop only after the goals plus checklist are complete.

      CHECKLIST
      - Logged all Graf mutations with artifact + stream metadata.
      - Captured evidence URLs in the final summary.
      - Listed follow-up gaps for unresolved leads.
      - Verified all shell commands exited successfully.

      Operator guidance:
      $operatorGuidance
      """.trimIndent()
  }

  fun buildMetadata(
    userPrompt: String?,
    argoWorkflowName: String,
  ): Map<String, String> {
    val timestamp = Instant.now(clock).toString()
    val trimmed = userPrompt?.trim()?.takeIf { it.isNotEmpty() }
    return buildMap {
      put("codex.stage", AUTO_RESEARCH_STAGE)
      put("autoResearch.promptVersion", PROMPT_VERSION)
      put("autoResearch.generatedAt", timestamp)
      put("autoResearch.argoWorkflow", argoWorkflowName)
      trimmed?.let { put("autoResearch.userPrompt", it.take(MAX_METADATA_LENGTH)) }
    }
  }
}

private const val PROMPT_VERSION = "2025-11-10"
private const val AUTO_RESEARCH_STAGE = "auto-research"
const val AUTO_RESEARCH_STREAM_ID = "auto-research"
private const val DEFAULT_USER_GUIDANCE =
  "Continue expanding the NVIDIA Graf knowledge graph with the highest-signal suppliers, fabs, customers, partners, and regulators whose announcements affect NVIDIA's 2024–2026 roadmap."
private const val MAX_METADATA_LENGTH = 800
