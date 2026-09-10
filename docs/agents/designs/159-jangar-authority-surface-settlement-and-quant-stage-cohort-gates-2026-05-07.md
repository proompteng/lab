# 159. Jangar Authority Surface Settlement And Quant Stage Cohort Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, canonical status authority, rollout-source settlement, quant stage cohort
admission, Torghut evidence repair gates, validation, rollout, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/163-torghut-quant-stage-cohort-and-evidence-repair-settlement-2026-05-07.md`

Extends:

- `158-jangar-controller-ingestion-epochs-and-profit-evidence-refill-gates-2026-05-07.md`
- `157-jangar-shadow-parity-ledger-and-enforcement-release-train-2026-05-07.md`
- `156-jangar-runtime-activation-receipts-and-source-drift-quarantine-2026-05-07.md`

## Decision

I am selecting canonical authority-surface settlement with quant stage cohort gates as the next Jangar architecture
step.

The live evidence is no longer a simple availability failure. Jangar is serving, runtime kits are healthy, controller
heartbeats are fresh, the database migration surface is current, and watches are healthy. At the same time, Jangar
still exposes more than one authority story. The `jangar.jangar` control-plane status reports execution trust healthy,
while the `agents.agents` ready surface reports execution trust degraded because the Torghut verify stage is stale.
The same status payload can show healthy split-controller heartbeats while `agentrun_ingestion.status` remains
`unknown`, and material action classes are still held by source/GitOps absence, desired/live image mismatch, and
controller witness settlement.

Torghut has a matching data-plane contradiction. Latest quant metrics exist for the live account/window, and the TA
stream is fresh, but quant stage receipts are empty, empirical proof jobs are stale, routeability is zero, and proof
floor remains `repair_only`. Jangar should not ask Torghut or deployers to infer capital safety from the freshest
green sub-surface. It should publish a single `authority_surface_settlement` that names the canonical status surface
for each action class, records any disagreement between ready/status routes, and admits only the bounded quant stage
cohort repairs that are safe under the current evidence.

The tradeoff is that this design keeps dispatch, merge readiness, paper canary, and live capital held until authority
surfaces converge. I accept that. The faster alternative would be to treat the healthy status route as enough, but that
would hide route-level contradictions precisely when Torghut is trying to refill stale profit evidence.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `authority_surface_settlement`.
- The settlement records every observed Jangar serving/status surface that a consumer may cite: `jangar.jangar`
  status, `jangar.jangar` ready, `agents.agents` status, and `agents.agents` ready when reachable.
- Each action class has one canonical authority surface and one decision: `allow`, `repair_only`, `hold`, or `block`.
- Route-level disagreement, such as healthy status plus degraded ready, is represented as `surface_split`, not hidden
  inside free-text messages.
- `serve_readonly` and `torghut_observe` may continue when the canonical status route is healthy.
- `dispatch_repair` may run only bounded evidence repair cells when authority surfaces are split but database,
  controller heartbeat, and watch reliability are current.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require a
  canonical valid surface with source/GitOps truth, controller ingestion high-watermark, image parity, and current
  execution-trust evidence.
- Quant stage cohort gates distinguish latest metric writes from complete stage coverage. A nonempty latest store is
  not enough for paper/live capital when stage receipts are missing.
- Deployer output can reject an action with one `authority_surface_settlement_id`, one `quant_stage_cohort_gate_id`,
  and finite reason codes.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records, ClickHouse
tables, GitOps resources, AgentRun objects, broker state, empirical artifacts, or trading flags.

### Cluster And Rollout Evidence

- `kubectl config current-context` was unset, but `kubectl auth whoami` succeeded as
  `system:serviceaccount:agents:agents-sa`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Recent Agents events still included readiness probe timeouts on `agents` and both `agents-controllers` pods before
  later successful schedule-runner job creation.
- Torghut deployments were running after a fresh rollout: live revision `torghut-00276` was `1/1`, simulation revision
  `torghut-sim-00376` was `1/1`, and TA/TA-sim taskmanager pods were running.
- Recent Torghut events showed transient readiness and startup probe failures during rollout, Flink `last-state`
  restart reconciliation, and a retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod in `Error`.
- The service account can read pods, deployments, cronjobs, services, and events, but cannot list Knative services,
  list FlinkDeployment resources, list StatefulSets in relevant namespaces, or exec into database pods.

### Jangar Control-Plane Evidence

- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` returned healthy
  controller heartbeats for `agents-controller`, `supporting-controller`, and `orchestration-controller`.
