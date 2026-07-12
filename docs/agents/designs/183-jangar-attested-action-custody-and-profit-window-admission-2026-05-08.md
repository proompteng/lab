# 183. Jangar Attested Action Custody And Profit-Window Admission (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, failed AgentRun reduction, scheduler launch safety, deployer custody,
Torghut profit-window admission, rollout, rollback, validation, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/187-torghut-profit-window-custody-and-repair-value-market-2026-05-08.md`

Extends:

- `181-jangar-proof-production-debt-and-routeability-admission-2026-05-08.md`
- `180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`
- `169-jangar-ready-action-evidence-exchange-and-deployer-custody-2026-05-07.md`
- `../torghut/design-system/v6/185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md`

## Decision

I am selecting **attested action custody with profit-window admission** as the next Jangar control-plane architecture
step.

The system has moved past the broad May 5 outage posture. In the read-only assessment at `2026-05-08T16:24Z`, Argo CD
reported `agents`, `jangar`, `torghut`, `torghut-options`, `symphony-jangar`, and `symphony-torghut` as
`Synced/Healthy` at revision `5b5e94d175626ac94d4ea3c5d9152522824e2bd3`. The `agents-controllers` deployment was
`2/2`, the Jangar pod was running, Torghut live revision `torghut-00311` and sim revision `torghut-sim-00409` were
running, and Jangar and agents `/ready` returned HTTP 200.

That does not make the control plane trustworthy enough to widen dispatch, deploy claims, or Torghut capital. The same
assessment showed `79` Error pods and `20` failed AgentRuns retained in `agents`, readiness probe timeouts on
`agents` and `agents-controllers`, Torghut `/readyz` returning HTTP 503, and Jangar control-plane status holding
`dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` because the controller ingestion self-report is
missing. Torghut consumer evidence is current through the `jangar.jangar` route, but it still says `decision=repair`,
`max_notional=0`, and reason codes including `forecast_registry_degraded`, `simple_submit_disabled`,
`hypothesis_not_promotion_eligible`, and `market_context_stale`.

The design answer is a custody object, not a larger health object. Jangar should not let any runner, deployer, or
capital consumer infer action readiness from pod health, Argo health, fresh quant metrics, or a live Torghut
consumer-evidence route. It should publish an `action_custody_receipt` that binds the action class, controller witness,
source rollout truth, retained failure debt, scheduler route, Torghut consumer evidence, and profit-window state into
one admission decision.

The tradeoff is stricter launch ceremony. Some work that could technically run will wait until it names a custody
receipt and a debt class. I accept that because the business metric is not "more pods started." It is fewer failed
AgentRuns and shorter green PR-to-healthy GitOps rollout time with stronger ready-status truth.

## Evidence Snapshot

All evidence below was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
broker state, trading flags, or AgentRun objects.

### Cluster And Rollout

- `kubectl auth whoami` used `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset; in-cluster service account access was used for reads.
- Argo applications `agents`, `jangar`, `torghut`, `torghut-options`, `symphony-jangar`, and `symphony-torghut` were
  `Synced/Healthy` at revision `5b5e94d175626ac94d4ea3c5d9152522824e2bd3`.
- `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`; `deployment/agents-alloy` was `1/1`.
- Agents namespace pod phase counts were `371 Completed`, `79 Error`, `8 Running`, and `2 ContainerStatusUnknown`.
- Agents jobs counted `226 Complete`, `13 Failed`, and `4 Active`.
- AgentRun CRs counted `489 Succeeded`, `20 Failed`, `3 Running`, and `12 Template` in the database projection.
- Recent agents events showed successful current schedule CronJobs, but also readiness probe timeouts against
  `agents` and `agents-controllers`.
- Torghut pods were broadly available: ClickHouse, Keeper, Torghut live, Torghut sim, Torghut TA, Torghut TA sim,
  options catalog, options enricher, options TA, and WebSocket pods were running.
- Torghut events still showed repeated ClickHouse multiple-PDB warnings, no-pods keeper PDB warnings, and a current
  Torghut WebSocket readiness probe failure.

### Runtime And Source

- `http://agents.agents.svc.cluster.local/health` returned HTTP 200 with `agentsController.enabled=false`.
- `http://agents.agents.svc.cluster.local/ready` returned HTTP 200 and `execution_trust.status=healthy`, but the
  serving profile has no controller ingestion self-report.
