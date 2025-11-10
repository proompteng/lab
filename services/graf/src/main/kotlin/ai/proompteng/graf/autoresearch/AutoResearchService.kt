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
      NVIDIA Graf AutoResearch · prompt v$PROMPT_VERSION
      UTC timestamp: $timestamp

      You are executing inside the Codex research workflow that can read the open internet and run shell commands. Your only goal is to expand the NVIDIA Graf Neo4j knowledge graph with high-confidence entities and relationships across suppliers, fabs, OEMs, hyperscalers, investors, research programs, regulators, and key personnel.

      Execution rules:
      1. Prioritize developments announced in the past nine months that materially affect NVIDIA's supply chain resilience, customer landscape, or strategic dependencies.
      2. Validate every fact with at least two independent sources before persisting it.
      3. As soon as you confirm a new entity or relationship, serialize a JSON payload that matches Graf's HTTP API and POST it yourself with the bundled TypeScript CLI `codex-graf` (installed at `/usr/local/bin/codex-graf`). The CLI automatically respects `CODEX_GRAF_BASE_URL` and `CODEX_GRAF_BEARER_TOKEN`, so pass only the endpoint path.
         • Entities: pipe `{ "entities": [ ... ] }` to `codex-graf --endpoint /v1/entities`.
         • Relationships: pipe `{ "relationships": [ ... ] }` to `codex-graf --endpoint /v1/relationships`.
         • Always set `artifactId`, `researchSource` (canonical URL), and `streamId` = "$AUTO_RESEARCH_STREAM_ID" so reviewers can trace this run.
         • Example entity ingest:
             cat <<'JSON' | codex-graf --endpoint /v1/entities
             {
               "entities": [
                 {
                   "id": "company:hypothetical-fab",
                   "label": "Company",
                   "properties": {
                     "name": "Hypothetical Fab",
                     "description": "New OSAT partner expanding HBM4 capacity",
                     "country": "TW",
                     "sourceUrl": "https://example.com/hbm4"
                   },
                   "artifactId": "$AUTO_RESEARCH_STREAM_ID",
                   "researchSource": "https://example.com/hbm4",
                   "streamId": "$AUTO_RESEARCH_STREAM_ID"
                 }
               ]
             }
             JSON
         • Example relationship ingest:
             cat <<'JSON' | codex-graf --endpoint /v1/relationships
             {
               "relationships": [
                 {
                   "type": "SUPPLIES",
                   "fromId": "company:hypothetical-fab",
                   "toId": "company:nvidia",
                   "properties": {
                     "product": "HBM4",
                     "confidence": "high",
                     "sourceUrl": "https://example.com/hbm4",
                     "effectiveQuarter": "2025Q2"
                   },
                   "artifactId": "$AUTO_RESEARCH_STREAM_ID",
                   "researchSource": "https://example.com/hbm4",
                   "streamId": "$AUTO_RESEARCH_STREAM_ID"
                 }
               ]
             }
             JSON
      4. Keep iterating until you have published at least three high-confidence updates or run out of credible leads. Every POST you make should reflect reality immediately—do not wait for a human reviewer.
      5. Summarize what you persisted (entities, relationships, evidence URLs) so the resulting `codex-artifact.json` captures your final state.

      Operator guidance:
      $operatorGuidance

      Checklist before exiting:
      - [ ] Logged every Graf mutation via `codex-graf` with artifact + stream metadata.
      - [ ] Captured evidence URLs and reasoning in the final summary.
      - [ ] Highlighted follow-up gaps for the next AutoResearch run if you ran out of time.
      - [ ] Avoided duplicating existing nodes/edges; reuse IDs whenever possible.
      - [ ] Ensured all shell commands completed successfully (non-zero exit codes require investigation).
    """.trimIndent()
  }

  fun buildMetadata(userPrompt: String?, argoWorkflowName: String): Map<String, String> {
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
