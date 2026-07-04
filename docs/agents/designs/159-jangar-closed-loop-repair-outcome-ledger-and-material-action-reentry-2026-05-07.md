# 159. Jangar Closed-Loop Repair Outcome Ledger And Material Action Reentry (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane reliability, bounded repair admission, outcome attribution, material action reentry,
Torghut capital handoff, validation, rollout, rollback, and acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/163-torghut-repair-outcome-attribution-and-capital-reentry-slo-2026-05-07.md`

Extends:

- `158-jangar-controller-ingestion-epochs-and-profit-evidence-refill-gates-2026-05-07.md`
- `157-jangar-shadow-parity-ledger-and-enforcement-release-train-2026-05-07.md`
- `151-jangar-repair-outcome-settlement-and-schedule-debt-roi-exchange-2026-05-07.md`
- `154-jangar-source-provenance-leases-and-material-action-escrow-2026-05-07.md`

## Decision

I am selecting a closed-loop repair outcome ledger with material action reentry SLOs as the next Jangar control-plane
architecture step.

The current control plane is available and useful, but it still cannot prove that a repair changed the decision surface
that matters. Jangar serving is healthy, leader election is current, the database is connected with all 28 registered
migrations applied, Agents rollout is healthy, workflows have zero recent failures in the 15 minute status window, and
watch reliability is healthy. At the same time, AgentRun ingestion is still reported as `unknown` by the serving status
path, source rollout truth is in `heartbeat_projection_split`, and source rollout truth holds `dispatch_repair`,
`dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale`.

The recent design chain gives us the right primitives: source leases, material verdicts, shadow parity, controller
ingestion epochs, and profit-evidence refill gates. The missing object is the outcome ledger that says whether a
bounded repair actually reduced a blocker, refreshed a witness, or moved an action class closer to reentry. A completed
job is not proof. A fresh status payload is not proof. A Torghut refill receipt is not proof by itself. Jangar needs a
durable, typed ledger that ties each admitted repair to before and after decision state, observed side effects, and the
next reentry gate.

The tradeoff is that repair success becomes harder to claim. I accept that. The system has had enough status objects
that describe why action is blocked. The next leverage point is to make repair work accountable for measurable blocker
retirement without letting repairs become backdoor enforcement.

This extends the earlier repair-outcome settlement work instead of replacing it. Document 151 settled schedule debt and
repair ROI. This decision narrows the next stage to action-class reentry after controller-ingestion epochs, shadow
parity, and Torghut profit-evidence refill have produced fresh evidence.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `repair_outcome_ledger` and
  `material_action_reentry_slos`.
- Every admitted `dispatch_repair` or Torghut evidence refill cites a repair intent, active controller ingestion epoch,
  source rollout truth receipt, route stability escrow ref, and rollback target.
- Each repair outcome has a before snapshot, an after snapshot, and a typed delta across source truth, controller
  ingestion, workflow outcome, route stability, database projection, watch reliability, and Torghut capital proof.
- A completed Kubernetes Job or AgentRun attempt can only mark execution finished. It cannot mark repair effective
  until the target blocker delta is observed.
- `dispatch_repair` remains the only material class that can be admitted while source or GitOps truth is absent, and
  only with a bounded repair SLO.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  until the ledger records clean repair outcomes and no regression windows for their required blocker classes.
- Deployer checks consume one reentry SLO per action class instead of independently comparing status fragments.
- Torghut capital reentry consumes the Jangar repair outcome ledger before treating evidence refill or route repair as
  paper authority.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 around 18:09Z. I did not mutate Kubernetes resources, database records,
GitOps resources, AgentRun objects, broker state, ClickHouse tables, or trading flags.

### Cluster And Rollout Evidence

- The local Kubernetes current context was unset; I created an in-cluster client context from the service account.
- `kubectl auth whoami` identified the client as `system:serviceaccount:agents:agents-sa`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar deployments and pods were running, including `jangar-594b6746fd-5lhwp` with two containers ready.
- Argo CD reported `agents`, `jangar`, `torghut-options`, `symphony-jangar`, and `symphony-torghut` synced and
  healthy. `torghut` was synced but `Progressing` during the active 00276 rollout.
- Recent Agents events showed current discover and verify CronJobs completing, but the namespace still retained older
  failed scheduled waves from earlier windows.
- The current run pod and Torghut quant discover pod were running, while current cron-triggered discover jobs completed.
- The service account could read pods in `jangar` and `torghut`, but could not get Torghut secrets and the API server
  did not expose a `cnpgclusters` resource type to this account.

### Jangar Status And Database Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`.
- Leader election was healthy with identity
  `jangar-594b6746fd-5lhwp_878d6e5a-bd83-4d9d-b352-12578239d5e2`.