- `http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200, and the status route carried current
  source-rollout truth from GitOps revision `fa3d104c...`.
- `http://torghut.torghut.svc.cluster.local/healthz` returned HTTP 200.
- `http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503 with `status=degraded`.
- Jangar status held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` on
  `controller_heartbeat_not_current` and watcher/controller witness refs, while `serve_readonly` and
  `torghut_observe` were allowed.
- Jangar status did not yet emit `ready_action_exchange` or `stage_clearance_packet`; both fields were `null`.
- Torghut consumer evidence was current through the `jangar.jangar` route with receipt
  `torghut-route-proven-profit:1e434d518ecd841b`, candidate `chip-paper-microbar-composite@execution-proof`,
  `decision=repair`, and `max_notional=0`.
- `services/jangar/src/server/supporting-primitives-controller.ts` is still a high-risk 3,325-line integration point
  for schedule generation, runtime admission, workspace PVC lifecycle, and swarm stage reconciliation.
- `services/jangar/src/server/control-plane-status.ts` is 793 lines and composes rollout truth, database health,
  watch reliability, source truth, material verdicts, and Torghut consumer evidence.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is 692 lines and already maps Torghut and
  controller degradation into action budgets.
- The existing tests cover schedule admission, material verdicts, controller witness, route stability, Torghut consumer
  evidence, quant metrics, and readiness. The missing test surface is the final action-custody invariant that prevents
  any stage from upgrading itself from a weaker receipt.

### Database And Data

- CNPG pod exec was forbidden, so database reads used the app database secret and direct Postgres connections inside
  `BEGIN READ ONLY`.
- Jangar schemas included `agents_control_plane`, `atlas`, `codex_judge`, `jangar_github`, `memories`, `public`,
  `terminals`, `torghut_control_plane`, and `workflow_comms`.
- `agents_control_plane.resources_current` estimated `3,950` live rows and had autoanalyze at
  `2026-05-08T16:26:13Z`.
- `agents_control_plane.component_heartbeats` had fresh rows, but `agents-controller`, `supporting-controller`, and
  `workflow-runtime` reported `enabled=false` and `status=disabled` while `orchestration-controller` was healthy.
- `workflow_comms.agent_messages` held `18,024` rows with newest `created_at=2026-05-08T16:25:23Z`.
- `memories.entries` held `1,152` rows with newest `created_at=2026-05-08T16:24:37Z`.
- `torghut_control_plane.quant_metrics_latest` had current rows, including `180` rows for account `PA3SX7FYNUTF` and
  window `15m` with newest update at `2026-05-08T16:26:23Z`.
- `torghut_control_plane.quant_pipeline_health` estimated `51,254,328` live rows and still had no sampled
  autovacuum/autoanalyze timestamp.
- Recent quant pipeline rows showed compute stages close to current, but ingestion lag reached `1,728,000` seconds and
  recent stage groups were not all OK.
- Torghut Postgres had `147,650` `trade_decisions`, newest `created_at=2026-05-08T15:22:46Z`, while newest
  `executed_at` remained `2026-04-02T20:59:45Z`.
- Torghut `execution_tca_metrics` had `13,775` rows across `12` symbols with newest `computed_at=2026-05-08T02:42:07Z`.
- Torghut promotion evidence stayed thin: `research_candidates=0`, `research_promotions=0`,
  `strategy_promotion_decisions=1` with `allowed_count=0`, and `vnext_promotion_decisions=0`.

## Problem

Jangar currently exposes useful receipts, but no one receipt is authoritative for an action.

The operator can see healthy Argo applications, running controller deployments, HTTP 200 readiness, fresh quant metrics,
current Torghut consumer evidence, and a degraded Torghut proof floor. Those facts are all true. The failure mode is
that each stage can pick the fact that suits its local goal:

1. A scheduled runner can point at a current runtime passport and ignore controller ingestion custody.
2. A deployer can point at Argo Healthy and ignore retained failed AgentRuns or missing controller self-report.
3. A merge-ready claim can point at green CI and ignore action verdict holds.
4. A Torghut paper candidate can point at current consumer evidence and ignore `max_notional=0`.
5. A quant repair run can point at fresh latest metrics and ignore stale pipeline stages or empty promotion evidence.
6. A status viewer can report `/ready=ok` while material actions are correctly held.

