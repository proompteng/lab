# Alpha Discovery and Autonomous Improvement Pipeline

## Status

- Doc: `v6/04`
- Date: `2026-02-27`
- Maturity: `production design`
- Scope: offline strategy and factor discovery pipeline that continuously improves live expert stack without unsafe online mutation
- Implementation status: `Planned`
- Evidence:
  - `docs/torghut/design-system/v6/04-alpha-discovery-and-autonomous-improvement-pipeline.md` (design-level contract)
- Rollout gap: candidate generation, evaluation, and promotion lanes are not yet present as explicit AgentRun workflows in `services/torghut` or `services/torghut/app`.

## Objective

Operationalize strategy discovery methods inspired by QuantEvolve, AlphaQuanter, and automated factor mining research while preserving strict promotion controls.

## Pipeline Overview

### Stage A: Hypothesis generation

- Generate candidate alpha factors and strategy variants from multimodal datasets.
- Enforce strategy template constraints to avoid invalid or unexecutable proposals.

### Stage B: Candidate evaluation

- Run contamination-safe backtests and walk-forward tests.
- Score candidates by return quality, drawdown, turnover, slippage realism, and stability.

### Stage C: Candidate promotion

- Persist candidate artifacts and lineage.
- Promote only through deterministic gates and staged rollout policies.

### Stage D: Live feedback learning

- Collect post-trade diagnostics, attribution, and regret signals.
- Feed learnings into next offline generation cycle.

## Artifact Model

Each candidate must persist:

- `candidateId`
- `strategyDefinition`
- `featureSetVersion`
- `trainingWindow`
- `evalWindow`
- `performanceMetrics`
- `riskMetrics`
- `artifactHash`
- `parentCandidates`

## AgentRun Lane Extensions

In addition to DSPy lanes, add strategy-discovery lanes:

1. `torghut-alpha-generate-v1`
2. `torghut-alpha-eval-v1`
3. `torghut-alpha-risk-audit-v1`
4. `torghut-alpha-promote-v1`

These lanes must emit machine-readable artifacts that link back to DSPy and router artifact versions when relevant.

## Governance Constraints

- No direct auto-deploy from generation output.
- Every candidate must pass deterministic risk audit before paper stage.
- Live ramps require staged notional caps and rollback rehearsal evidence.

## Integration with Router and LLM Layers

- New factors can be assigned to existing experts or create new expert variants.
- Router feature schema versions must be updated transactionally with promoted candidates.
- LLM reasoning prompts/signatures can be tuned from evaluated candidate diagnostics, but runtime promotion remains evidence-gated.

## Key Metrics

- Candidate pass-through rate by stage.
- Median and p95 time from generation to paper deployment.
- Promotion acceptance rate.
- Live degradation rate after promotion.
- Rollback frequency and mean time to recovery.

## Validation and Safety Tests

1. Reproducibility tests for candidate regeneration from fixed seed and data snapshot.
2. Cross-regime robustness tests.
3. Capacity and slippage sensitivity tests.
4. Failure injection tests for candidate registry and promotion chain.

## Exit Criteria

1. End-to-end candidate lifecycle is fully automated through AgentRuns.
2. All promoted strategies have immutable lineage and replayable evidence.
3. Unsafe candidates are blocked before paper stage with explicit failure reasons.