- Jangar database status from the control-plane status API was healthy: configured, connected, latency `3` ms,
  migration table `kysely_migration`, `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest
  applied `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy for the two observed Agents deployments.
- Workflow reliability was high-confidence over 15 minutes: zero active job runs, zero recent failed jobs, zero backoff
  limit jobs, and zero collection errors.
- Watch reliability was healthy over 15 minutes with four streams, 4431 events, zero errors, and four restarts.
- `agentrun_ingestion.status` was `unknown` with message `agents controller not started`.
- `source_rollout_truth_exchange.deployer_summary.settlement_state` was `heartbeat_projection_split`.
- The freshest source rollout blocker was `source_rollout_truth_missing:source_or_gitops_revision`.
- Source rollout truth held all material dispatch, deploy, merge, paper, and live classes.
- Route stability state was `stable`, but only `serve_readonly` and `torghut_observe` were allowed; dispatch and paper
  remained held and live capital remained blocked.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the central status assembler and already surfaces database,
  rollout, workflows, watch reliability, source rollout truth, route stability, material verdicts, runtime admission,
  and controller witness state.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` publishes receipts and held action
  classes, but it does not track whether a repair retires a blocking reason.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts` can allow read-only observation while holding
  material action classes, but it does not own outcome attribution.
- `services/jangar/src/server/control-plane-controller-witness.ts` already names the split-controller authority gap and
  cites `agentrun_ingestion`, but the status contract still needs a closed-loop outcome surface.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule creation, fire-time admission checks,
  swarm launchers, and Workspace PVC reconciliation. This is the natural consumer of reentry SLOs, not the owner of
  repair truth.
- Existing tests cover source rollout truth, route stability escrow, material action verdicts, runtime admission,
  controller witness behavior, and status assembly. The missing regression surface is outcome attribution across a
  completed repair, unchanged blocker, improved blocker, and regressed blocker.

### Torghut Data Evidence

- Live Torghut `/readyz` returned HTTP `503`.
- Live dependencies were mostly healthy: Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe,
  readiness cache, empirical job reachability, DSPy non-live mode, and database schema.
- Torghut database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096` with one branch, no
  duplicate revisions, no orphan parents, and known parent-fork warnings.
- Live proof floor was `repair_only`, capital state `zero_notional`, and max notional `0`.
- Live proof floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live TCA had 7334 orders, 7245 filled executions, average absolute slippage about `13.82` bps, guardrail `8` bps,
  zero routeable symbols, five blocked symbols, and three missing symbols.
- Live quant evidence for `PA3SX7FYNUTF/15m` had 144 latest metrics but no pipeline stages and a missing update alarm.
- Jangar quant health for `paper/1d` was degraded with `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no
  stages.
- Simulation `/readyz` returned HTTP `200`, but simulation proof floor was still `repair_only` and `zero_notional`.
  Simulation had one probing symbol, `NVDA`, seven missing symbols, zero latest quant metrics, stale market context,
  and three shadow hypotheses with zero promotion-eligible hypotheses.

## Problem

Jangar can now describe conservative holds with good precision, but it cannot yet close the loop between an admitted
repair and a changed material-action posture. That leaves four failure modes:

1. A repair job can complete while the source, controller, or capital blocker is unchanged.
2. A repair can improve one witness while regressing another witness, but the deployer sees only the latest aggregate
   status.
3. Schedule runners can retry after a completed repair without proving the repair stayed fresh through the launch
   window.
4. Torghut can refill evidence or repair routeability while Jangar still has no typed signal that the refill retired a
   capital-relevant blocker.

