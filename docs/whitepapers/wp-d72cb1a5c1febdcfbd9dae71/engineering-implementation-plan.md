# Janus-Q Engineering Implementation Plan (Source-Grounded)

- Whitepaper run ID: `wp-d72cb1a5c1febdcfbd9dae71`
- Source paper: `arXiv:2602.19919`
- Repository: `proompteng/lab`
- Related issue: `https://github.com/proompteng/lab/issues/3589`
- Plan status: `ready_for_execution`
- Date (UTC): `2026-02-26`

## 1) Objective

Implement Janus-Q-style event-driven research capabilities on top of the **current** Torghut autonomy/LLM pipeline, without bypassing existing safety and promotion controls.

## 2) Source-Grounded Baseline (Current Torghut)

The implementation must align to these existing contracts and entrypoints:

1. Autonomous lane execution and artifacts:
   - `services/torghut/app/trading/autonomy/lane.py`
   - `run_autonomous_lane(...)` currently emits:
     - `backtest/walkforward-results.json`
     - `backtest/evaluation-report.json`
     - `gates/gate-evaluation.json`
     - `gates/promotion-prerequisites.json`
     - `gates/rollback-readiness.json`
     - `gates/profitability-evidence-v4.json`
     - `gates/profitability-benchmark-v4.json`
     - `gates/profitability-evidence-validation.json`
     - `gates/recalibration-report.json`

2. Gate policy and promotion controls:
   - `services/torghut/app/trading/autonomy/gates.py`
   - `services/torghut/app/trading/autonomy/policy_checks.py`
   - policy file: `services/torghut/config/autonomy-gates-v3.json`
   - live promotion is fail-closed by policy (`gate5_live_enabled: false` in current config).

3. Feature/runtime contracts:
   - `services/torghut/app/trading/features.py`
     - `FEATURE_SCHEMA_VERSION_V3 = 3.0.0`
     - `normalize_feature_vector_v3(...)`
   - `services/torghut/app/trading/autonomy/runtime.py`
     - strategy plugin runtime with declared-feature validation.

4. Scheduler integration:
   - `services/torghut/app/trading/scheduler.py`
   - `_run_autonomous_cycle()` -> `_execute_autonomous_lane()` -> `_apply_autonomy_lane_result()`
   - no-signal fail-closed path already implemented.

5. DSPy compile/eval/promotion contracts:
   - `services/torghut/app/trading/llm/dspy_compile/workflow.py`
   - `services/torghut/app/trading/llm/dspy_compile/schemas.py`
   - artifact contracts already include deterministic hashes:
     - `dataset_hash`, `compiled_prompt_hash`, `artifact_hash`, `reproducibility_hash`, `eval_hash`, `promotion_hash`.
   - metrics policy file exists:
     - `services/torghut/config/trading/llm/dspy-metrics.yaml`

## 3) Scope and Non-Goals

In scope:

1. Add Janus-Q event/CAR research data preparation as deterministic offline/autonomy inputs.
2. Add Janus-Q HGRM reward scaffolding in DSPy compile/eval path.
3. Wire new evidence into existing gate and promotion artifacts.
4. Keep runtime promotions bounded to shadow/paper unless existing policies explicitly allow otherwise.

Out of scope:

1. Enabling live trading promotion.
2. Replacing current autonomy gate framework.
3. Bypassing deterministic artifacts or audit persistence.

## 4) Implementation Workstreams

## 4.1 Janus Event/CAR Research Inputs

Changes:

1. Add event/CAR research helpers under `services/torghut/app/trading/alpha/`:
   - deterministic event record schema (news event metadata + CAR fields),
   - CAR calculation utilities for offline replay datasets,
   - dataset manifest generation for hashable provenance.

2. Keep production ingest path unchanged:
   - `WS -> Kafka -> Flink TA -> ClickHouse -> trading service` remains source of truth.

3. Feed Janus research outputs into autonomy artifact flow via explicit files and hashes consumed by lane/reporting paths.

## 4.2 Janus HGRM Reward Scaffolding in DSPy Path

Changes:

1. Add Janus reward composition utilities in `services/torghut/app/trading/llm/dspy_compile/`:
   - direction gate score,
   - event-type consistency gate,
   - cost-aware pnl component,
   - magnitude/process shaping,
   - final hierarchical composition.

2. Extend DSPy compile/eval metric bundles (without breaking schemas in `schemas.py`) to carry Janus-specific reward metrics and reproducibility references.

3. Reuse existing `build_compile_result`, `build_eval_report`, `build_promotion_record`, and `write_artifact_bundle` to keep hash contracts stable.

## 4.3 Gate and Promotion Evidence Wiring

Changes:

1. Extend `run_autonomous_lane(...)` in `services/torghut/app/trading/autonomy/lane.py` to inject Janus evidence into:
   - `profitability_evidence_payload`,
   - `gate_report_payload["promotion_evidence"]`,
   - promotion prerequisite checks (`evaluate_promotion_prerequisites`).

2. Keep current gate IDs and promotion semantics intact:
   - do not remove or relax `gate0/1/2/6/7` checks,
   - keep uncertainty and rollback readiness requirements.

3. Ensure missing Janus evidence yields deterministic fail-closed reason codes in gate outputs.

## 4.4 Runtime and Safety Integration

Changes:

1. Keep strategy runtime and feature contracts compatible with `FeatureVectorV3`.
2. Any Janus feature extension must preserve:
   - existing required fields,
   - declared-feature validation behavior in `autonomy/runtime.py`.
3. Preserve scheduler fail-closed behavior (no signal, stale continuity, universe unavailable).

## 5) Milestones

## M1 (Week 1-2): Deterministic Janus Research Baseline

1. Event/CAR helper modules added and unit-tested.
2. Dataset manifest + hashing path integrated.
3. Janus reward scaffold added to DSPy compile metric bundles.

## M2 (Week 3-4): Gate-Compatible Evidence

1. Lane emits Janus evidence through existing gate artifacts.
2. Promotion prerequisite checks consume Janus evidence and fail closed when absent.
3. Regression checks confirm no live-promotion bypass.

## M3 (Week 5+): Controlled Paper/Shadow Candidate Rollout

1. End-to-end autonomy cycle runs with Janus evidence present.
2. Recommendation artifacts remain auditable and reproducible.
3. Promotion remains bounded by current policy files and approval-token requirements.

## 6) Acceptance Criteria

1. Determinism:
   - repeated runs with same inputs produce stable hash chain for DSPy + lane artifacts.
2. Safety:
   - no path enables live promotion unless existing policy/token gates allow it.
3. Evidence:
   - gate artifacts include Janus evidence references or explicit missing-evidence reason codes.
4. Compatibility:
   - existing autonomy and DSPy tests remain green; new Janus tests added.

## 7) Test Plan (Required)

At minimum add/extend:

1. `services/torghut/tests/test_llm_dspy_workflow.py` for Janus reward metric bundle and hash stability.
2. `services/torghut/tests/test_autonomy_gates.py` for fail-closed reasons when Janus evidence is missing.
3. `services/torghut/tests/test_autonomy_runtime.py` for feature/runtime compatibility.
4. `services/torghut/tests/test_trading_scheduler_autonomy.py` for scheduler-cycle integration expectations.

## 8) Execution Instructions for AgentRun

When implementing this plan:

1. Work from `main` to a `codex/whitepaper-b1-*` branch.
2. Keep changes constrained to source-grounded modules above.
3. Update this plan file with milestone completion notes.
4. Open PR with test evidence and artifact examples.
5. Do not enable live trading in this implementation PR.
