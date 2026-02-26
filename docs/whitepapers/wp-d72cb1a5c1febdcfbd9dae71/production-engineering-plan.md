# Janus-Q Production Engineering Plan

- Run ID: `wp-d72cb1a5c1febdcfbd9dae71`
- Whitepaper: `arXiv:2602.19919`
- Repository: `proompteng/lab`
- Baseline commit: `51810e18` (branch `codex/whitepaper-b1-c1febdcfbd9dae71-plan-20260226`)
- Last updated (UTC): `2026-02-26`

## 1) Objective

Implement Janus-Q in Torghut as a production-safe, reproducible, and auditable capability that can be promoted from research to paper trading and then to controlled live canary only after statistically defensible performance and operational reliability gates are met.

## 2) Current Baseline (What Exists Today)

M1 scaffolding already exists in code:

1. Deterministic event/CAR artifact generation and HGRM reward scaffold:
   - `services/torghut/app/trading/autonomy/janus_q.py`
2. Lane integration and artifact emission:
   - `services/torghut/app/trading/autonomy/lane.py`
3. Gate6 fail-closed checks for Janus evidence:
   - `services/torghut/app/trading/autonomy/gates.py`
4. Promotion prerequisite checks for Janus artifacts/evidence:
   - `services/torghut/app/trading/autonomy/policy_checks.py`
5. Policy defaults requiring Janus evidence:
   - `services/torghut/config/autonomy-gates-v3.json`
   - `services/torghut/config/autonomous-gate-policy.json`
6. Regression tests:
   - `services/torghut/tests/test_janus_q_scaffold.py`
   - `services/torghut/tests/test_autonomy_gates.py`
   - `services/torghut/tests/test_policy_checks.py`
   - `services/torghut/tests/test_autonomous_lane.py`
   - `services/torghut/tests/test_governance_policy_dry_run.py`

## 3) Production Scope

In scope:

1. Replace M1 proxy logic with paper-aligned event/CAR and HGRM semantics.
2. Add reproducible SFT -> GRPO training pipeline and model registry lineage.
3. Add statistically rigorous multi-window evaluation and promotion evidence.
4. Integrate inference into autonomy lane with deterministic fallbacks.
5. Add operational controls: observability, drift monitors, kill-switches, rollback runbooks.
6. Controlled deployment path: research -> paper -> canary live.

Out of scope (this plan):

1. Full market-universe expansion beyond agreed pilot scope.
2. Unbounded autonomous live rollout without explicit human approval gates.
3. Removing existing deterministic fallback strategy.

## 4) Milestones and Exit Criteria

## M0 - Safety and Contract Alignment (1 week)

Deliverables:

1. Resolve policy inconsistency so Janus evidence checks and Janus artifact requirements are controlled by the same gate switches.
2. Formalize v1 JSON contracts for:
   - `janus-event-car-v1`
   - `janus-hgrm-reward-v1`
   - `janus-q-evidence-v1`
3. Add compatibility tests for policy toggle combinations.

Exit criteria:

1. All policy toggle matrices pass in CI.
2. No contradiction between required artifacts and evidence checks.
3. Backward-compatible behavior documented for older artifacts.

## M1 - Data and Labeling Fidelity Upgrade (2 weeks)

Deliverables:

1. Upgrade event/CAR generation from proxy to paper-aligned specification:
   - explicit abnormal return model
   - factor-neutralized return path
   - deterministic event window policy
2. Event taxonomy normalizer and validation (unknown event handling).
3. Data lineage manifest:
   - dataset snapshot hash
   - schema hash
   - generation code hash
   - run configuration hash

Exit criteria:

1. Determinism replay test: identical inputs yield identical manifests.
2. Event coverage and schema validity thresholds pass.
3. Lineage manifest generated for every run.

## M2 - HGRM Reward Semantics (2 weeks)

Deliverables:

1. Implement configurable reward components aligned to paper equations:
   - direction gate
   - event-type gate
   - cost-aware PnL
   - magnitude shaping
   - process reward
2. Reward decomposition logs per sample.
3. Sanity-check simulation suite for reward monotonicity and clipping boundaries.

Exit criteria:

1. Reward decomposition trace available for audit on every training run.
2. Property tests for gate sign behavior and clipping pass.
3. No undefined/NaN reward values in training traces.

## M3 - Training and Evaluation Platform (3 weeks)

Deliverables:

1. Reproducible SFT pipeline:
   - frozen prompt templates
   - exact training config and seeds
2. Reproducible GRPO pipeline with checkpoint lineage.
3. Evaluation package:
   - rolling walk-forward windows
   - regime-sliced metrics
   - bootstrap confidence intervals for SR/DA/ETA deltas
4. Candidate report extension with significance evidence.

Exit criteria:

1. Re-run reproducibility within tolerance across two independent executions.
2. Candidate reports include confidence intervals and significance metadata.
3. Baseline-vs-candidate comparison reproducibly generated from manifests.