The system needs a closed-loop ledger whose unit of truth is not a job, reducer, or status block. The unit of truth is
an action-class blocker delta.

## Alternatives Considered

### Option A: Use Current Status As The Outcome Contract

Pros:

- No new data structure.
- The status payload already has the needed source fragments.
- Deployer checks can be written immediately.

Cons:

- Latest status loses the before snapshot and repair intent.
- It cannot distinguish a repair that caused a change from unrelated drift.
- It has no place to record false repair success, regression windows, or accepted residual debt.

Decision: reject. Current status is necessary evidence, not an outcome contract.

### Option B: Treat Completed AgentRuns And Jobs As Repair Receipts

Pros:

- Easy to implement from Kubernetes and AgentRun state.
- Matches the operational language teams already use.
- Gives a clear audit trail for who ran what.

Cons:

- Completion does not prove a blocker moved.
- A failed repair can still be a completed job.
- It would encourage deployers to promote based on execution mechanics instead of material evidence.

Decision: reject. Execution completion is an input to outcome attribution, not the outcome itself.

### Option C: Add A Closed-Loop Repair Outcome Ledger And Reentry SLOs

Pros:

- Binds repair intent, execution evidence, before/after state, and action-class reentry into one object.
- Separates safe bounded repair from normal dispatch, deploy widening, merge readiness, and capital admission.
- Gives Torghut a precise dependency for capital route reentry.
- Makes stale or ineffective repairs visible without widening risk.

Cons:

- Adds a reducer and eventually a compact persistence surface.
- Requires each repair class to define the blocker it is expected to move.
- Keeps some completed repair jobs from being counted as useful until the after evidence arrives.

Decision: select Option C.

## Architecture

Add a pure reducer named `control-plane-repair-outcome-ledger` under `services/jangar/src/server/`. It should consume
assembled status evidence and repair receipts. It should not query Kubernetes, GitHub, databases, Torghut, or Argo CD
directly. The status assembler owns collection; the reducer owns attribution.

Inputs:

- Active controller ingestion epoch.
- Source rollout truth exchange receipts and held action classes.
- Route stability escrow and material action contracts.
- Material action verdict epoch and contradictions.
- Runtime admission passports and recovery warrants.
- Rollout health, workflow reliability, watch reliability, and database migration consistency.
- Schedule runner, AgentRun, and job outcome summaries.
- Torghut profit evidence refill receipts and capital route reentry decisions.
- Deployer-supplied rollback acknowledgements when available.

`RepairOutcomeRecord` fields:

- `record_id`
- `repair_intent_id`
- `repair_class`: `controller_ingestion`, `source_truth`, `schedule_runner`, `workspace_pvc`, `quant_refill`,
  `market_context_refill`, `routeability_repair`, `tca_refresh`, or `empirical_refresh`
- `action_class`: `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`,
  `live_micro_canary`, or `live_scale`
- `controller_ingestion_epoch_id`
- `source_rollout_truth_ref`
- `route_stability_escrow_ref`
- `before_snapshot_ref`
- `after_snapshot_ref`
- `execution_outcome_ref`
- `target_blocker`
- `before_blocker_state`
- `after_blocker_state`
- `decision_delta`: `retired`, `improved`, `unchanged`, `regressed`, `incomparable`, or `unknown`
- `side_effects`
- `regression_window_started_at`
- `regression_window_ends_at`
- `fresh_until`
- `rollback_target`
- `reason_codes`

`MaterialActionReentrySlo` fields:

- `slo_id`
- `action_class`
- `state`: `blocked`, `repair_admissible`, `repair_observed`, `reentry_candidate`, `reentry_allowed`,
  `rollback`, or `retired`
- `required_repair_classes`
- `required_clean_outcome_count`
- `observed_clean_outcome_count`
- `allowed_residual_blockers`
- `disallowed_blockers`
- `latest_repair_outcome_refs`
- `torghut_capital_dependency_refs`
- `fresh_until`
- `rollback_target`

State rules:

- `blocked`: no bounded repair or reentry is safe.
- `repair_admissible`: a bounded repair can run with max attempts, max runtime, and no capital authority.
- `repair_observed`: the repair executed and after evidence was collected.
- `reentry_candidate`: the target blocker was retired or improved and no regression window is active.
- `reentry_allowed`: deployer checks may allow the action class for the declared scope.
- `rollback`: the previous candidate regressed or lost freshness.
- `retired`: the gate is no longer needed because the owning source is enforced elsewhere.

