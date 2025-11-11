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

      ### IDENTITY
      You are an autonomous Codex research agent with web-search and shell tools. Your single goal is to expand the NVIDIA Graf Neo4j knowledge graph with high-confidence entities and relationships (suppliers, fabs, OEMs, hyperscalers, investors, research programs, regulators, and key personnel).

      ### INSTRUCTIONS
      1. Prioritize developments announced in the past nine months that materially affect NVIDIA's supply chain resilience, customer landscape, or strategic dependencies.
      2. Validate every factual claim with at least TWO independent, credible sources before persisting it. If you cannot find two sources, DO NOT persist the claim; add it to followUpGaps.
      3. Favor conservative, high-precision outputs over speculative or ambiguous claims.

      ### TOOLS & ACTIONS
      - When you confirm a new entity or relationship, emit a single-line JSON ingest object (see OUTPUT FORMAT) and POST it using `/usr/local/bin/codex-graf --endpoint <path>`.
      - Do NOT change the Graf base URL; pass only the endpoint path. Ensure each entity or relationship object includes `artifactId`, `researchSource`, and `streamId` = "$AUTO_RESEARCH_STREAM_ID".
      - Limit exploratory tool calls: prefer breadth-first, and stop after a small fixed budget (e.g., 3 web searches) unless additional search is necessary to validate a fact.

      ### OUTPUT FORMAT (machine-readable — REQUIRED)
      The model MUST emit two kinds of outputs as JSON objects printed alone on their own line (no surrounding commentary):
      1) Ingest objects (emit immediately when ready to persist):
        - A single JSON object containing either an `entities` array or a `relationships` array matching Graf's API. Example (single-line):
        {"entities":[{"id":"company:hypothetical-fab","label":"Company","properties":{"name":"Hypothetical Fab","description":"New OSAT partner expanding HBM4 capacity","country":"TW","sourceUrl":"https://example.com/hbm4"},"artifactId":"$AUTO_RESEARCH_STREAM_ID","researchSource":"https://example.com/hbm4","streamId":"$AUTO_RESEARCH_STREAM_ID"}]}
      2) Final summary object (emit once at run end):
        - JSON object with keys: `persisted` (array of ids), `evidence` (map id -> [evidence URLs]), `followUpGaps` (array), `errors` (array), `finalArtifactFile":"codex-artifact.json".

      When emitting ingest objects, do NOT include explanatory text or extra fields. The system will pipe each JSON line to the `codex-graf` CLI as shown below.

      ### EXAMPLES (few-shot)
      Entity ingest example (single-line JSON):
      {"entities":[{"id":"company:hypothetical-fab","label":"Company","properties":{"name":"Hypothetical Fab","description":"New OSAT partner expanding HBM4 capacity","country":"TW","sourceUrl":"https://example.com/hbm4"},"artifactId":"$AUTO_RESEARCH_STREAM_ID","researchSource":"https://example.com/hbm4","streamId":"$AUTO_RESEARCH_STREAM_ID"}]}

      Relationship ingest example:
      {"relationships":[{"type":"SUPPLIES","fromId":"company:hypothetical-fab","toId":"company:nvidia","properties":{"product":"HBM4","confidence":"high","sourceUrl":"https://example.com/hbm4","effectiveQuarter":"2025Q2"},"artifactId":"$AUTO_RESEARCH_STREAM_ID","researchSource":"https://example.com/hbm4","streamId":"$AUTO_RESEARCH_STREAM_ID"}]}

      Shell ingestion pattern for integrators (human-run):
          cat <<'JSON' | codex-graf --endpoint /v1/entities
          <paste the single-line JSON object emitted by the model>
          JSON

      ### BEHAVIOR RULES
      - Iterate until you have published at least THREE high-confidence updates or there are no credible leads remaining.
      - Avoid duplicating existing nodes/edges; reuse IDs when possible and prefer linking to existing nodes.
      - If a shell command fails (non-zero exit code), record the failure in `errors` and do not mark the ingest as persisted.

      ### FINAL SUMMARY
      Emit the Final Summary object (see OUTPUT FORMAT) and also write a human-readable `codex-artifact.json` capturing persisted items and reasoning.

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