- Runtime adapters were configured for `workflow`, `job`, and `temporal`.
- Jangar database status was healthy with `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest
  applied migration `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was healthy over the 15 minute window with zero errors.
- `agentrun_ingestion.status` remained `unknown` with message `agents controller not started`, despite fresh
  split-controller heartbeats.
- `source_rollout_truth_exchange.deployer_summary.settlement_state` was `heartbeat_projection_split`.
- Material action classes were held or blocked because source/GitOps revision was missing, desired and live images
  mismatched, controller witness evidence was not current, and empirical proof was stale.
- `route_stability_escrow` allowed `serve_readonly` and `torghut_observe`, held dispatch/merge/paper classes, and
  blocked live capital classes.
- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok` for serving, but its execution-trust block
  was degraded because the Torghut verify stage was stale. That disagreed with the healthy execution-trust block from
  the canonical Jangar namespace status route.

### Torghut Quant Evidence Consumed By Jangar

- `GET http://torghut.torghut.svc.cluster.local/healthz` returned liveness `ok`.
- `GET /readyz` and `GET /trading/health` returned structured `status=degraded`.
- Torghut database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`; lineage was ready
  with known parent-fork warnings and account-scope checks bypassed because multi-account mode is disabled.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Alpha readiness had three shadow hypotheses, zero promotion-eligible hypotheses, and three rollback-required
  hypotheses.
- Empirical jobs were stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`; all cited candidate `chip-paper-microbar-composite@execution-proof` and dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Jangar quant health for account `PA3SX7FYNUTF` and window `15m` had `latestMetricsCount=144`, but status was
  `degraded` because `missingUpdateAlarm=true`, `missingUpdateThresholdSeconds=15`, and `stages=[]`.