## Implementation Scope

Jangar engineer owns:

- Add `RepairOutcomeRecord` and `MaterialActionReentrySlo` types to the control-plane status model.
- Add a pure reducer under `services/jangar/src/server/`.
- Emit `repair_outcome_ledger` and `material_action_reentry_slos` from the status route.
- Extend schedule-runner fire-time checks to require a fresh reentry SLO for any action beyond read-only observation.
- Add a compact persistence table only after the report-only reducer is green in tests.
- Add tests for completed repair with unchanged blocker, completed repair with retired blocker, regressed after
  snapshot, expired outcome, missing rollback target, and Torghut refill without Jangar reentry.

Torghut engineer consumes:

- Jangar repair outcome refs in profit evidence refill and route reentry receipts.
- `paper_canary` and `live_micro_canary` SLO states before treating a refill as capital-adjacent.
- Rollback state as a hard zero-notional input.

## Validation Gates

Minimum local validation:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-route-stability-escrow.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-controller-witness.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/supporting-primitives-controller.test.ts -t schedule`
- `bunx oxfmt --check docs/agents/designs/159-jangar-closed-loop-repair-outcome-ledger-and-material-action-reentry-2026-05-07.md`

Runtime acceptance:

- A completed repair job with unchanged `source_rollout_truth_missing:source_or_gitops_revision` produces
  `decision_delta=unchanged` and cannot reenter `dispatch_normal`.
- A repair that makes AgentRun ingestion fresh while source truth remains absent can move only to
  `repair_observed` or `repair_admissible`.
- A Torghut quant refill that clears an empty metrics projection but leaves proof floor `repair_only` cannot advance
  `paper_canary`.
- A regression in watch reliability, database migration consistency, or route stability moves affected SLOs to
  `rollback`.

## Rollout Plan

1. Ship the reducer in report-only mode and expose records from the status API.
2. Record outcome rows for `dispatch_repair` and Torghut evidence refill only.
3. Compare reentry SLO decisions with current deployer behavior for two clean windows.
4. Let deployer checks consume `dispatch_repair` SLOs first.
5. Add `dispatch_normal`, `deploy_widen`, and `merge_ready` after outcome attribution has no unsafe false allows.
6. Leave paper and live capital blocked until the Torghut companion contract records capital-specific outcome deltas.

## Rollback Plan

- Hide `repair_outcome_ledger` and `material_action_reentry_slos` from deployer enforcement while preserving
  report-only status.
- Keep source rollout truth, route stability escrow, material action verdicts, and runtime admission as the active
  gates.
- Disable schedule-runner consumption of reentry SLOs with a single runtime flag.
- Treat any ledger persistence failure as `blocked` for reentry and `repair_admissible` only for explicitly bounded
  repair classes.

## Risks

- Outcome attribution can overfit to the latest aggregate status. Mitigation: require before and after refs plus an
  explicit target blocker.
- Persistence can become another availability dependency. Mitigation: start with pure reducer output and add storage
  only after report-only parity.
- Deployers may treat `repair_observed` as approval. Mitigation: keep `reentry_allowed` as the only allow state.
- Torghut may generate useful repair evidence while Jangar source truth remains absent. Mitigation: allow evidence
  refill but keep paper and live capital held.

## Engineer And Deployer Handoff

Engineer handoff:

- Build the reducer as a pure function first.
- Add tests that prove completed execution is insufficient without blocker delta.
- Preserve read-only serving and Torghut observe paths when the ledger is unavailable.
- Keep all capital states zero-notional until Torghut provides matching capital outcome attribution.

Deployer handoff:

- Do not widen rollout, dispatch normal work, mark merge ready, or admit paper/live capital from a completed repair
  alone.
- Require `reentry_allowed` for the exact action class and scope.
- Treat `rollback`, expired `fresh_until`, missing rollback target, or `decision_delta=unchanged` as a hold.
- Use the ledger's target blocker and latest outcome refs in handoff updates so the next stage can test the same gate.
