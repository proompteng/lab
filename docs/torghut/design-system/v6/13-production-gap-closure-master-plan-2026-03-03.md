# Production Gap-Closure Master Plan (End-to-End)

## Status

- Doc: `v6/13`
- Date: `2026-03-03`
- Maturity: `production execution plan`
- Scope: close all currently documented `Partial`/`Planned` gaps across the active Torghut autonomous quant stack and supporting v4/v5 dependencies.
- Implementation status: `In progress`

## Objective

Deliver one production-grade autonomous quant operating system that is:

1. contamination-safe,
2. profitability-stage-gated,
3. DSPy-governed with deterministic veto authority,
4. regime-aware and benchmarked,
5. fully auditable with rollback-proof evidence.

No promotion path may bypass these controls.

## Current Baseline (Observed in Repo)

- Autonomous scheduler and lane runtime are active with drift governance hooks.
  - `services/torghut/app/trading/scheduler.py`
  - `services/torghut/app/trading/autonomy/lane.py`
- Gate policy enforcement exists in code, but strict profitability-stage manifest enforcement is policy-conditional.
  - `services/torghut/app/trading/autonomy/policy_checks.py`
- Runtime policy wiring currently points to:
  - `TRADING_AUTONOMY_GATE_POLICY_PATH=/etc/torghut/autonomy/autonomy-gates-v3.json`
  - `argocd/applications/torghut/autonomy-configmap.yaml`
- Mounted gate policy currently omits several strict keys present in richer policy specs.
  - `argocd/applications/torghut/autonomy-gate-policy-configmap.yaml`
  - `services/torghut/config/autonomous-gate-policy.json`

## Gap Inventory (Program Scope)

1. `v6/05` contamination-safe promotion artifact registry is partial.
2. `v6/08` canonical profitability operating contract is planned.
3. `v6/03` DSPy production cutover is implemented with live fail-closed runtime posture. (Completed `2026-03-03`)
4. `v6/02` expert-router artifact registry and tuning SLO loop are partial.
5. `v6/07` HMM posterior state service + lineage are partial.
6. `v6/09` external benchmark parity suite is implemented with fail-closed contract + coverage/calibration gating. (Completed `2026-03-03`)
7. `v6/10` TimesFM parity contract is implemented with fail-closed promotion gating. (Completed `2026-03-03`)
8. `v6/11` DeepLOB/BDLOB production contract is planned.
9. `v6/12` PostHog domain telemetry pipeline is planned.
10. Remaining `v4`/`v5` advanced-doc deltas are largely not implemented and must be explicitly absorbed, superseded, or closed.

## Program Principles

1. Deterministic risk, policy, and kill-switch controls remain final authority.
2. Promotions are evidence-driven and fail-closed by default.
3. Paper canary precedes live promotion for every candidate family.
4. Every governance decision is reproducible from immutable artifacts.
5. No direct cluster mutation from research output.

## Workstreams and Release Waves

## Wave 0 - Control-Plane Convergence (Week 0-1)

### Goal

Align runtime policy profile with strict enforcement design so code-level controls are actually active in production.

### Deliverables

1. Promote strict gate schema into runtime-mounted config map (`autonomy-gates-v3.json`) and remove split-brain policy definitions.
2. Ensure profitability-stage manifest key is present and enforced in runtime policy.
3. Add policy parity test between:
   - `services/torghut/config/autonomous-gate-policy.json`
   - `argocd/applications/torghut/autonomy-gate-policy-configmap.yaml` payload
4. Add startup assertion that required policy keys are present.

### Primary files

- `argocd/applications/torghut/autonomy-gate-policy-configmap.yaml`
- `services/torghut/config/autonomy-gates-v3.json`
- `services/torghut/config/autonomous-gate-policy.json`
- `services/torghut/tests/test_live_config_manifest_contract.py`
- `services/torghut/tests/test_policy_checks.py`

### Exit gate

- Runtime policy includes profitability stage manifest requirement and benchmark/janus/stress requirements.
- CI fails on any policy divergence.

## Wave 1 - Evaluation and Profitability OS Closure (Week 1-3)

### Goal

Make profitability a hard system contract across research, validation, execution, governance.

### Deliverables

1. Enforce `profitability-stage-manifest-v1` generation and validation for all promotion targets.
2. Require stage-level pass/fail checks and artifact hashes in promotion prerequisites.
3. Implement contamination and leakage registry checks in promotion gate path.
4. Add replay determinism checks for stage manifests. (Completed `2026-03-03`)

### Primary files

- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/scripts/run_autonomous_lane.py`
- `services/torghut/tests/test_profitability_evidence_v4.py`
- `services/torghut/tests/test_autonomous_lane.py`
- `services/torghut/tests/test_governance_policy_dry_run.py`

### Exit gate

- Promotion attempt without full stage manifest fails deterministically.
- All stage artifacts are hash-linked and replay-verifiable.

## Wave 2 - DSPy Live Cutover Completion (Week 2-4)

### Goal

Complete DSPy-only production decisioning path with explicit decommissioning of legacy LLM route.

### Deliverables

1. Remove legacy runtime LLM call path from decision codepath. (Completed `2026-03-03`)
2. Enforce DSPy artifact/version locks for all live advisory decisions. (Completed `2026-03-03`)
3. Ensure committee/veto telemetry and promotion lineage coverage are complete. (Completed `2026-03-03`)
4. Add migration guard that blocks rollout if legacy toggles are still enabled. (Completed `2026-03-03`)

### Primary files

- `services/torghut/app/trading/scheduler.py`
- `services/torghut/app/trading/llm/review_engine.py`
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
- `services/torghut/app/config.py`
- `services/torghut/tests/test_llm_dspy_runtime.py`
- `services/torghut/tests/test_llm_review_engine.py`
- `services/torghut/tests/test_llm_policy.py`

### Exit gate

- Live path is DSPy-only and verifiably blocked if artifact lock or readiness checks fail.

## Wave 3 - Regime/Router/HMM Control Plane (Week 3-6)

### Goal

Close architecture gaps for regime-adaptive routing with persisted HMM state lineage and concentration controls.

### Deliverables

1. Implement HMM posterior state artifact (`hmm_state_posterior`) persistence and lineage references. (Completed `2026-03-03`)
2. Add expert-router artifact registry with concentration/fallback SLO feedback loop. (Completed `2026-03-03`)
3. Wire regime-state quality into promotion and drift governance decisions. (Completed `2026-03-03`)

### Primary files

- `services/torghut/app/trading/regime_hmm.py`
- `services/torghut/app/trading/regime.py`
- `services/torghut/app/trading/forecasting.py`
- `services/torghut/app/trading/autonomy/lane.py`
- `services/torghut/app/trading/autonomy/drift.py`
- `services/torghut/tests/test_regime_classifier.py`
- `services/torghut/tests/test_scheduler_regime_resolution.py`

### Exit gate

- Every promoted candidate links regime artifacts and passes router concentration SLO checks.

## Wave 4 - External Benchmark Parity (Week 4-7)

### Goal

Require explicit parity reports against external benchmark families before promotion.

### Deliverables

1. Standardize benchmark-parity artifact generation contracts. (Completed `2026-03-03`)
2. Add benchmark family coverage checks and confidence calibration drift bounds. (Completed `2026-03-03`)
3. Block promotion on missing/incomplete parity scorecards. (Completed `2026-03-03`)

### Primary files

- `services/torghut/app/trading/parity.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/tests/test_evaluation_report.py`
- `services/torghut/tests/test_policy_checks.py`

### Exit gate

- No paper/live promotion without passing parity artifact coverage and thresholds.

## Wave 5 - Model Family Expansion (TimesFM + DeepLOB/BDLOB) (Week 6-9)

### Goal

Productionize new model families with fail-closed rollout controls.

### Deliverables

1. TimesFM router parity contract and fallback behavior. (Completed `2026-03-03`)
2. DeepLOB/BDLOB feature-model-policy contract with strict schema/version enforcement.
3. Advisor-timeout/staleness fallbacks validated for live safety.

### Primary files

- `services/torghut/app/trading/forecasting.py`
- `services/torghut/app/trading/microstructure.py`
- `services/torghut/app/trading/execution_policy.py`
- `services/torghut/app/trading/execution_adapters.py`
- `services/torghut/tests/test_feature_contract_v3.py`
- `services/torghut/tests/test_tca_adaptive_policy.py`
- `services/torghut/tests/test_execution_policy.py`

### Exit gate

- New model families canary in paper with bounded fallback/error rates and no deterministic-policy bypass.

## Wave 6 - Observability, Ops, and Compliance Closure (Week 8-10)

### Goal

Reach operational completeness for autonomous governance and incident response.

### Deliverables

1. Domain-level PostHog telemetry with decision/execution correlation IDs.
2. Quant control-plane coverage for promotion, rollback, and drift evidence continuity.
3. Runbook closure for all new failure classes and emergency-stop rehearse checks.
4. Model-risk/audit evidence package completeness checks in CI.

### Primary files

- `services/torghut/app/metrics.py`
- `services/torghut/app/main.py`
- `docs/runbooks/torghut-quant-control-plane.md`
- `docs/torghut/design-system/v1/compliance-and-auditability.md`
- `services/torghut/scripts/verify_quant_readiness.py`
- `services/torghut/tests/test_metrics.py`
- `services/torghut/tests/test_verify_quant_readiness.py`

### Exit gate

- Oncall can diagnose and rollback from artifacts alone within SLO window.

## Ownership and Milestones

## Workstream ownership

1. Quant runtime and promotion gates: `services/torghut/app/trading/**`
2. MLOps and DSPy runtime: `services/torghut/app/trading/llm/**` and `config/trading/llm/**`
3. Platform and GitOps policy/runtime wiring: `argocd/applications/torghut/**`
4. Observability and runbooks: `docs/runbooks/**`, metrics emitters, alert manifests
5. Governance/compliance evidence: autonomy manifests, readiness scripts, incident templates

## Target calendar (relative to 2026-03-03)

1. Milestone M0 (`2026-03-10`): Wave 0 complete; runtime policy/profile convergence done.
2. Milestone M1 (`2026-03-24`): Wave 1 complete; profitability-stage manifest hard-required.
3. Milestone M2 (`2026-03-31`): Wave 2 complete; DSPy-only production path validated.
4. Milestone M3 (`2026-04-14`): Wave 3 and Wave 4 complete; regime/HMM and parity gates closed.
5. Milestone M4 (`2026-04-28`): Wave 5 and Wave 6 complete; expanded model families and ops closure.
6. Milestone M5 (`2026-05-05`): full program signoff against definition-of-done checklist.

## CI/CD Quality Bar (Mandatory for Every Wave)

Run all of these for Torghut changes:

1. `cd services/torghut && uv sync --frozen --extra dev`
2. `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
3. `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
4. `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
5. `cd services/torghut && uv run pytest`
6. `cd services/torghut && uv run ruff check app tests scripts migrations`
7. `bun run lint:argocd` for manifest changes.

## Promotion Rollout Policy (Runtime)

1. `shadow` default for new families and controls.
2. `paper` canary only after all promotion prerequisites pass.
3. `live` only when:
   - explicit approval token is configured,
   - drift evidence is fresh and eligible,
   - rollback dry-run proof is present,
   - paper-canary SLO is clean for required window.

## Dependency Disposition for Legacy Gaps (v4/v5)

Each `Not Implemented` v4/v5 item must be assigned exactly one disposition:

1. `Absorbed by v6 implementation` with mapping file.
2. `Deferred with explicit business rationale and date`.
3. `Dropped` with supersession rationale and risk signoff.

No unresolved row may remain without disposition.

## Legacy Gap Mapping (Required Closure)

1. `v4/10` profitability evidence standard and `v5/09` autonomous novel-alpha design are closed by Wave 1 profitability OS enforcement.
2. `v4/05` conformal uncertainty and regime shift gating are closed by Wave 1 plus Wave 3 uncertainty/regime controls.
3. `v4/07` and `v5/04` committee/critic gaps are closed by Wave 2 DSPy cutover and deterministic veto telemetry closure.
4. `v4/02` and `v5/03` microstructure intelligence gaps are closed by Wave 5 DeepLOB/BDLOB contract rollout.
5. `v4/01` and `v5/01` TSFM/router partial gaps are closed by Wave 3 and Wave 5 router-family parity rollout.
6. `v5/07` autonomous research-to-engineering pipeline gap is closed by Waves 0-2 with strict artifact/promotion contracts.
7. `v4/08` financial memory architecture and `v6/12` telemetry gaps are closed by Wave 6 observability and lineage correlation work.

## Risk Register (Program-Level)

1. Policy/profile divergence between runtime and repository contracts.
2. Legacy path regression during DSPy cutover.
3. Hidden contamination/leakage in dataset and benchmark harness.
4. Drift false positives causing promotion starvation.
5. Over-broad model-family rollout without canary containment.

Each risk must have:

1. metric-based detection signal,
2. owner,
3. rollback trigger,
4. postmortem template link.

## Definition of Done (Program Complete)

Program is complete only when all are true:

1. All v6 gaps are `Implemented` with strict evidence.
2. Active runtime policy equals strict design contract and is parity-tested.
3. Every promotion has full profitability-stage manifest + benchmark parity + rollback proof.
4. DSPy-only live decision path is active; legacy path removed.
5. HMM/router artifacts are persisted and used in gating decisions.
6. TimesFM and DeepLOB/BDLOB canary paths pass safety SLOs.
7. Observability/runbooks/compliance checks pass in routine drills.
8. v4/v5 unresolved rows are absorbed/deferred/dropped with explicit signed disposition.

## First 14-Day Execution Backlog

1. Complete Wave 0 policy convergence PRs.
2. Add policy parity tests and startup enforcement.
3. Enable profitability-stage manifest enforcement in runtime policy.
4. Add contamination registry checks to promotion prerequisites. (Completed `2026-03-03`)
5. Publish rollout dashboard for Wave 0 and Wave 1 gates.
6. Enforce profitability stage-manifest replay-hash contract checks. (Completed `2026-03-03`)