- Jangar TA latest for `NVDA` showed fresh TA bars and signals at `2026-05-07 18:10:35`, so raw TA freshness is not the
  same blocker as stage-cohort completeness.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` assembles controllers, runtime adapters, execution trust,
  database status, watch reliability, route stability, source rollout truth, material verdicts, and empirical services.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` already emits action decisions and
  source/image mismatch blockers.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts` already separates read-only actions from
  dispatch/capital actions.
- `services/jangar/src/server/torghut-quant-metrics.ts` distinguishes latest metric freshness from stage health, but
  its consumer contract does not yet force capital gates to cite a complete quant stage cohort.
- High-risk status surfaces are concentrated in `services/jangar/src/server/control-plane-status.ts` (787 lines) and
  `services/jangar/src/server/torghut-quant-metrics.ts` (928 lines). The missing test surface is cross-route authority
  settlement plus quant-stage completeness under route disagreement.

## Problem

Jangar has several true statements that are unsafe when consumed independently:

1. The Jangar namespace control-plane status can be healthy.
2. The Agents namespace ready route can still report degraded execution trust.
3. Split-controller heartbeats can be fresh while serving-local AgentRun ingestion is unknown.
4. Latest Torghut quant metrics can be nonempty while stage receipts are missing.
5. Read-only observation can be safe while dispatch, merge, and capital actions must remain held.

The current payloads expose those facts, but they do not settle which surface is canonical for each material action.
That leaves engineers and deployers to infer action safety from a large JSON response. The next six months of Torghut
profit work cannot depend on that inference.

## Alternatives Considered

### Option A: Make `jangar.jangar` Status The Only Authority

Pros:

- Small implementation.
- The route is healthy and already includes rich control-plane evidence.
- It avoids blocking on the Agents namespace ready route.

Cons:

- It hides real route disagreement.
- It does not explain why `/ready` can degrade execution trust while `/status` is healthy.
- It would let consumers cite a healthy status route while material action gates still hold.

Decision: reject. A canonical route is useful only if disagreements are first-class evidence.

### Option B: Block All Actions Whenever Any Surface Disagrees

Pros:

- Strictly fail-closed.
- Easy deployer rule.
- Avoids accidental dispatch during source/controller split.

Cons:

- It would block bounded evidence repair even when database, controller heartbeat, and watches are current.
- It would slow repair of stale Torghut empirical jobs and missing quant stage receipts.
- It treats read-only observation, repair, merge readiness, and live capital as the same risk.

Decision: reject as too blunt.

### Option C: Add Authority-Surface Settlement And Quant Stage Cohort Gates

Pros:

- Converts route disagreement into a named settlement state.
- Keeps read-only observation available while holding material actions.
- Allows bounded repair only when the canonical evidence is sufficient for repair, not capital.
- Makes latest metric freshness and stage coverage separate gates.

Cons:

- Adds another reducer and status schema.
- Requires tests that compare route surfaces, not just individual reducers.
- Keeps capital blocked until source, controller, empirical, routeability, and stage receipts converge.

Decision: select Option C.

## Architecture

Add `authority_surface_settlement` under `services/jangar/src/server/`. The reducer must not call Kubernetes or
databases directly. It consumes already assembled status and ready evidence from known Jangar surfaces.

`AuthoritySurfaceSettlement` fields:

- `settlement_id`
- `generated_at`
- `fresh_until`
- `namespace`
- `canonical_surface_ref`
- `observed_surfaces`
- `surface_disagreements`
- `leader_ref`
- `controller_heartbeat_ref`
- `controller_ingestion_epoch_ref`
- `database_projection_ref`
- `watch_reliability_ref`
- `execution_trust_ref`
- `source_rollout_truth_ref`
- `route_stability_ref`
- `torghut_proof_floor_ref`
- `decision_by_action_class`
- `reason_codes`
- `rollback_target`

`ObservedAuthoritySurface` fields:

- `surface_ref`
- `url`
- `status_code`
- `service`
- `generated_at`
- `leader_identity`
- `controller_mode`
- `execution_trust_status`
- `database_status`
- `watch_status`
- `agentrun_ingestion_status`
- `route_stability_state`
- `source_rollout_state`
- `latency_ms`
- `error`

Decision rules:

- `serve_readonly`: allow when any canonical Jangar status route is fresh and database status is healthy.
- `torghut_observe`: allow when canonical status is fresh, route stability is stable or repair-only, and Torghut proof
  floor is not granting capital.
- `dispatch_repair`: repair-only when surfaces split but controller heartbeat, database, and watches are current; hold
  if source/GitOps and controller ingestion are missing for the requested repair class.
- `dispatch_normal`, `deploy_widen`, and `merge_ready`: require no surface split, source/GitOps truth, controller
  ingestion high-watermark, image parity, and current execution-trust evidence.
- `paper_canary`, `live_micro_canary`, and `live_scale`: additionally require Torghut stage cohort, empirical,
  routeability, market context, proof floor, and submission-policy receipts.

Add `quant_stage_cohort_gate` to the Jangar status model. It consumes Torghut quant health, TA latest freshness,
empirical services, and Torghut proof floor.

`QuantStageCohortGate` fields:

- `gate_id`
- `account_label`
- `window`
- `latest_metrics_count`
- `latest_metrics_updated_at`
- `latest_metrics_fresh`
- `stage_count`
- `required_stage_count`
- `missing_stages`
- `max_stage_lag_seconds`
- `empirical_jobs_status`
- `ta_latest_ref`
- `routeability_ref`
- `proof_floor_ref`
- `decision`: `observe`, `repair_only`, `hold`, or `block`
- `allowed_repair_classes`
- `blocked_action_classes`
- `reason_codes`

Latest metrics can make `observe` or `repair_only` possible. They cannot make paper or live capital possible unless
the required stage set is complete and fresh.

## Implementation Scope

Jangar engineer owns:

- Add `AuthoritySurfaceSettlement` and `QuantStageCohortGate` status types.
- Add a pure reducer that compares ready/status surfaces and emits `surface_split` when they disagree.
- Extend control-plane status to include the settlement and stage gate.
- Extend source rollout truth, route stability, material verdict, and action clocks to cite the settlement ID.
- Add tests for healthy converged surfaces, healthy status plus degraded ready, split controller heartbeat plus
  unknown ingestion, latest metrics with missing stages, stale empirical jobs, and repair-only admission.

Torghut engineer consumes:

- `authority_surface_settlement_id` and `quant_stage_cohort_gate_id` in profit evidence repair receipts.
- Repair-only decisions for empirical refresh, quant stage refill, market context refresh, routeability snapshot, and
  TCA projection.
- Hold/block decisions for paper/live capital until the companion Torghut contract passes.

## Validation Gates

Minimum local validation:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-source-rollout-truth-exchange.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-route-stability-escrow.test.ts`
- `bun run --cwd services/jangar test -- src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`
- `bunx oxfmt --check docs/agents/designs/159-jangar-authority-surface-settlement-and-quant-stage-cohort-gates-2026-05-07.md`

