# Priority 6: Two-Speed Quant Research -> Engineering -> Production Pipeline

## Status

- Version: `v5-two-speed-pipeline-whitepaper-feeder`
- Date: `2026-02-25`
- Maturity: `implementation plan`
- Scope: autonomous research intake with gated engineering and deterministic production promotion

## Objective

Restructure Torghut workflow into a two-speed model:

1. keep research discovery, synthesis, and hypothesis generation highly automated,
2. keep engineering implementation and rollout policy-automated with deterministic approval contracts,
3. keep production promotion deterministic and fail-closed,
4. treat GitHub-issue whitepaper analysis as a first-class Speed A feeder with policy-driven auto-dispatch and auto-rollout.

## Why This Structure

Public signals from leading quant organizations suggest a common pattern:

- high-throughput research and experimentation,
- strong reproducibility contracts,
- conservative promotion gates before production risk is increased.

For Torghut, this means autonomy should be highest in research intelligence and lowest in production promotion.

## Non-Negotiable Invariants

- `paper` remains default; production is opt-in and staged.
- LLM outputs are advisory and cannot bypass deterministic risk policy.
- Promotion requires reproducible evidence, not narrative confidence.
- Any missing artifact or gate result blocks progression.
- High-confidence whitepaper verdicts may auto-start engineering candidate work and auto-rollout, but only through B2-B6 deterministic gates.
- Auto-rollout is opt-in by policy profile and must support instant rollback from any live stage.

## Fully Autonomous Lane Requirement

When `rollout_profile=automatic` is enabled, the lane must be capable of full end-to-end rollout as part of baseline requirements:

- auto-dispatch engineering candidate work from eligible whitepaper grades,
- auto-progress through `B3 paper -> B4 shadow -> B5 constrained-live -> B6 scaled-live` with no manual step injection,
- enforce all deterministic gates and notional schedule limits at every transition,
- auto-rollback and halt progression immediately on any blocking gate failure.

## Two-Speed Architecture

### Speed A: Research Intelligence Lane (Autonomous)

Purpose:

- continuously ingest latest quant and LLM research and convert it into implementable hypotheses.

Stages:

- `A0 schedule`: trigger runs by cadence and topic policy.
- `A1 discover`: collect candidate papers/posts from approved source lists.
- `A2 triage`: rank by novelty, relevance, and quality.
- `A3 synthesize`: produce structured summaries with citations and uncertainty.
- `A4 embed`: store semantic vectors for retrieval.
- `A5 backlog`: emit prioritized hypothesis backlog entries.
- `A6 grade`: compute implementation-readiness grade from persisted synthesis/verdict signals.

Output:

- `HypothesisCard` set and `EngineeringTriggerDecision` records (no production changes yet).

### Whitepaper Feeder (GitHub Issue -> Speed A)

Existing workflow (`whitepaper-analysis-v1`) is a canonical Speed A feeder:

- ingest GitHub issue marker + PDF URL,
- persist run/synthesis/verdict rows in `whitepaper_*` tables,
- emit finalization payload with machine-readable `synthesis` and `verdict`.

Feeder mapping into Speed A artifacts:

- `whitepaper_syntheses` -> `HypothesisCard.thesis`, citations, implementation notes.
- `whitepaper_viability_verdicts` -> grade inputs (`verdict`, `score`, `confidence`, `requires_followup`, `gating_json`).
- `whitepaper_design_pull_requests` -> provenance links; advisory only for downstream implementation context.

### Whitepaper Grading Policy (Auto-Trigger Eligibility)

For each completed whitepaper run, compute `implementation_grade`:

- `reject`: `verdict` indicates reject/not-viable, or confidence below threshold.
- `research_only`: potentially useful, but `requires_followup=true` or gating evidence incomplete.
- `engineering_candidate`: eligible for B1 auto-dispatch.
- `engineering_priority`: high-confidence candidate with strong score and no follow-up blockers.

Policy fields are read from persisted run outputs:

- `whitepaper_viability_verdicts.verdict`
- `whitepaper_viability_verdicts.score`
- `whitepaper_viability_verdicts.confidence`
- `whitepaper_viability_verdicts.requires_followup`
- `whitepaper_viability_verdicts.gating_json`

Default auto-dispatch eligibility (configurable by policy):

- `run.status == completed`
- `verdict in {implement, conditional_implement}`
- `confidence >= minConfidence`
- `score >= minScore`
- `requires_followup == false`
- no blocking reason in `gating_json`