The control plane needs a custody receipt that makes the strongest applicable gate easy to consume and hard to bypass.

## Alternatives Considered

### Option A: Patch The Controller Self-Report And Keep Existing Verdicts

Fix the missing `agents-controller` self-report, then rely on existing material action verdicts.

Advantages:

- Directly addresses one current blocker.
- Low implementation surface.
- Likely reduces confusing `controller_heartbeat_not_current` holds.

Disadvantages:

- Does not stop future stages from cherry-picking weaker receipts.
- Does not bind Torghut profit windows to Jangar deployer and scheduler actions.
- Does not create a common handoff object for engineer, deployer, and validator stages.

Decision: reject as the architecture. It is a necessary repair, not the contract.

### Option B: Move All Profit And Capital Admission Into Torghut

Let Torghut own all paper/live action decisions and make Jangar a passive worker scheduler.

Advantages:

- Keeps capital authority near the trading service.
- Reduces Jangar coupling to Torghut proof payload internals.
- Easier to reason about broker safety.

Disadvantages:

- Jangar still launches the work that creates or fails to create evidence.
- Deploy and merge readiness remain Jangar control-plane decisions.
- Failed AgentRun reduction and PR-to-rollout latency cannot be solved inside Torghut alone.

Decision: reject. Torghut should remain the capital source of truth, but Jangar must own launch and deploy custody.

### Option C: Attested Action Custody With Profit-Window Admission

Publish a versioned custody receipt per action class. The receipt cites controller witness, source rollout truth,
route health, retained failure debt, scheduler launch evidence, Torghut consumer evidence, and profit-window state. A
stage may proceed only by citing the receipt and staying inside its allowed scope.

Advantages:

- Gives scheduler, deployer, validator, and Torghut consumers one compact admission object.
- Reduces failed AgentRuns by holding launches that lack current route and controller custody.
- Shortens green PR-to-rollout diagnosis because a held deploy names the exact missing proof.
- Preserves Torghut zero-notional safety while allowing named repair work.
- Turns status truth into action truth without making `/health` carry business semantics.

Disadvantages:

- Adds a new reducer and status projection.
- Requires careful naming so it does not duplicate existing material verdicts.
- Can reduce apparent throughput until teams attach receipts to work.

Decision: select Option C.

## Architecture

Jangar adds an `action_custody_receipt` projection in shadow mode first:

```text
action_custody_receipt
  schema_version
  receipt_id
  generated_at
  fresh_until
  namespace
  swarm_name
  stage
  action_class
  decision                    # allow | repair_only | hold | block
  allowed_scope
  max_dispatches
  max_runtime_seconds
  max_notional
  controller_witness_ref
  source_rollout_truth_ref
  scheduler_route_ref
  retained_failure_debt_ref
  material_action_verdict_ref
  torghut_consumer_evidence_ref
  torghut_profit_window_ref
  blocking_debt_classes[]
  forbidden_shortcuts[]
  required_repair_actions[]
  validation_commands[]
  rollout_gate
  rollback_gate
```

The receipt is not a replacement for existing reducers. It is the attestation wrapper that says which reducer wins for
which action class.

Initial action classes:

- `serve_readonly`
- `dispatch_repair`
- `dispatch_normal`
- `deploy_widen`
- `merge_ready`
- `torghut_observe`
- `paper_canary`
- `live_micro_canary`
- `live_scale`

Custody rules:

- `/health` cannot upgrade any custody receipt.
- Argo `Synced/Healthy` cannot upgrade `deploy_widen` without controller witness and retained-failure debt evidence.
- Current Torghut consumer evidence cannot upgrade paper or live action when `max_notional=0`.
- Fresh quant metrics cannot upgrade paper or live action when pipeline stages, market context, schema lineage, or
  promotion evidence are stale or missing.
- `dispatch_repair` may be `repair_only` only when the run names a debt class and a bounded runtime.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require a fresh controller ingestion witness or an explicit
  controller-witness carry receipt from the implementation of the controller-witness contract.