Runtime acceptance:

- Status includes one `authority_surface_settlement`.
- The current observed route disagreement classifies as `surface_split` or `repair_only`, not as a silent healthy
  state.
- `serve_readonly` and `torghut_observe` remain allowed.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  or blocked while source/GitOps truth, controller ingestion, empirical jobs, and stage receipts are incomplete.
- Quant health with latest metrics but empty stages yields `quant_stage_cohort_gate.decision=repair_only` at most.

## Rollout Plan

1. Ship the settlement and stage gate in shadow mode.
2. Compare decisions against existing source rollout truth, route stability, material verdict, and action clocks for
   one full schedule cycle.
3. Require the settlement ID in bounded evidence repair requests.
4. Enforce `dispatch_repair` limits from the settlement.
5. Require converged authority surfaces for normal dispatch, deploy widen, merge readiness, and capital action classes.

## Rollback

Rollback is configuration-first:

- Disable enforcement while keeping settlement output visible.
- Keep existing route stability, source rollout truth, and material verdict reducers as the active gates.
- Disable quant stage cohort enforcement and treat quant health as informational.
- Keep Torghut capital zero-notional. Do not use rollback to promote paper or live capital.

Old settlement records should expire naturally and remain audit evidence.

## Risks And Tradeoffs

- If the settlement is too strict, repair work can starve. Mitigation: allow named repair-only classes when database,
  controller heartbeat, and watches are current.
- If the settlement is too permissive, route disagreement can leak into material dispatch. Mitigation: require no
  surface split for normal dispatch, merge readiness, and capital.
- If latest metrics are mistaken for stage coverage, Torghut can receive weak capital evidence. Mitigation: stage
  cohort gate must require explicit stage receipts.
- If surface URLs change, consumers may cite stale routes. Mitigation: observed surfaces include URL, latency, and
  freshness expiry.

## Handoff To Engineer And Deployer

Engineer acceptance:

- Implement `authority_surface_settlement` and `quant_stage_cohort_gate` in shadow mode.
- Add cross-route tests for `jangar.jangar` and `agents.agents` disagreement.
- Add quant-health tests for nonempty latest metrics with missing stages.
- Ensure every material action decision cites the settlement ID.

Deployer acceptance:

- Treat `authority_surface_settlement.decision_by_action_class.<action>=allow` as the only Jangar action authority.
- Treat `repair_only` as sufficient only for bounded evidence repair classes.
- Keep paper and live capital blocked unless authority surfaces converge and the Torghut companion stage cohort is
  complete.
- Roll back by disabling enforcement flags, not by deleting evidence or relaxing capital gates.
