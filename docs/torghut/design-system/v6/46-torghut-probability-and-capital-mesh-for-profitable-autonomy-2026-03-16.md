# 46. Torghut Hypothesis-Led Profitability Mesh and Capital Guardrail Architecture (2026-03-16)

## Status

Status: Approved for implementation by architecture lane (`discover` -> `plan`)
Date: `2026-03-16`

## Objective

Increase Torghut profitability outcomes with a measurable, lane-aware profit hypothesis system where every capital movement is tied to explicit evidence, confidence, and risk budgets. The architecture must make profitability improvements auditable and automatically reversible when guardrails are breached.

## Assessment evidence captured

### Cluster and control-plane surface

- `torghut` runtime pods are operationally mixed: market-context and TA batch jobs complete regularly, while some run-template jobs remain in error states during stale/failure windows.
- `Ready`/`status` trust for trading control is now coupled to Jangar swarm phase states (`StageStaleness`, freeze), but profitability and capital allocation decisions still rely on narrower or global signals in places.
- rollout context (`canary` and merge strategies) exists in swarm specs and canary analysis but currently does not express per-hypothesis lane budgets or independent proof freshness classes.

### Source architecture assessment

- `services/torghut/app/trading/hypotheses.py`
  - has hypothesis modeling but currently lacks explicit cross-regime capital mesh fields and enforceable evidence continuity contracts.
- `services/torghut/app/trading/completion.py`
  - already includes `DOC29_PAPER_GATE`, `DOC29_LIVE_CANARY_GATE`, and `DOC29_LIVE_SCALE_GATE` references; these are a strong base for formal promotion gates.
- `services/torghut/app/trading/empirical_jobs.py`
  - job and run signal generation pathways are suitable for evidence lineage but not yet used as first-class capital budget inputs.
- `services/jangar/src/server/torghut-quant-status.ts` and `services/jangar/src/server/torghut-quant-metrics.ts`
  - already surface operational signals needed for handoff but need explicit profit-mesh handoff fields.

### Data/schema/freshness assessment

- Live DB access from controller-runtime context is limited, so direct in-cluster query verification is constrained.
- Existing schema surfaces for completion traces and empirical jobs are present in source and can be extended with proof-window metadata.
- Evidence continuity currently depends heavily on source-local checks; architecture requires explicit persisted proof-window fingerprints and guardrail budgets to avoid ambiguous merges.

## Problem and growth objective

Profitability experiments remain partially manual in final capital routing: a promising signal in one context can implicitly affect shared decision channels. Without regime-aware budgets and continuity contracts, profitable lane transitions can be hard to attribute and difficult to reverse safely.

The objective is to move from implicit “good enough” gating to explicit hypothesis-led capital routing with measurable uplift requirements and auto-demotion rules.

## Alternatives considered

### Option A — Strengthen current gates only

- Tighten thresholds and add more counters but keep global promotion path.
- Lower risk, but no per-hypothesis evidence ownership or autonomy scaling control.

### Option B — Static capital buckets by day/session

- Route capital per-regime with fixed percentages.
- Easy rollback but too rigid for market shifts and less effective in multi-hypothesis scaling.

### Option C — Hypothesis and proof mesh with autonomous profitability budgets (chosen)

- Make every live capital action depend on hypothesis-level evidence, sample continuity, and guardrails.
- Allows rapid innovation while bounding loss concentration.

## Decision

Adopt **Option C**, implemented as a staged profitability mesh.

## Proposed architecture

### 1) Hypothesis ledger v2

Define explicit candidate contract fields:

- `hypothesis_id`, `strategy_id`, `variant_id`.
- `market_regime`: `open`, `pre_market`, `volatile`, `cross_asset`.
- `expected_signal`: target metric and uplift direction.
- `sample_plan`: symbol universe, holdout split, walk-forward chunking, minimum sample floor.
- `evidence_bundle`: references to completion traces, run IDs, and control-plane evidence IDs.
- `profitability_score`: expected and realized uplift, p95/p99 confidence.
- `freshness_state`: freshness score with decay windows and expiry policy.
- `risk_budget`: max drawdown increment, max turn-over increase, concentration cap.
- `degrade_plan`: automatic state demotion and throttle actions.

