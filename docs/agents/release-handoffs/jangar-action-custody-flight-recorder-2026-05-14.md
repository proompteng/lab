# Jangar Action Custody Flight Recorder Handoff (2026-05-14)

Status: Accepted handoff for engineer and deployer stages
Owner: Victor Chen, Jangar Engineering Architecture

Governing designs:

- `docs/agents/designs/199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`
- `docs/torghut/design-system/v6/204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md`

## Decision

Use a material action custody flight recorder as the next implementation boundary. `/ready=ok` is serving truth, not
authority to dispatch repair, widen deploy, merge, or start paper capital. The recorder is the required proof object
for material action classes.

## Current Evidence

- `agents` Argo app: `OutOfSync/Progressing` at `2ee617e354af746549731b54e037f90af5d3fd6f`.
- `jangar` Argo app: `Synced/Healthy` at `d42c4576c46c603a9f180026672a8e5c1f974364`.
- `torghut` Argo app: `Synced/Healthy` at `2ee617e354af746549731b54e037f90af5d3fd6f`.
- Jangar deployments: `agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`.
- Torghut active revisions: `torghut-00382=1/1`, `torghut-sim-00480=1/1`.
- Jangar `/ready`: `status=ok`, `business_state=repair_only`, `revenue_ready=false`,
  `affected_value_gate=routeable_candidate_count`.
- Jangar status: database healthy, `29/29` Kysely migrations applied, AgentRun ingestion unknown, ready action
  exchange `block`, dispatch/deploy/merge held.
- Agents namespace pods: `337` total, `113` failed.
- Jangar/Torghut swarm pods: `84` failed, `117` succeeded, `5` running.
- Torghut `/db-check`: current at `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Torghut `/trading/revenue-repair`: top queue `repair_alpha_readiness`, `routeable_candidate_count=0`, `3`
  zero-notional executable alpha receipts, `0` paper replay candidates, `capital_ready=false`.

## Engineer Acceptance Gates

Build a shadow read model first.

- Add `jangar.material-action-custody-flight-recorder.v1` as a pure reducer in Jangar.
- Include governing design refs and validation contract refs in every recorder.
- Carry source truth, Argo truth, DB migration witness, controller/AgentRun ingestion witness, runner-debt window,
  Torghut top repair item, and decision basis.
- Current evidence must evaluate to `serve_readonly=allow`, `dispatch_repair=hold`, `dispatch_normal=hold`,
  `deploy_widen=hold`, `merge_ready=hold`, and `paper_canary=hold`.
- Add tests for AgentRun ingestion unknown, source-serving block, database drift, stale Torghut repair evidence,
  unchanged runner-debt release key, and ready-ok/material-hold.

Minimum local checks:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-material-action-custody-flight-recorder.test.ts`
- `bun run --cwd services/jangar test -- src/routes/ready.test.ts`
- `bun run --cwd services/jangar tsc`
- `bun run --cwd services/jangar lint`
- `bun run --cwd services/jangar lint:oxlint`

## Torghut Acceptance Gates

Build dividend accounting before capital changes.

- Add `torghut.alpha-repair-dividend-ledger.v1` as a pure builder.
- Emit the compact ledger ref through consumer evidence in observe mode.
- Current evidence must not produce a paid dividend while `routeable_candidate_count=0`.
- Every ledger must carry `max_notional=0`, `capital_rule=zero_notional_repair_only`, selected value gate
  `routeable_candidate_count`, and no-delta release key.

Minimum local checks:

- `uv run --frozen pytest services/torghut/tests/test_revenue_repair.py -k alpha`
- `uv run --frozen pytest services/torghut/tests/test_repair_bid_settlement.py -k promotion_custody`
- `uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window`
- all Torghut Pyright profiles required by repo guidance

## Deployer Acceptance Gates

Do not claim ready-to-merge or ready-to-rollout on serving health alone.

- PR CI green.
- Argo `agents`, `jangar`, and `torghut` synced and healthy, or drift explicitly held by the recorder.
- Workload readiness matches desired replicas for `agents`, `agents-controllers`, `jangar`, and active Torghut
  revisions.
- `GET http://agents.agents.svc.cluster.local/ready` returns serving status and material custody summary.
- Jangar status shows database healthy and recorder current.
- Torghut `/db-check` schema current.
- Torghut `/trading/revenue-repair` and consumer evidence agree on the alpha repair dividend ledger.
- Paper/live capital stays blocked while `max_notional=0` and `capital_ready=false`.

## Rollback

Set recorder mode to `observe`, keep ready action exchange and stage credit as the enforcement source, remove recorder
requirements from new AgentRun templates only after in-flight runs drain, and keep Torghut live submit disabled with
`max_notional=0`.

Emergency posture: allow only `serve_readonly` and `torghut_observe`, hold repair/deploy/merge/paper, and block live
capital until the recorder reducer and dividend ledger are corrected.

## Next Milestone

Engineer stage: implement the Jangar shadow recorder and Torghut dividend ledger observe-mode carry. This milestone
maps to `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`, `manual_intervention_count`, and
`handoff_evidence_quality`.
