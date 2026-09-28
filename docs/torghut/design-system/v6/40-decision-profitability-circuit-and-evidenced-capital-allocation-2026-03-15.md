# 40. Decision-Quality and Profitability Circuit for Torghut Trading (2026-03-15)

## Objective

Increase profitable decision throughput by introducing a staged, evidence-first profitability circuit that converts live/training signals into controlled capital allocation decisions.

This design is for the `torghut-quant` lane and focuses on measurable hypotheses plus guardrails that prevent scale before signal quality and execution truth are proven.

## Current Assessment Snapshot

- `api/torghut/trading/strategies` currently exposes two strategies:
  - `4b0051ba-ae40-43c1-9d8b-ad5a57a2b8f6` (`intraday-tsmom-profit-v2`, enabled)
  - `a4b5ba1c-d749-4522-bdab-9b26d2fa68de` (`macd-rsi-default`, disabled)
- `api/torghut/trading/control-plane/quant/health` for active strategy returns:
  - `status=ok`,
  - `latestMetricsCount=0`,
  - `runtimeEnabled=true`,
  - `stages=[]` (no active stage lag metrics in window).
- `api/torghut/trading/summary?strategy_id=...&day=2026-03-15` returns:
  - `decisions.generatedCount=0`,
  - `executions.filledCount=0`,
  - `submissionFunnel.submittedCount=0`,
  - `rejections.rejectedCount` with dominant blockers (`symbol_capacity_exhausted`, `qty_below_min`),
  - runtime profitability caveat flags indicating evidence is proxy-heavy and not profitability-certain.
- `api/agents/control-plane/status?namespace=agents` reports empirical services with `empirical:jobs` degraded in `namespaces[0]`.
- `series` endpoint for active strategy returns an empty series window when queried with the default account and 24h bounds.

## Problem Definition

The system has solid control-plane plumbing but weak trading action throughput and weak decision-quality assurance in the paper-to-live bridge.

Current pain points:

1. **Paper signal generation is low despite runtime health.**
2. **Execution quality evidence is insufficiently tied to promotion decisions.**
3. **Symbol/qty rejections dominate business activity**, suggesting the strategy is blocked before it can become profitable rather than tested in a controlled capital ladder.
4. **Empirical job freshness is degraded**, so strategy confidence can be computed on incomplete data.

## Source Architecture Review

Relevant high-impact modules:

- `services/jangar/src/server/torghut-trading.ts` and
  `services/jangar/src/server/torghut-symbols.ts` shape market context and symbol constraints.
