# Torghut Trading Profitability via Hypothesis-Proof Mesh and Capital Guardrails (2026-03-15)

## Status

Status: Proposed
Date: 2026-03-15
Scope: Torghut readiness and promotion architecture
Mission: jangar-control-plane / discover

## Executive summary

Torghut currently computes many readiness signals from aggregate, reset-prone counters and infers freshness through expensive or lossy paths. This creates profitable decision ambiguity: capital-stage transitions are gated in aggregate even when evidence is hypothesis-variant, and a broad Jangar watch-reliability delay can suppress all hypothesis promotion at once.

This design introduces a **Hypothesis Proof Mesh**: hypothesis-scoped, persisted proof bundles that combine freshness, evidence lineage, and risk continuity metrics. Jangar remains the execution governor, but it consumes richer, bounded, and testable proof units instead of aggregate runtime counters.

## Assessment evidence summary

### Cluster assessment

- Torghut services are mostly running, but probe instability exists:
  - `pod/torghut-00134-deployment...` had readiness/liveness probe timeouts.
- `ErrorNoBackup` for torghut restore object indicates restoration observability debt and recovery coupling.

### Source assessment

- `services/torghut/app/trading/hypotheses.py`
  - hypothesis readiness currently uses shared counters:
    - `feature_batch_rows_total`
    - `drift_detection_checks_total`
    - `evidence_continuity_checks_total`
    - `signal_lag_seconds`
    - `market_context_freshness`
  - readiness blockers derive from these counters globally and aggregate across all hypotheses.
  - `jangar_dependency_quorum.decision == delay` contributes broad blockers to every hypothesis.
- `services/torghut/app/main.py` compiles hypothesis payloads but returns only aggregate summary counters in many external paths.
- `services/torghut/tests/test_verify_quant_readiness.py` and `test_policy_checks.py` validate schema and artifact presence, but do not validate a hypothesis-scoped proof ledger.

### Database/data assessment

- Jangar owns `torghut_control_plane.quant_*` tables for latest/series/health snapshots, but there is no dedicated hypothesis-proof table in the control-plane schema.
  - `services/jangar/src/server/migrations/20260212_torghut_quant_control_plane.ts`
  - `services/jangar/src/server/db.ts`
- Torghut runtime has rich trade/execution tables, but execution-ready profitability truth is spread across many paths and not assembled into a single hypothesis-level authoritative payload.
- There is no direct evidence gap in migration consistency from source, but there is a **schema-contract gap**: we lack structured persistence for proof windows and freshness lineage that can survive pod restarts.

## Problem statement

1. **Counter reset behavior creates non-deterministic readiness.**
   - reset-prone counters can become zero and temporarily suppress promotion even when historical evidence is healthy.
2. **Aggregation hides per-hypothesis risk.**
   - one hypothesis under stress can force a broad outcome that does not preserve per-strategy evidence.
3. **Dependence on broad Jangar delay reasons causes blanket suppression.**
   - `jangar_dependency_delay` currently impacts every hypothesis equally, even when local evidence is strong.
4. **Freshness evidence path is fragmented.**
   - readiness and profitability checks can still rely on on-demand joins over heavy telemetry.

## Alternatives considered

### Option A – Tune thresholds and thresholds only

- **Idea**: adjust `requirements` and counters; keep current aggregate model.
- **Pros**: quick and low code churn.
- **Cons**: still no per-hypothesis proof, still opaque to post-mortems.

### Option B – Move all readiness into Jangar

- **Idea**: make Jangar the exclusive promoter of hypothesis truth.
- **Pros**: clear ownership.
- **Cons**: increases coupling and execution blast radius on control-plane errors.

### Option C – Selected: hypothesis proof mesh + guarded promotion coupling

- **Idea**: keep execution truth in Torghut, but produce hypothesis proof bundles and ledgered freshness contracts consumed by Jangar.
- **Pros**: improves determinism, preserves failure boundaries, and increases auditability.
- **Cons**: requires schema and contract work plus rollout discipline.

## Decision

Select **Option C**.

## Proposed architecture

### 1) Hypothesis proof contracts (Torghut producer)

Introduce producer-authored contracts for readiness and profitability proof:

- `torghut.hypothesis-proof-bundle.v1`
  - `schema_version`
  - `hypothesis_id`, `strategy_id`, `lane_id`, `strategy_family`
  - `window_start`, `window_end`, `sample_count`, `symbol_scope`
  - `state`, `capital_stage`, `capital_multiplier`
  - `readiness`: blockers, blockers_by_source, reasons
  - `proof`: metrics snapshot references, simulation references, evidence hashes
  - `freshness`: age_seconds, as_of, source, quality_score
  - `evidence`: list[contract]
  - `risk`: drawdown, slippage, fallback_rate, execution_failure_modes
  - `decision`: promotion_eligible, rollback_required, confidence`
- `torghut.hypothesis-freshness-ledger.v1`
  - `hypothesis_id`, `component`, `as_of`, `freshness_seconds`, `status`, `reason`, `reason_codes[]`, `source`.

### 2) Producer surfaces

- Add bounded, TTL-aware endpoints on Torghut:
  - `/trading/control-plane/hypothesis-proofs`
  - `/trading/control-plane/freshness-ledger`
- Each endpoint emits additive JSON with per-hypothesis arrays and compact summaries.

### 3) Jangar consumer semantics

- Jangar consumes proof bundles as primary input for hypothesis promotion summary.
- Keep `dependency_quorum` signal but separate it from hypothesis-local evidence.
- Transition rule:
  - if proof bundle has blockers -> hypothesis blocked
  - if proof bundle healthy and risk gates pass -> hypothesis eligible
  - if proof age > threshold -> evidence freshness warning, not global block unless sustained.

### 4) Guardrail-by-stage profitability ladder

Define explicit, measurable hypotheses to gate progression:

- **H1 (signal quality)**
  - `evidence freshness age < 600s`, `proof quality >= 0.85`, `freshness continuity violations < 0.05`
- **H2 (risk floor)**
  - `post_cost_expectancy_bps_proxy >= manifest expected bps`
  - `evidence_continuity_age_minutes <= policy max` and evidence continuity checks present.
- **H3 (execution health)**
  - fallback rate and adapter mismatch below policy per-symbol thresholds
- **H4 (capital safety)**
  - rollback_required only when fresh risk windows indicate repeated drawdown or execution regressions.

### 5) Profitability objective and guardrail telemetry

- Track measurable outcomes over a sliding window:
  - `hypothesis_promotion_latency_p50`
  - `proof_staleness_p95`
  - `promotion_false_positive_rate`
  - `rollback_trigger_precision`
  - `capital_stage_sustain_duration`

These become direct rollout KPIs for phase progress and profitability confidence.

## Implementation slices

### Slice 1 – Torghut proof emitter

- add schema validators and persistence for `hypothesis-proof-bundle` and ledger rows.
- emit durable proof every readiness window and promotion check.

### Slice 2 – Jangar consumers

- extend status/policy surfaces to ingest proof mesh as first-class contracts.
- adjust failure decomposition so one failing hypothesis can carry local reasons without global suppression.

### Slice 3 – Guardrail enforcement

- wire proof-based gates in promotion candidate paths.
- preserve emergency stop behavior and recovery loops.

### Slice 4 – Evidence and rollout runbooks

- codify commands and acceptance checks for proof freshness and promotion transitions.

## Validation gates

### Engineer gates

1. A failing hypothesis proof bundle yields reasoned per-hypothesis blocker in status payload.
2. A fresh, high-quality proof bundle permits promotion eligibility even when non-local counters are low/noisy.
3. Stale proof entries move to `stale=true` and include explicit age-based reason, avoiding silent fallback to zero-defaults.

### Deployer gates

1. `/trading/control-plane/hypothesis-proofs` returns evidence for each loaded hypothesis and last successful proof hashes.
2. A staged hypothesis can move from canary to scaled stage only when guardrail KPIs pass and no freshness staleness breaches are active.
3. Rollback behavior remains deterministic and traceable via proof ledger references.

## Rollout and rollback

- Rollout increments:
  1. Publish Torghut proof contract docs + validators behind staged flag.
  2. Enable proof ingestion in Jangar test environment.
  3. Enforce hypothesis-local gating in a staged rollout.
- Rollback:
  1. Retain old aggregate path as compatibility read.
  2. Disable proof-based gating before removing legacy aggregate fallback.
  3. Keep proof ledger writes read-only for observability even during rollback.

## Risks and mitigations

- **Risk**: proof generation failures can create blind spots.
  - Mitigation: dual-signal mode with explicit stale markers and safe fail semantics.
- **Risk**: schema adoption lag across environments.
  - Mitigation: versioned contract and strict backward-compatible consumers.
- **Risk**: too strict gates can suppress profitable experimentation.
  - Mitigation: staged gate levels per stage and explicit override documentation for incident response.

## Non-goals

- This design does not replace risk controls or kill switches.
- It does not promise profitability uplift by contract definition alone; it defines measurable proof required before capital increases.