## M4 - Runtime Integration and Paper Trading Pilot (2 weeks)

Deliverables:

1. Janus-aware decision service integration into autonomy lane.
2. Runtime controls:
   - timeout budgets
   - deterministic fallback route
   - stale-event suppression
3. Operational metrics and alerts:
   - janus evidence completeness
   - fallback ratio
   - inference latency
   - gate fail reasons

Exit criteria:

1. Paper-trading dry run completes without safety violations.
2. Fallback behavior is deterministic and audited.
3. On-call runbook validated in simulation drills.

## M5 - Controlled Live Canary (2 weeks minimum observation)

Deliverables:

1. Limited-scope canary configuration:
   - symbol allowlist
   - notional caps
   - strict kill-switch and rollback
2. Daily governance review artifact with:
   - performance drift
   - risk breaches
   - gate pass/fail trends

Exit criteria:

1. Canary SLOs satisfied for required observation window.
2. No unresolved severity-1 or severity-2 incidents.
3. Explicit human approval for broader rollout.

## 5) Engineering Workstreams

| Workstream | Primary Files/Systems | Owner Role | Output |
| --- | --- | --- | --- |
| Policy and gates | `autonomy/gates.py`, `autonomy/policy_checks.py`, gate policy JSON | Trading Platform | Consistent fail-closed governance |
| Janus data pipeline | `autonomy/janus_q.py`, artifact manifests | Research Eng | Deterministic event/CAR + reward artifacts |
| Training stack | training jobs, model registry, run manifests | ML Platform | Reproducible SFT/GRPO candidates |
| Evaluation rigor | report generation, significance tooling | Quant Research | Promotion-grade evidence package |
| Runtime serving | lane runtime, inference path, fallback policies | Runtime Eng | Reliable paper/live execution path |
| Observability and ops | metrics, alerts, runbooks, on-call drills | SRE/On-call | Operable production system |

## 6) Quality Gates (Promotion Requirements)

Mandatory for `shadow -> paper`:

1. Gate0/1/2/6/7 pass with Janus evidence complete.
2. Reproducibility manifests present and hash-consistent.
3. Statistical evidence attached (confidence intervals and baseline delta significance).

Mandatory for `paper -> live-canary`:

1. Paper-trading stability window completed.
2. Latency/error/fallback SLOs within threshold.
3. Human approval token with rollback drill completion proof.

## 7) SLOs and Operational Metrics

Core SLOs:

1. Inference timeout rate < 0.5% (5-minute windows).
2. Deterministic fallback activation < 5% during normal market hours.
3. Janus evidence completeness = 100% for promotable runs.
4. Zero unreviewed gate bypasses in production.

Core dashboards:

1. `janus_event_count`, `janus_reward_count`, `janus_evidence_complete`.
2. `autonomy_gate_fail_total{gate_id,reason}`.
3. `autonomy_fallback_ratio`, `autonomy_inference_latency_ms_p95`.
4. `promotion_attempt_total{target,status,reason}`.

## 8) Test Strategy

1. Unit tests:
   - reward component correctness
   - schema/version guards
   - policy toggle matrix behavior
2. Property tests:
   - determinism and hash stability
   - reward gate monotonicity under sign flips
3. Integration tests:
   - end-to-end lane artifact generation
   - promotion checks with synthetic and real fixtures
4. Replay tests:
   - exact output reproducibility from archived snapshots
5. Failure injection:
   - missing artifacts
   - malformed schema
   - inference timeout and fallback takeover

## 9) Rollback and Incident Plan

1. Immediate mitigation:
   - set `TRADING_ENABLED=false` for Torghut if safety breach.
2. Strategy rollback:
   - revert candidate patch via GitOps.
3. Janus pathway disable:
   - force deterministic fallback by policy toggle.
4. Post-incident requirements:
   - root-cause report
   - replay proof
   - gate/policy regression test addition before re-enable.

## 10) Key Risks and Mitigations

1. External validity risk:
   - Mitigation: multi-window, regime-segmented evaluation before promotion.
2. Reward overfitting risk:
   - Mitigation: strict holdout periods, ablations, and drift monitors.
3. Operational fragility risk:
   - Mitigation: fallback-first runtime design and on-call drills.
4. Reproducibility drift risk:
   - Mitigation: immutable manifests and hash-locked artifacts.

## 11) Timeline (Target)

1. Week 1: M0
2. Weeks 2-3: M1
3. Weeks 4-5: M2
4. Weeks 6-8: M3
5. Weeks 9-10: M4
6. Weeks 11-12+: M5 observation and go/no-go

## 12) Go/No-Go Checklist

Go only if all are true:

1. All required gates pass with no manual bypass.
2. Reproducibility package validated.
3. Statistical evidence meets policy thresholds.
4. Rollback drill passed within last 72 hours.
5. On-call acknowledges live canary readiness.