- `services/jangar/src/server/torghut-quant-runtime.ts` and
  `services/jangar/src/server/torghut-quant-runtime-materialization` define runtime and materialization behavior.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/*` provide health, summary, and time-series signals for gating promotion.
- `services/jangar/src/server/__tests__/torghut-trading-summary.test.ts` already tracks blocked decision causes and funnel metrics, which can be extended for new profitability gates.

Gap from source view:

- No explicit profitability allocator circuit that transitions capacity from `shadow` to broader capital bands on measured evidence.
- No closed-form hypothesis schema that requires both pre-trade and post-trade evidence to move a strategy across bands.
- No single source document that binds rejection reasons to adaptive remediation actions.

## Architecture Alternatives

### Option A — Tune existing thresholds

- **Pros**: quick and minimal risk to code.
- **Cons**: does not solve root issue that no hypothesis has to meet staged performance truth before scaling.

### Option B — Add execution-side controls only

- **Pros**: can prevent bad executions and protect capital immediately.
- **Cons**: still allows promotion of weak hypotheses at shadow levels; no evidence of profitability learning.

### Option C — Introduce a hypothesis-led profitability circuit with capital-stage ladder (recommended)

- **Pros**: highest signal quality and auditable path from decision signal -> evidence -> promotion.
- **Cons**: larger implementation scope and requires tighter coupling between Torghut runtime + Jangar artifact contract.

## Decision

Adopt **Option C**.

## Target Design

### 1) Hypothesis Ledger and Capital Ladder

Create a unified lifecycle:

1. **Hypothesis definition**
   - strategy_id + objective + expected effect size + risk budget.
2. **Pilot (`shadow`)**
   - auto-enter with bounded capital budget and strict rejection telemetry.
3. **Canary (`paper`)**
   - only if shadow proves directional signal quality and capacity constraints are not structural.
4. **Scale (`live`)**
   - only if paper-to-live divergence and post-cost metrics validate within guardrails.

### 2) Measurable Hypotheses and Guardrails

#### H1: Decision Lift and Throughput

- Hypothesis passes to `paper` if in 24h:
  - `decisions.plannedCount >= 300` and `decisions.generatedCount >= 300`,
  - `plannedCount - blockedCount >= 120`,
  - ratio(`blockedCount`, `generatedCount`) < `0.30`.
- Fail-safe if repeated `qty_below_min` or `symbol_capacity_exhausted` exceed `2/3` of blocked reasons.

#### H2: Execution and Cost Sanity

- Hypothesis passes canary if over 7d rolling window:
  - `executionCount >= 5`,
  - `avgAbsSlippageBps <= 2x` historical baseline for the same symbol class,
  - realizedPnL proxy must trend non-negative for 3 consecutive windows with no missing materialized metrics.

#### H3: Live Proof Stability

- Promotion to wider live bands requires 72h observed live window with:
  - `max drawdown >= -1.5%` at portfolio level,
  - `decision_count >= 100`,
  - rolling sharpe above `0` for 2 consecutive windows,
  - no unresolved empirical freshness degradation.

### 3) Evidence-First Gate Chain

Each ladder transition requires a single evidence manifest with:

- strategyId + hypothesisId,
- decision funnel snapshot,
- rejection split and top reasons,
- replay or time-series proof references,
- dependency gate status,
- capital band transition action and timestamp.

### 4) De-risking the Execution Boundary

- Introduce pre-allocation capacity checks that enforce symbol-level exposure and minimum order quantity before strategy-wide scaling.
- Route repeated rejection clusters into a remediation task:
  - `symbol_capacity_exhausted` -> symbol universe prune/refactor task,
  - `qty_below_min` -> order sizing policy task.
- Keep the strategy active in `shadow` until remediation and revalidation complete.

## Validation Gates

### Scientist / Algorithm Gate

- new hypotheses only if baseline comparator exists for same strategy and window,
- no synthetic metrics permitted for gating;
  all required fields must be non-empty and timestamped in DB.

### Engineer Gate

- schema-level tests for hypothesis manifest,
- tests proving hypothesis transitions require all gate conditions.
- regression test proving rejection clusters trigger remediation task references.

### Deployer Gate

- no transition from `shadow` to `paper` without a completed manifest,
- no transition from `paper` to live without live observation evidence and dependency clearance,
- deployment rollback if live proof drops below guardrails within 72h.

## Rollout Plan and Runtime Expectations

### Recommended phased rollout

1. Add hypothesis manifest + evidence writer.
2. Enforce `paper` promotion gate checks only.
3. Add `live` scale gates after one week stable evidence collection.
4. Integrate rejection clustering tasks into operator runbook for recurring blockage reasons.

### Rollback Expectations

- If any hypothesis fails at ladder transition, revert to previous capital band immediately and keep runtime enabled only for safe minimum capacity.
- Keep strategy enabled for observation in reduced mode if it is non-degraded but under-performing.
- Surface the failed hypothesis and reason in explicit handoff artifacts.

## Risks and Mitigations

- **Over-filters can choke discovery.** Mitigation: minimum baseline thresholds are soft-started with controlled exceptions and tracked with audit reasons.
- **Data freshness gaps can inflate false negatives.** Mitigation: include freshness checks as hard preconditions.
- **Hypothesis churn may increase operational overhead.** Mitigation: periodic clustering and auto-summarized remediation recommendations.

## Success Criteria

- paper transition only when all H1/H2 conditions are met and evidence bundle is complete.
- zero `live` transitions without completed 72h live proof.
- measurable drop in `topBlockedReasons` dominated by capacity/qty classes after remediation tasks run.
- sustained non-zero `decisions.generatedCount` and `executions.filledCount` for at least one strategy.

## Relation to Current Roadmaps

This design complements:

- `docs/torghut/design-system/v6/31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md`
- `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`

and should be treated as the next-step ladder and gates update.
