# Priority 6: Two-Speed Quant Research -> Engineering -> Production Pipeline

## Status

- Version: `v5-two-speed-pipeline`
- Date: `2026-02-21`
- Maturity: `implementation plan`
- Scope: autonomous research intake with gated engineering and deterministic production promotion

## Objective

Restructure Torghut workflow into a two-speed model:

1. keep research discovery, synthesis, and hypothesis generation highly automated,
2. keep engineering implementation semi-automated with explicit human approvals,
3. keep production promotion deterministic and fail-closed.

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

Output:

- `HypothesisCard` set (no code changes yet).

### Speed B: Engineering + Production Lane (Gated)

Purpose:

- transform approved hypotheses into tested changes and promote only with deterministic evidence.

Stages:

- `B0 select`: human approves hypotheses for implementation.
- `B1 engineer`: Engineering Codex generates RFC, code, and tests.
- `B2 validate`: run backtests, robustness checks, and policy checks.
- `B3 paper`: deploy paper candidate and observe SLO window.
- `B4 shadow`: optional shadow/live-parity checks.
- `B5 constrained-live`: small notional with strict kill-switch budget.
- `B6 scaled-live`: increase capital only after all live gate windows pass.

Output:

- `PromotionPack` and auditable rollout records.

## Handoff Contract Between Lanes

Research lane cannot directly trigger production actions. It can only create backlog artifacts:

- `HypothesisCard` (research claim + citations + confidence + target component).
- `ExperimentSpec` (testable implementation idea and expected metric movement).
- `RiskNote` (known fragility, assumptions, invalidation criteria).

Engineering lane starts only when:

- `approvalToken` is issued by owner,
- proposal scope and rollback owner are assigned,
- required input artifacts are complete.

## Required Artifacts by Stage

### Research Artifacts

- `paper-catalog.json`
- `synthesis-bundle.json`
- `embedding-manifest.json`
- `hypothesis-backlog.json`

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

## ImplementationSpec Catalog (Two-Speed)

### `torghut-v5-research-intake-v2`

Purpose:

- autonomous discovery, triage, synthesis, embeddings, and backlog generation.

Required keys:

- `topics`
- `lookbackDays`
- `maxSources`
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
- engineering lane: batch by approved backlog and team capacity.
- production promotion: event-driven only after gate evidence completion.

## SLOs

- research synthesis success >= 99.0%.
- embedding write success >= 99.9%.
- hypothesis citation completeness >= 98.0%.
- gate evaluator determinism = 100% (same input hash -> same output).
- promotion rollback drill pass rate = 100%.

## Rollout Plan

1. Phase 0 (`research-only`)
   - run Speed A only; tune relevance and citation quality.
2. Phase 1 (`assisted engineering`)
   - enable `B0-B2` with mandatory approval token.
3. Phase 2 (`paper promotion`)
   - enable `B3` with strict gate evaluator output requirements.
4. Phase 3 (`live ramp`)
   - enable `B4-B6` with capped notional and instant rollback.

## What This Explicitly Prevents

- no direct research-to-prod automation.
- no LLM-only approval path for live risk increases.
- no promotion when artifacts are missing or non-reproducible.

## Acceptance Criteria

- At least one hypothesis completes full path `A0 -> B3` with complete evidence pack.
- Production gate evaluator blocks intentionally malformed or incomplete candidates.
- Replay of a promotion decision produces identical gate outcomes from stored hashes.
- Operators can trigger rollback from any live stage with documented procedure.

## References

- `docs/torghut/design-system/v5/08-leading-quant-firms-public-research-and-systems-2026-02-21.md`
- `docs/torghut/design-system/v5/06-whitepaper-technique-synthesis.md`
- `docs/torghut/design-system/v3/full-loop/13-research-ledger-promotion-evidence-spec.md`
