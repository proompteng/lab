# Jangar material evidence schedule trace handoff - 2026-05-14

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane`
Governing design:
`docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md`

## Owner update message

I shipped the next material-evidence-settlement handoff step in source: scheduled and requirement-launched runs now
carry the current material evidence settlement id and compact decision fields when Jangar status exposes a fresh
`material_evidence_settlement_spine`. The runtime gate remains observe-mode and additive; existing runtime admission,
stage clearance, stage credit, evidence pressure, and Torghut zero-notional controls still decide whether a run can
launch.

The selected value gates are `handoff_evidence_quality`, `ready_status_truth`, and `failed_agentrun_rate`. This reduces
the chance that a later verify or repair AgentRun is audited without the material authority packet that governed its
launch.

## Runtime evidence

Before local implementation, `GET http://agents.agents.svc.cluster.local/ready` returned:

- `status=ok`
- `business_state=null`
- `revenue_ready=null`
- `top_repair_queue_item=null`
- `repair_queue=[]`
- `execution_trust.status=degraded`
- `execution_trust.evidence_summary=["stages:agents:jangar-control-plane:verify:verify consecutive failures"]`
- `repair_bid_admission.design_artifact=docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`

Full status in the same window exposed `stage_credit_ledger`, `verify_trust_foreclosure_board`, and
`ready_truth_arbiter` material holds, but the live deployed service did not yet expose
`material_evidence_settlement_spine`. The source branch already contains the settlement reducer; this change makes new
launch traces consume it once the image rolls out.

## What changed

- `supporting-primitives-schedule-runner` stamps fresh `material_evidence_settlement_spine` fields into launch
  annotations and `spec.parameters`.
- `supporting-primitives-stage-clearance` reads material-evidence settlement snapshots and includes them in launch
  admission status.
- The material-evidence parser/stamper and status projection live in small helper modules so the stage-clearance
  module remains under the Jangar 800-line module-size cap.
- Regression coverage verifies schedule-runner command generation and stage-clearance trace stamping.
- Design 206 now records the scheduler trace follow-up and its observe-mode rollback posture.

## Validation

Required local validation for this source change:

- `bun run --cwd services/jangar test -- src/server/__tests__/supporting-primitives-controller.test.ts -t "material evidence"`
- `bun run --cwd services/jangar test -- src/server/__tests__/supporting-primitives-controller.test.ts -t "builds schedule runner command"`
- `bun run --cwd services/jangar check:module-sizes`
- `bunx oxfmt --check services/jangar/src/server/supporting-primitives-schedule-runner.ts services/jangar/src/server/supporting-primitives-stage-clearance.ts packages/agent-contracts/src/supporting-primitives-material-evidence-trace.ts services/jangar/src/server/supporting-primitives-stage-clearance-status.ts services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md docs/agents/release-handoffs/jangar-material-evidence-schedule-trace-2026-05-14.md`

## Risks and rollback

- Risk: downstream consumers may mistake the stamped material-evidence fields for an enforcement gate. Mitigation:
  parameters and annotations are trace-only; existing admission and stage gates remain authoritative.
- Risk: a stale settlement could be copied into a launch. Mitigation: the schedule-runner command only stamps the
  live-fetched settlement when `fresh_until` is still in the future; stale settlements produce a warning.
- Rollback: revert this PR, or ignore `swarmMaterialEvidence*` parameters and
  `swarm.proompteng.ai/material-evidence-*` annotations while leaving runtime admission, stage credit, evidence
  pressure, ready truth, and Torghut max-notional gates in place.

## Deployer proof after rollout

- Confirm Argo `agents` and `jangar` are `Synced/Healthy`.
- Confirm `agents` and `agents-controllers` deployments are ready.
- Confirm `/ready.status=ok` and full status exposes `material_evidence_settlement_spine`.
- Inspect a new scheduled AgentRun and verify `spec.parameters.swarmMaterialEvidenceSettlementId` matches the current
  status settlement id when the settlement is fresh.