### Speed B: Engineering + Production Lane (Gated)

Purpose:

- transform approved hypotheses into tested changes and promote only with deterministic evidence.

Stages:

- `B0 select`: human approves hypotheses for implementation.
- `B1 engineer`: Engineering Codex generates RFC, code, and tests.
- `B2 validate`: run backtests, robustness checks, and policy checks.
- `B3 paper`: deploy paper candidate and observe SLO window.
- `B4 shadow`: shadow/live-parity checks (required for `automatic` rollout profile).
- `B5 constrained-live`: small notional with strict kill-switch budget.
- `B6 scaled-live`: increase capital only after all live gate windows pass.
- `B7 auto-rollout-controller`: advance/revert stages based on gate outcomes and policy profile.

Output:

- `PromotionPack` and auditable rollout records.

## Handoff Contract Between Lanes

Research lane cannot directly trigger production actions. It can only create backlog artifacts:

- `HypothesisCard` (research claim + citations + confidence + target component).
- `ExperimentSpec` (testable implementation idea and expected metric movement).
- `RiskNote` (known fragility, assumptions, invalidation criteria).

Engineering lane starts only when:

- `approvalToken` is issued by owner or minted by approved policy for automated B-stage progression,
- proposal scope and rollback owner are assigned,
- required input artifacts are complete.

Auto-minted tokens are limited to:

- starting `B1 engineer` for pre-approved policies,
- advancing stages `B3 -> B6` only when all required gates are `pass`,
- triggering rollback on any severity-1 gate failure,
- never bypassing gate evidence requirements.

## Required Artifacts by Stage

### Research Artifacts

- `paper-catalog.json`
- `synthesis-bundle.json`
- `embedding-manifest.json`
- `hypothesis-backlog.json`
- `whitepaper-feeder-map.json`
- `engineering-trigger-decision.json`

### Engineering Artifacts

- `strategy-rfc.md`
- `candidate-diff.patch`
- `test-plan.md`
- `validation-config.yaml`

### Promotion Artifacts

- `paper-evidence.json`
- `gate-evaluation.json`
- `risk-signoff.json`
- `rollback-rehearsal.md`
- `rollout-policy.yaml`
- `stage-transition-log.json`

## Gate Matrix (Deterministic)

1. `G1 data-integrity`
   - freshness, completeness, schema validity pass.
2. `G2 reproducibility`
   - run hash, dataset snapshot, and code commit are pinned and replayable.
3. `G3 statistical-validity`
   - out-of-sample quality, regime-slice coverage, and leakage checks pass.
4. `G4 execution-realism`
   - costs, slippage, capacity, and fill assumptions pass.
5. `G5 policy-and-risk`
   - drawdown, position limits, exposure rules, and compliance checks pass.
6. `G6 paper-window`
   - paper SLO and safety metrics pass for configured window.
7. `G7 live-ramp`
   - constrained-live safety and performance thresholds pass before scale-up.

Any gate failure:

- blocks promotion,
- emits reason codes and evidence pointers,
- requires explicit retry with changed artifact hash.

## Data Model (Research Database)

Use Postgres + `pgvector`.

### `research_hypotheses`

- `hypothesis_id` (uuid)
- `run_id`
- `title`
- `thesis`
- `target_components` (text[])
- `evidence_refs` (jsonb)
- `estimated_impact`
- `estimated_complexity`
- `status` (`new|approved|rejected|implemented`)

### `research_artifacts`

- `artifact_id` (uuid)
- `run_id`
- `artifact_type`
- `artifact_hash`
- `storage_ref`
- `created_at`

### `engineering_promotions`

- `promotion_id` (uuid)
- `hypothesis_id`
- `stage` (`paper|shadow|constrained_live|scaled_live`)
- `gate_results` (jsonb)
- `approver`
- `approval_token`
- `status` (`pending|passed|failed|rolled_back`)

### `whitepaper_engineering_triggers`

- `trigger_id` (uuid)
- `whitepaper_run_id`
- `verdict_id`
- `hypothesis_id`
- `implementation_grade` (`reject|research_only|engineering_candidate|engineering_priority`)
- `decision` (`suppressed|queued|dispatched|failed`)
- `reason_codes` (jsonb)
- `approval_token`
- `dispatched_agentrun_name`
- `rollout_profile` (`manual|assisted|automatic`)
- `created_at`

