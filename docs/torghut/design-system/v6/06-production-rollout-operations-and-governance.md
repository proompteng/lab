# Production Rollout, Operations, and Governance

## Status

- Doc: `v6/06`
- Date: `2026-02-27`
- Maturity: `production implementation draft`
- Scope: phased rollout plan for Beyond-TSMOM architecture with explicit SLO, rollback, and governance controls
- Implementation status: `In Progress`
- Evidence:
  - `docs/torghut/design-system/v6/06-production-rollout-operations-and-governance.md` (rollout plan)
- Rollout status: canonical phase manifest, canary gates, and rollback proof artifacts are integrated into the autonomous lane + scheduler governance pipeline.

## Objective

Provide a practical rollout plan from current live posture to fully operational intraday regime-adaptive and DSPy-governed decisioning.

## Autonomous rollout contract (authoritative)

The autonomous promotion pipeline produces a single canonical phase manifest at:

`<artifact_path>/rollout/phase-manifest.json`

Every manifest must include all of these top-level fields:

- `schema_version` = `autonomy-phase-manifest-v1`
- `run_id`
- `candidate_id`
- `execution_context`
  - `repository`
  - `base`
  - `head`
  - `artifactPath`
  - `priorityId`
- `requested_promotion_target` (`paper` | `live`)
- `status` (`pass` | `fail`)
- `phase_count`
- `phase_transitions` list of adjacent transitions
- `phases` list in exact order
- `runtime_governance`
- `rollback_proof`
- `artifact_refs`
- `slo_contract_version` = `governance-slo-v1`
- `observation_summary`

Phase order is fixed and authoritative for every manifest:

1. `gate-evaluation`
2. `promotion-prerequisites`
3. `rollback-readiness`
4. `drift-gate`
5. `paper-canary`
6. `runtime-governance`
7. `rollback-proof`

Every phase payload includes:

- `name`
- `status` (`pass`, `fail`, `skip`, `skipped`)
- `timestamp`
- `slo_gates`
- `observations`
- `artifact_refs`

`phase_transitions` must be derived only from the canonical phase list and must include transitions between each adjacent phase.

## SLO gate requirements

Each phase must declare SLO checks in `slo_gates`:

- `gate-evaluation`
  - `slo_signal_count_minimum`
  - `slo_decision_count_minimum`
  - promotion gate-derived status checks
- `promotion-prerequisites`
  - `slo_required_artifacts_present`
- `rollback-readiness`
  - `slo_required_rollback_checks_present`
- `drift-gate`
  - `slo_drift_gate_allowed`
- `paper-canary`
  - `slo_paper_canary_patch_present`
- `runtime-governance`
  - `slo_runtime_rollback_not_triggered`
- `rollback-proof`
  - `slo_rollback_evidence_required_when_triggered`

Failure policy:

- manifest `status` is `fail` when any phase status is not `pass`/`skip`/`skipped`
- transitions preserve the same failure state.

## Rollout execution flow

- `run_autonomous_lane` is the single phase-manifest producer.
- The scheduler appends runtime governance and rollback proof updates after drift policy evaluation.
- The scheduler publishes a per-iteration notes artifact on every cycle and records:
  - outcome (`lane_completed`, `lane_execution_failed`, or `blocked_no_signal`)
  - reason
  - phase manifest path
  - emergency-stop/rollback evidence path
  - throughput and recommendation trace identifiers

## Canary and rollback-proof controls

### Canary promotion control

- `paper-canary` is the gate that marks whether a paper strategy patch was produced.
- For `paper` target, missing patch => `fail`.
- For `live` target, missing patch => `skip`.
- Canary completion path is captured in phase artifact references.

### Rollback-proof control

- `runtime-governance` status becomes `fail` when runtime drift/rollback policy is triggered or when drift state is unhealthy.
- `rollback-proof` status becomes:
  - `pass` when not rollback-triggered
  - `pass` only when evidence path exists if rollback is triggered
- Evidence is referenced by:
  - `drift_last_detection_path`
  - `drift_last_action_path`
  - `drift_last_outcome_path`
  - `rollback_incident_evidence_path`

## Per-iteration notes artifact

Each scheduler cycle writes an evidence notes file at:

`${artifactPath}/notes/iteration-<n>.md`

`artifactPath` is the autonomy artifact root (`settings.trading_autonomy_artifact_dir`).
`n` increments from the existing highest `iteration-*` file in the notes folder.

Notes are append-only per cycle and must remain uncommitted in source control.

## Rollout Phases

### Phase 0: Baseline capture

- Snapshot current decision quality, drawdown profile, fallback rates, and market-context freshness.
- Freeze baseline artifact references for comparison.

### Phase 1: Evaluation and data integrity hardening

- Enable contamination-safe eval pipeline as promotion prerequisite.
- Validate benchmark reproducibility and lineage capture.

### Phase 2: Regime router shadow mode

- Deploy router and expert-weight outputs in shadow.
- Record path decisions without altering execution.
- Validate entropy triggers and defensive fallbacks.

### Phase 3: DSPy serving cutover over Jangar

- Run DSPy as active decision reasoning path using Jangar OpenAI endpoint.
- Remove legacy runtime network LLM path.
- Keep deterministic fallback and strict timeout budget.

### Phase 4: Controlled live routing activation

- Start with low notional impact and high oversight.
- Increase exposure only on passing SLO windows.
- Keep immediate rollback switches available.

### Phase 5: Alpha-discovery loop activation

- Start offline generation/eval/promote cadence.
- Promote only candidates that pass all evidence gates.

## Runtime SLO Targets

- `>= 99.9%` decision-loop availability.
- Fast-path p95 latency within configured budget.
- DSPy timeout plus fallback rate within policy threshold.
- Market-context freshness target by domain (news and fundamentals).
- Router fallback rate below configured ceiling.

## Alerting and Incident Response

Required alert families:

1. DSPy transport/auth/schema failures.
2. Router feature staleness or high fallback state.
3. Deterministic gate anomaly spikes.
4. Eval drift and promotion-gate failures.
5. Market-context freshness degradation.

Every alert class must map to a runbook action and owner.

## Rollback Controls

Hard rollback switches:

1. disable DSPy path and force deterministic-only advisory fallback,
2. disable regime-adaptive routing and use defensive/static expert weights,
3. revert to prior promoted artifacts for router and DSPy runtime,
4. roll Knative traffic back to last stable revision.

## Governance and Audit

Each rollout stage must produce:

- commit SHA and image digest map,
- active artifact hashes,
- SLO and gate compliance summary,
- unresolved risks and owner assignments.

## Full Operational Exit Criteria

1. Regime-adaptive router is live with verified fallback safety.
2. DSPy over Jangar is the active LLM decision path with lineage and fallback controls.
3. Contamination-safe eval pipeline gates all promotions.
4. Alpha-discovery loop is running through controlled AgentRun lanes.
5. GitOps manifests and deployed state are converged with no unmanaged drift.
