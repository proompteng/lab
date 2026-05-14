# Jangar Control Plane Cross-Plane Closure Board Handoff (2026-05-14)

## Design And Requirement Provenance

- Governing design:
  `docs/agents/designs/193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
- Companion Torghut design:
  `docs/torghut/design-system/v6/198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`
- Business metric: reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time for the Jangar control
  plane.
- Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`,
  `manual_intervention_count`, `handoff_evidence_quality`.

## Evidence Summary

- `GET /ready` on `agents.agents.svc.cluster.local` returned `status=ok`, leader election active, execution trust
  healthy, and Torghut consumer evidence current.
- `GET /api/agents/control-plane/status` reported controllers enabled and started, database healthy, `29/29`
  migrations applied, rollout health healthy, and watch reliability healthy with `943` events and zero errors in the
  15 minute window.
- Argo initially showed `agents=Synced/Progressing` during the `202dcaf1` rollout, then settled to
  `agents`, `jangar`, and `torghut` all `Synced/Healthy`.
- AgentRuns since `2026-05-13T00:00:00Z`: all retained matching runs `90` Succeeded, `9` Failed, `5` Running; Jangar
  control-plane runs `43` Succeeded, `3` Failed, `3` Running; Torghut quant runs `41` Succeeded, `2` Failed,
  `2` Running.
- Ready truth still held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; it
  blocked live capital action classes.
- Source-serving verdict remained blocked by missing source CI retention, missing manifest SHA, source-serving build
  mismatch, and missing manifest image digest.
- Torghut `/trading/revenue-repair` was `repair_only`, `revenue_ready=false`, and top queue item
  `repair_alpha_readiness` requiring `torghut.executable-alpha-receipts.v1` with max notional `0`.
- Torghut `/db-check` was schema-current at `0031_autoresearch_candidate_spec_epoch_uniqueness`; direct CNPG and pod
  exec inspection were forbidden by RBAC and should not be required for normal admission.

## Engineer Handoff

Implement `buildCrossPlaneClosureBoard` as a pure reducer before changing any scheduler enforcement.

Acceptance gates:

- `merge_ready` and `deploy_widen` select source-to-serving closure when source CI, manifest SHA, manifest digest, or
  serving build proof is missing.
- `dispatch_repair` selects the zero-notional Torghut alpha repair path only when `/trading/revenue-repair` still ranks
  `repair_alpha_readiness` first.
- active duplicate failure debt or no-delta debt holds a repeated launch.
- serving readiness remains available while material readiness is held.
- tests cover source closure, revenue repair admission, no-delta debt, and rollback mode.

## Deployer Handoff

Use the closure board, not Argo alone, for green PR-to-healthy claims once the status payload exposes it.

Acceptance gates:

- Argo `agents`, `jangar`, and `torghut` synced and healthy.
- `kubectl rollout status -n agents deployment/agents` passes.
- `kubectl rollout status -n agents deployment/agents-controllers` passes.
- Jangar `/ready` and `/api/agents/control-plane/status` reachable.
- status includes `cross_plane_closure_board` with merge and deploy closure ids.
- Torghut `/trading/revenue-repair` includes `alpha_repair_closure_board`.
- Torghut max notional remains `0`; `/readyz` may remain degraded until capital gates clear.

## Rollback

Set `JANGAR_CROSS_PLANE_CLOSURE_BOARD_MODE=observe` or
`JANGAR_CROSS_PLANE_CLOSURE_BOARD_ENABLED=false`. Keep ready truth, stage credit, source-serving verdicts, repair-bid
admission, and Torghut revenue repair active. Do not delete AgentRuns, jobs, receipts, or database rows.