## ImplementationSpec Catalog (Two-Speed)

### `torghut-v5-research-intake-v2`

Purpose:

- autonomous discovery, triage, synthesis, embeddings, and backlog generation.

Required keys:

- `topics`
- `lookbackDays`
- `maxSources`
- `artifactPath`

### `torghut-v5-whitepaper-feeder-v1`

Purpose:

- normalize completed whitepaper runs into backlog artifacts and implementation grades.

Required keys:

- `runId`
- `minConfidence`
- `minScore`
- `policyRef`
- `artifactPath`

### `torghut-v5-hypothesis-selection-v1`

Purpose:

- convert backlog into approved engineering candidates.

Required keys:

- `backlogRef`
- `approvalPolicyRef`
- `selectedHypothesisIds`
- `artifactPath`

### `torghut-v5-engineering-candidate-v1`

Purpose:

- implement approved hypothesis into RFC, code, and tests.

Required keys:

- `hypothesisRef`
- `repository`
- `base`
- `head`
- `artifactPath`

### `torghut-v5-high-confidence-trigger-v1`

Purpose:

- evaluate whitepaper grade policy and auto-dispatch B1 engineering candidate runs when eligible.

Required keys:

- `runId`
- `hypothesisRef`
- `policyRef`
- `repository`
- `base`
- `head`
- `artifactPath`

### `torghut-v5-auto-rollout-controller-v1`

Purpose:

- automatically promote/revert candidates across `paper -> shadow -> constrained_live -> scaled_live` when deterministic gates pass/fail.

Required keys:

- `candidateRef`
- `rolloutPolicyRef`
- `gateEvidenceRef`
- `maxNotionalScheduleRef`
- `artifactPath`

### `torghut-v5-promotion-gates-v1`

Purpose:

- evaluate deterministic gate matrix and emit promotion decision.

Required keys:

- `candidateRef`
- `gateConfigPath`
- `evidenceBundleRef`
- `artifactPath`

## Operating Cadence

- research lane: daily or intraday cadence.
- whitepaper feeder: event-driven on whitepaper run finalization.
- engineering lane: batch by approved backlog and team capacity.
- production promotion: event-driven only after gate evidence completion.
- auto-rollout controller: event-driven on gate completion and window close.

## SLOs

- research synthesis success >= 99.0%.
- embedding write success >= 99.9%.
- hypothesis citation completeness >= 98.0%.
- gate evaluator determinism = 100% (same input hash -> same output).
- promotion rollback drill pass rate = 100%.

## Rollout Plan

1. Phase 0 (`research-only`)
   - run Speed A only; include whitepaper feeder mapping + grading policy dry-runs.
2. Phase 1 (`assisted engineering`)
   - enable `B0-B2`; allow policy-minted B1 auto-start for high-confidence whitepaper candidates.
3. Phase 2 (`paper promotion`)
   - enable `B3` and automatic `paper -> shadow` progression when policy profile is `automatic`.
4. Phase 3 (`live ramp`)
   - enable automatic `B4-B6` progression with capped notional schedule, continuous gates, and instant rollback.
   - exit gate: at least one candidate reaches `scaled_live` under `rollout_profile=automatic` without manual promotion actions.

## What This Explicitly Prevents

- no direct research-to-prod automation.
- no ungated whitepaper-to-prod automation.
- no LLM-only approval path for live risk increases.
- no promotion when artifacts are missing or non-reproducible.
- no automatic stage transition when any required gate is non-`pass`.

## Acceptance Criteria

- At least one hypothesis completes full path `A0 -> B3` with complete evidence pack.
- At least one completed whitepaper run with eligible grade auto-dispatches a B1 engineering AgentRun and records trigger evidence.
- At least one candidate completes automatic full progression `B3 -> B6` under policy profile `automatic` with full transition log.
- Production gate evaluator blocks intentionally malformed or incomplete candidates.
- Replay of a promotion decision produces identical gate outcomes from stored hashes.
- Operators can trigger rollback from any live stage with documented procedure.

## References

- `docs/torghut/design-system/v5/08-leading-quant-firms-public-research-and-systems-2026-02-21.md`
- `docs/torghut/design-system/v5/06-whitepaper-technique-synthesis.md`
- `docs/torghut/design-system/v3/full-loop/13-research-ledger-promotion-evidence-spec.md`
