# Torghut Quant Profitability Architecture: Evidence-Driven Growth and Guardrails (2026-03-16)

Status: Proposed
Owner: Victor Chen (Jangar/Trading Architecture Liaison)
Related objective: `codex/swarm-jangar-control-plane-plan` (`swarmName: torghut-quant`)

## Summary

This document defines the next architecture layer for profit improvement in Torghut with measurable hypotheses, explicit risk controls, and rollout-safe operations.

The design keeps safety dominant:

- no strategy promotion without confidence + fresh data constraints,
- no capital expansion without guardrails,
- no autonomy rollback on statistical uncertainty.

## Primary problem

Torghut optimization decisions are currently exposed through control-plane indicators (health, execution summaries, alert streams), but promotion decisions are still vulnerable to:

- stale signal quality during regime shifts,
- sample-skew in profitability estimates,
- execution fallback risk not reflected directly in strategy promotion controls.

The result is that performance gains can be delayed or overfit without explicit, testable guardrails at the control-plane level.

## Source assessment

High-risk modules reviewed:

- `services/jangar/src/server/torghut-trading.ts`
  - computes rejection taxonomy and basic funnel counts.
  - does not currently enforce a standardized experiment-tracking contract.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - already emits pipeline lag and status but needs stronger policy linkage to promotion gates.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/snapshot.ts`
  - provides on-demand metric materialization and alert context.
- `services/jangar/src/server/torghut-quant-runtime*`, `*metrics*`, and control-plane tests
  - rich runtime code and tests exist, but promotion gating is spread across multiple callsites and not consolidated as a single architectural control plane policy.

Gaps:

- No single control-plane policy defines minimum profitability evidence per strategy promotion.
- Weak coupling between run-level rejection cause telemetry and strategy-level confidence.
- Promotion logic still relies on manual interpretation for regime-aware guardrails.

## Database/source-data assessment

- Trade and decision rows include:
  - generated/blocked/planned/submitted/fill states,
  - reject reasons,
  - execution metadata.
- Data freshness is exposed in quant health (`metricsPipelineLagSeconds`) and missing-update alarms.
- Migration contract is present for control-plane data consistency and can support additional control-plane policy tables if needed without schema redesign risk.

## Design options

### Option A: Only tune existing heuristics

- Pros: lowest implementation risk.
- Cons: weak proof of incrementality, harder to attribute gains and risk.

### Option B: Add ad-hoc strategy-specific overrides

- Pros: fast local value for a single strategy.
- Cons: inconsistent governance and no reusable evidence envelope.

### Option C: Introduce Quant Control Plane Policy Envelope (selected)

- Pros:
  - unified, auditable promotion contract,
  - measurable hypotheses and confidence gates,
  - explicit rollback behavior tied to risk deltas.
- Cons: moderate implementation scope across quant summary + control-plane APIs.

## Selected design

### 1) Promotion policy envelope

Create an explicit policy object used by engineering and deployer stages:

- `policy_id`
- `strategy_id`
- `hypothesis`
- `primary_metric` (e.g., real PnL per notional, information ratio, execution friction-adjusted alpha)
- `min_effect_size`
- `min_sample_size`
- `confidence_threshold`
- `max_drawdown_delta`
- `max_slippage_bps`
- `max_stale_data_seconds`
- `evaluation_window_hours`
- `guard_rail_mode` (`strict`, `pilot`, `observe`)

The policy envelope must be present before a strategy can be promoted.

### 2) Evidence and replay protocol

- Snapshot and snapshot diffing:
  - baseline: same strategy/account/window at prior revision.
  - challenger: candidate revision.
- Required evidence windows:

1. planning window,
2. out-of-sample confirmation window,
3. post-deploy validation window.

- Decision must include:
  - confidence interval width or equivalent uncertainty estimate,
  - effect size,
  - p-value or Bayesian credibility equivalent (explicitly documented).

### 3) Regime-aware execution guardrails

Attach risk budget controls directly to rollout state:

- market regime labels from existing context feeds,
- adaptive max participation (`participation_cap`) by volatility regime,
- execution fallback severity cap from `reject reason` taxonomy,
- auto-disable triggers for rising stale-data lag and rejected/blocked ratio.

### 4) Controlled deployment modes

Define deployment modes:

- **observe mode**: collect evidence only, no capital changes.
- **pilot mode**: limited capital slice, fast rollback on negative drift.
- **full mode**: full capital allowed only if policy thresholds and risk guardrails pass.

Policy is resolved in control-plane status checks before promotion and in deployment runtime parameters.

## Measurable hypotheses

### Hypothesis H1: Session-aware routing improves net edge

- Claim: adding regime-aware routing from control-plane policy increases execution-adjusted alpha.
- KPI:
  - +12% median IR uplift versus baseline over 14-day sliding windows,
  - +30% reduction in rejected-blocked ratio variance.

### Hypothesis H2: Guarded pilot deployment reduces drawdown reversals

- Claim: pilot-first rollout of strategy revisions reduces adverse drawdown incidents compared with immediate full rollout.
- KPI:
  - 90th percentile intraday drawdown decline by at least 20% for pilot cohort before release.

### Hypothesis H3: Replay confirmation reduces false positives

- Claim: requiring dual-window evidence prevents overfit promotions by 25% in backtest-vs-live delta.
- KPI:
  - confidence score above threshold with stable metrics for two independent windows before full rollout.

## Validation gates

Engineering gate:

- policy envelope validated before merge:
  - required fields complete,
  - effect size and uncertainty thresholds present,
  - fallback modes defined.
- control-plane quant status:
  - `metricsPipelineLagSeconds` within configured guard rail,
  - stale-update alarm not active unless explicit `guard_rail_mode=observe`.

Deployment gate:

- first phase in `pilot` mode:
  - low notional cap,
  - strict max slippage and fill quality checks.
- second phase only after evidence pass for two windows.

Rollback gate:

- immediate rollback when:
  - confidence < threshold,
  - adverse drawdown delta crosses policy limit,
  - stale data exceeds limit for two windows.
- automatic evidence annotation of rollback reason at policy scope level.

## Rollout and rollback expectations

- Rollout cadence:
  - 1. policy definition,
  - 2. pilot run,
  - 3. controlled expansion,
  - 4. full enablement only after two successful windows.
- Rollback is explicit:
  - freeze promotion channel,
  - restore prior revision in quant runtime policy list,
  - reroute to observe-mode defaults.

## Risks

- Hypothesis gating can reduce innovation velocity when thresholds are too strict.
- Regime labels and execution telemetry quality directly impact policy correctness.
- Increased governance overhead if policy authoring becomes manual and slow.

Mitigation:

- pre-compute policy templates,
- provide default pilot envelopes by strategy class,
- automate evidence package generation from existing `torghut` metrics and rejection logs.

## Handoff contract for engineer and deployer

Engineer stage:

1. Implement policy envelope schema and validation pipeline.
2. Emit policy evidence payloads alongside existing quant status endpoints.
3. Add tests for:
   - policy validation failures,
   - replay confirmation gating,
   - rollback triggering.
4. Publish clear evidence URLs/paths with each PR.

Deployer stage:

1. Apply staged rollout config and ensure `observe -> pilot -> full` transitions are reversible.
2. Require two-window pass proof before any full enablement.
3. Keep stage artifact containing:
   - hypothesis, baseline, result window,
   - confidence and risk deltas,
   - final decision and rollback log.
