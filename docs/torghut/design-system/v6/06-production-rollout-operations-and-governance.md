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

Deliver a reproducible, evidence-backed rollout control plane where gate outcomes, canary checks, and rollback proof are persisted in one canonical manifest and traced end-to-end.

## Autonomous rollout contract (authoritative)

The autonomous promotion pipeline produces a single canonical phase manifest at:

`<artifact_path>/rollout/phase-manifest.json`

Every manifest must include all of these top-level fields:

- `schema_version` = `torghut.autonomy.phase-manifest.v1`
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

Phase order is fixed and authoritative for every manifest and defined once in
`AUTONOMY_PHASE_ORDER`:

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

The contract source of truth lives in `services/torghut/app/trading/autonomy/phase_manifest_contract.py` and is used by both `run_autonomous_lane` and scheduler runtime-governance append logic, so all pipeline stages consume the same SLO gate definitions from the shared `AUTONOMY_PHASE_SLO_GATES` map and `AUTONOMY_PHASE_ORDER`.

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

Autonomy and runtime promotion now emit one manifest contract in fixed phase order:

1. `gate-evaluation`
2. `promotion-prerequisites`
3. `rollback-readiness`
4. `drift-gate`
5. `paper-canary`
6. `runtime-governance`
7. `rollback-proof`

All phase artifacts and manifests must include:

- `phases`: ordered list of all contract phases (missing phases are filled with `skip`).
- `phase_transitions`: computed transitions between adjacent phases, where each transition carries destination status.
- `status`: manifest-wide status derived from the phase list.
- `artifact_refs`: canonical evidence list.
- `slo_contract_version`: expected `governance-slo-v1`.

Phase-level SLO gates are defined by contract and must exist in each relevant phase payload:

- `slo_signal_count_minimum`
- `slo_decision_count_minimum`
- `slo_required_artifacts_present`
- `slo_required_rollback_checks_present`
- `slo_drift_gate_allowed`
- `slo_paper_canary_patch_present`
- `slo_runtime_rollback_not_triggered`
- `slo_rollback_evidence_required_when_triggered`

## Controlled canary and rollback proof pipeline

- `run_autonomous_lane` builds the base manifest with lane artifacts and phase skeletons.
- Scheduler calls `_append_runtime_governance_to_phase_manifest` after lane completion.
- Scheduler appends runtime-governance and rollback proof outcomes into the same manifest (single source of truth).
- The scheduler updates:
  - runtime-governance status/evidence,
  - rollback-proof status/evidence,
  - phase list and transitions,
  - manifest-wide status,
  - and root artifact references.
- Rollback is treated as evidence-driven: when `rollback_triggered` is true, manifest and phase status is fail unless rollback evidence path is recorded.
- Canary promotion path and rollback-proof evidence are now carried in the same phase lineage and artifact graph for replay.

## Runtime controls

- `requested_promotion_target` controls canary phase behavior (`paper` vs `live`).
- Runtime drift state (`drift_status`, `rollback_triggered`, detection/action reason paths) is attached to manifest and phases.
- Per-iteration evidence bundle path is written to `phase-manifest.json` under the autonomy artifact root.

## Per-iteration note artifacts

Scheduler writes evidence notes to:

- `artifactPath/notes/iteration-<n>.md`

These are operational artifacts and must not be committed.

## Full Operational Exit Criteria

1. Deterministic phase contract is authoritative for every autonomy decision cycle.
2. Promotion only advances when canary + evidence gates indicate pass.
3. Rollback proof evidence is attached whenever rollback is triggered.
4. Manifest transitions are complete and reproducible for audit and replay.
5. Stage actions are auditable through a single manifest, with rollback paths available and tested.
