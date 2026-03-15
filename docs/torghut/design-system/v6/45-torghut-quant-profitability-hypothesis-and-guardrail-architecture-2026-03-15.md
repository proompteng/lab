# Torghut quant profitability architecture and guardrail contract (2026-03-15)

## Problem

Current evidence suggests the system can execute strategy candidates but has uneven measurable profitability outcomes across regimes, while fallback-heavy observability can delay confidence in lane-level capital allocation. We need architecture changes that prioritize statistically defensible alpha, explicit risk budgets, and guardrails that prevent unbounded loss concentration.

Key risk indicators from runtime evidence include:

- cluster-level scheduling and template failures in discover/plan surfaces,
- stale market context observations and mixed-quality metric paths,
- dependence on a limited set of global progression heuristics with weak per-hypothesis capital governance.

## Baseline and source evidence

- Hypothesis runtime contract is already defined:
  - `services/torghut/app/trading/hypotheses.py`
- Existing research and metric structures support lifecycle gating:
  - `services/torghut/app/models/entities.py`
  - `services/torghut/app/trading/models.py`
  - `services/torghut/app/trading/strategy_runtime.py`
- Profitability signal assembly uses freshness- and status-aware metrics:
  - `services/jangar/src/server/torghut-quant-metrics.ts`
- Current governance docs establish progression concepts:
  - `docs/torghut/design-system/v6/40-decision-profitability-circuit-and-evidenced-capital-allocation-2026-03-15.md`
  - `docs/torghut/design-system/v6/41-profitability-hypothesis-and-guardrail-contract-2026-03-15.md`

## Architecture goals

1. Define a measurable profitability ladder with explicit statistical gates per hypothesis.
2. Add multi-lane capital governance with hard caps and kill thresholds.
3. Improve freshness and consistency checks so stale hypotheses do not receive live capital.
4. Reduce hypothesis promotion latency while keeping loss control strict.

## Alternatives considered

### Alternative A: Keep existing gating model and only harden telemetry checks

Pros:

- Minimal code changes.
- Fewer contract changes.

Cons:

- Leaves capital allocation centralized and less adaptive.
- Limited control over regime-level concentration risk.
- Hard to prove profitability improvements with low variance.

### Alternative B: Static capital buckets + periodic manual review only

Pros:

- Deterministic and easy to audit.

Cons:

- Slow response to changing market regimes.
- Over-reliance on operator intervention.
- Does not scale with model count growth.

### Alternative C: Dynamic profitability mesh with evidence-budgeted capital routing (chosen)

Pros:

- Capital can be moved by objective evidence quality and recent realized performance.
- Supports both aggressive and conservative lanes with explicit budgets.
- Enables automatic deallocation on degradation.

Cons:

- More state and metric coupling.
- Requires stronger schema and test coverage in `services/torghut`.

### Alternative D: Full replacement of the hypothesis model with external brokered routing

Pros:

- Maximum abstraction and potential external ML governance.

Cons:

- Migration risk.
- Long implementation horizon.
- Unnecessary complexity for current maturity.

## Decision

Choose Alternative C: a **Profitability Mesh** with explicit hypothesis-to-capital contracts and hard guardrails.

The chosen design introduces:

- Lane contracts as first-class governance objects.
- Dynamic capital fractions by regime + evidence score.
- Strict deallocation and rollback triggers for stale/negative evidence.

## Core design

### 1) Three-layer profitability ladder

Each hypothesis follows:

1. Shadow lane (no capital).
2. Canary lane (bounded fractional capital).
3. Scaled live lane (performance-adjusted exposure).

Transitions require:

- minimum completed sample threshold,
- minimum signal quality score,
- bounded freshness SLA,
- and minimum evidence continuity for the last N executions.

### 2) Quantified hypothesis admission rules

- `min_sample_count_for_live_canary` and `min_sample_count_for_scale_up` remain required in manifest.
- New explicit thresholds:
  - minimum positive expectancy over 20 rolling intervals,
  - maximum rolling drawdown floor per regime,
  - minimum trade quality score from execution telemetry.
- Confidence decay after freshness breaches to reduce risk.

### 3) Guardrail budget model

- Per-strategy and per-regime risk budgets expressed in bps.
- Hard global budget ceilings:
  - max active capital percent,
  - max concentration by regime,
  - max open-symbol overlap.
- Deallocation guard:
  - automatic downgrade to `shadow` when drawdown or freshness breaches persist across two checkpoints.

### 4) Hypothesis evidence ledger

- Persist measurable state:
  - lifecycle, evidence continuity, feature drift checks, and gate outcomes.
- Link gate outcomes to manifest revision and feature spec hash to avoid blind reuse.
- Require evidence continuity checks in both canary and live scale transitions.

## Success metrics

- Primary hypotheses:
  - Hypothesis canary net expectancy improvement: `>0` over baseline strategy for 3 straight windows.
  - Drawdown control: rolling 95p intraday drawdown below configured cap.
  - Latency: 95p decision-to-execution time under guardrail threshold after rollout.
  - Data freshness compliance: ta_signals and market context freshness violations under 1% of windows.
- Profitability guardrail goals:
  - reduce late-stage kill latency by 30% versus current manual path,
  - increase number of hypotheses with complete evidence artifacts by 25% in one cycle.

## Rollout plan

1. Phase A (Discover artifact): publish contracts and hypothesis mapping for implementation stage.
2. Phase B (Discover/Plan handoff): implement schema + validation tests for:
   - evidence continuity,
   - freshness continuity,
   - guardrail budget checks.
3. Phase C (Staged pilot): enable profitability mesh in torghut shadow/limited canary.
4. Phase D: expand to scaled live under controlled capital budgets.

## Rollback and failure behavior

- On metric inversion (expectancy or freshness failure), auto-degrade exposure lane by one level immediately.
- If evidence continuity remains degraded over two checkpoints:
  - auto-halt scaling,
  - force `shadow` state,
  - emit explicit rollback reason referencing gate IDs and metric names.
- All downgrades are logged for manual replay and post-mortem reproducibility.

## Deployment dependencies

- `services/torghut/app/trading/hypotheses.py`: manifest schema extensions and admission policy.
- `services/torghut/app/models/entities.py`: governance/ledger indexing support if needed for budget tracking.
- `services/jangar/src/server/torghut-quant-runtime.ts`: control-plane decisions should respect lane contract outputs.
- `services/jangar/src/server/torghut-quant-metrics.ts`: quality scoring should classify stale metrics as risk blockers.
- New/updated tests:
  - hypothesis schema strictness,
  - profitability ladder transitions,
  - guardrail enforcement and rollback trigger tests.

## Risks and assumptions

- Assumption: regime and market-feature tagging quality remains sufficient for per-regime budgeting.
- Risk: over-concentration in high-performing hypotheses without anti-correlation checks.
  - Mitigation: enforce overlap caps and concentration thresholds.
- Risk: test data drift from execution sources.
  - Mitigation: explicit continuity constraints and freshness windows before scaling.
- Risk: operational skepticism from frequent lane downgrades during early rollout.
  - Mitigation: publish gate thresholds and allow staged confidence windows.

## Handoff to implementation/deployer

Engineering must implement:

- contract fields,
- policy evaluator,
- guardrail budget checks,
- lane downgrade automation and evidence ledger.

Deployer must ensure:

- canary + staged rollout of contract changes in `agents` and `torghut`,
- metrics dashboards for gate transitions,
- rollback switches for auto-degrade behavior.