- `paper_canary`, `live_micro_canary`, and `live_scale` require Torghut profit-window admission and capital safety from
  the companion contract.

## Implementation Scope

Engineer milestone 1:

- Add a pure reducer under `services/jangar/src/server/control-plane-action-custody.ts`.
- Feed it from material action verdicts, controller witness, source rollout truth, retained failure debt, scheduler
  route status, Torghut consumer evidence, and Torghut profit-window admission.
- Emit the receipt set from `/api/agents/control-plane/status?namespace=agents`.
- Include a compact `ready_action_exchange` that points to the current custody receipts instead of duplicating them.
- Add unit tests for the live evidence shapes in this document.

Engineer milestone 2:

- Update scheduler launch checks so a scheduled run must cite a fresh custody receipt for its stage and action class.
- Keep `serve_readonly` separate from dispatch so HTTP serving can remain healthy during repair-only custody.
- Publish concise NATS/Jangar messages when a scheduled launch is held, naming the receipt id and smallest unblocker.

Deployer milestone:

- Extend post-deploy verification to require current `deploy_widen` and `merge_ready` custody receipts before calling a
  rollout ready.
- Verify Argo revision, workload readiness, Jangar `/ready`, Torghut `/readyz`, Torghut consumer evidence, and the
  custody receipt set after rollout.

## Validation Gates

- `failed_agentrun_rate`: scheduled launches without fresh route/controller custody must be held before creating runner
  pods; the next schedule window should show zero new failures from missing control-plane status custody.
- `pr_to_rollout_latency`: deployer handoff must include the `deploy_widen` and `merge_ready` receipt ids, Argo
  revision, workload readiness, and service health.
- `ready_status_truth`: `/ready=ok` is allowed for serving, but status must show held action custody when controller
  ingestion, retained failure debt, or Torghut proof windows are unsettled.
- `manual_intervention_count`: every held launch or deploy must name the blocking debt classes and smallest unblocker.
- `handoff_evidence_quality`: every implementation and verification PR must cite this design before changing the
  scheduler, status, deploy, or Torghut admission paths.

## Rollout

1. Ship the reducer and status projection in observe mode.
2. Compare custody decisions against existing material action verdicts and Torghut proof-floor decisions for one
   schedule window.
3. Enforce custody for scheduled `dispatch_normal`, `deploy_widen`, and `merge_ready`.
4. Enforce custody for Torghut paper/live action only after the companion Torghut profit-window admission is current.
5. Keep NATS updates concise: receipt id, decision, top blockers, next repair action.

## Rollback

- Disable custody enforcement and keep observe-only receipts visible.
- Keep existing material action verdicts, proof floor, and Torghut submission gate as the fallback safety boundary.
- Do not loosen Torghut notional, submission, slippage, alpha readiness, or promotion gates as a rollback.
- If controller quorum regresses or status route latency spikes, hold `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `paper_canary`, `live_micro_canary`, and `live_scale`; allow only `serve_readonly` and explicitly bounded diagnostics.

## Risks And Tradeoffs

- Receipt sprawl: Jangar already has many evidence objects. Mitigation: custody receipts wrap existing refs instead of
  copying full payloads.
- False holds: a missing controller self-report can hold safe repair. Mitigation: `dispatch_repair` can remain
  `repair_only` when a controller-witness carry receipt is current and max runtime is bounded.
- Coupling to Torghut payloads: profit-window admission creates a cross-service contract. Mitigation: consume versioned
  Torghut refs and fail closed for paper/live while allowing diagnostics.
- Throughput loss: fewer runnable jobs may start. Mitigation: the target is fewer failed AgentRuns and faster diagnosis,
  not raw launch count.

## Handoff

Engineer handoff: implement `control-plane-action-custody.ts`, add focused tests, and project the receipt set from the
control-plane status route. The first implementation must prove that `serve_readonly=allow` can coexist with
`dispatch_normal=hold`, `deploy_widen=hold`, and `paper_canary=hold` when controller ingestion is missing and Torghut
is repair-only.

Deployer handoff: deploy observe-only first. Acceptance requires current custody receipts, Argo `Synced/Healthy`,
Jangar and agents `/ready` reachable, Torghut `/healthz` reachable, Torghut `/readyz` reason captured, and no
non-zero Torghut notional while paper/live receipts are held.