### 2) Multi-lane capital mesh

Each hypothesis follows lane flow:

1. `shadow`
2. `canary`
3. `scaled`
4. `decommissioned`

Transitions require:

- completed simulation proof window + live canary proof window continuity,
- minimum confidence thresholds per regime,
- risk budgets above budget and below breach thresholds,
- cross-regime stability check (no single-regime-only overfit).

### 3) Guardrail set and kill-switch contract

Global guardrails enforced per hypothesis and per mesh:

- drawdown control breach
- reject-ratio breach
- slippage percentile breach
- latency percentile breach
- concentration overlap breach

Violation handling:

- single-window warning => lane cooldown,
- two consecutive windows => demotion one lane,
- three consecutive windows => hard stop and auto-halt.

### 4) Jangar↔Torghut handoff contract

A Torghut lane state must expose:

- `lane_state`, `evidenceContinuityScore`, `marketRegimeCoverage`, `riskUtilization`, `nextDecisionWindow`.

Jangar rollout and ready checks should treat `lane_state` and guardrail breaches as scoped rather than global blockers, enabling one hypothesis lane to degrade while other lanes continue safely within budgets.

### 5) Profitability evidence persistence

Persist structured proof windows in a database-backed ledger with immutable references:

- completion trace IDs,
- empirical job IDs,
- control-plane trust snapshots,
- reason codes for each gate result.

## Validation gates

### Engineering gates

- Schema migration covering hypothesis ledger v2 and proof window metadata.
- Unit tests for:
  - stale evidence -> no lane promotion,
  - repeated breach -> demotion ladder,
  - cross-regime stability guard.
- Regression tests for lane transition matrix and capital allocations by regime.

### Deployer gates

- One controlled run where two hypotheses share the same symbol cohort.
- Confirm no cross-lane leak from `degraded` hypothesis to `scaled` lane.
- Validate automatic demotion after two consecutive breaches with evidence chain present.
- Validate that no auto-allocation occurs when evidence continuity is below configured minimum.

## Rollout and rollback expectations

### Engineer stage

- Implement hypothesis ledger v2 in `services/torghut/app/trading/hypotheses.py` and `services/torghut/app/completion.py`.
- Add schema-backed proof window persistence + query surface used by status contract.
- Add staged migration in `services/jangar/src/server/torghut-quant-status.ts` for lane-state and risk budget outputs.

### Deployer stage

- Enable shadow+canary for at most two hypotheses in first cycle.
- Keep one live canary cap until two consecutive successful windows.
- Escalate to scaled only through approved evidence continuity and no active guardrail breach.

## Rollback and recovery

- On two-window evidence drop, auto-demote to shadow and freeze scaling for affected hypothesis.
- On budget-critical breach, move hypothesis to `decommissioned` and require new hypothesis_id to resume.
- Re-enable only via explicit stage handoff with fresh evidence package.

## Risks and tradeoffs

- Strong guardrails can delay profitable deployment while data accumulates.
- Per-hypothesis ledgers increase operational bookkeeping but improve causality and auditability.
- False-negative risk if markets regime partitioning is too strict; mitigate with minimum viable evidence windows.

## Acceptance criteria

- no global capital routing is upgraded without explicit hypothesis-level proof continuity,
- any scaled hypothesis has evidence continuity across at least one full regime pair,
- all lane transitions emit machine-readable evidence IDs and gate decision reasons,
- rollback path demotes in deterministic sequence under two consecutive breach windows.

## Merge-ready implementation scope

- Torghut modeling and completion:
  - `services/torghut/app/trading/hypotheses.py`
  - `services/torghut/app/completion.py`
  - `services/torghut/app/trading/empirical_jobs.py`
- Cross-plane status and metrics:
  - `services/jangar/src/server/torghut-quant-status.ts`
  - `services/jangar/src/server/torghut-quant-metrics.ts`
- Docs and handoff updates:
  - `docs/torghut/design-system/v6/index.md`
  - `services/jangar/src/server/README.md` if API contract surfaces are exposed.
