# 161. Jangar Repair Outcome Brownout Market And Stage Freeze Clearing (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, stale-stage brownout behavior, repair outcome clearing, Torghut
zero-notional repair authority, validation, rollout, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/165-torghut-outcome-priced-repair-market-and-capital-shadow-swaps-2026-05-07.md`

Extends:

- `160-jangar-split-authority-repair-escrow-and-dispatch-reentry-packets-2026-05-07.md`
- `159-jangar-authority-surface-settlement-and-quant-stage-cohort-gates-2026-05-07.md`
- `159-jangar-closed-loop-repair-outcome-ledger-and-material-action-reentry-2026-05-07.md`

## Decision

I am selecting a repair outcome brownout market with stage-freeze clearing as the next Jangar control-plane
architecture step.

The current system is not down. Jangar, Agents, NATS, and the current Torghut serving revisions are up. Runtime kits
are present, the collaboration toolchain is healthy, controller rollouts are available, database projection is healthy,
and control-plane watches are healthy over the current 15 minute window. That is materially better than the earlier
degraded-runtime state.

The remaining risk is different: action authority is still split. Jangar execution trust is degraded because the
Jangar verify stage is stale. Source rollout truth is in `heartbeat_projection_split`. AgentRun ingestion is reported
as `unknown` even though the controller rollouts and watch streams are active. Route-stability escrow permits
`serve_readonly` and `torghut_observe`, but it holds repair dispatch, normal dispatch, deploy widen, merge readiness,
and paper canary, and blocks live capital. Agents events still show recent readiness probe timeouts and missing
ConfigMap mounts on verify pods.

The correct Jangar behavior is not to treat that brownout as either full outage or full admission. Jangar should allow
bounded outcome measurement for Torghut repairs that cannot spend notional, and it should refuse to clear dispatch,
merge, paper, or live capital until the repair produces a before/after outcome receipt and the stale stage clears.

The tradeoff is that this adds a clearing layer before normal material actions can resume. I accept that. Without a
clearing layer, every repair packet competes by urgency instead of measured value, and stale verify evidence keeps
humans interpreting large status payloads instead of using one auditable decision.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `repair_outcome_brownout_market`.
- The payload names the active brownout cause: stale stage, swarm freeze, source rollout split, controller witness
  split, missing workflow artifact, or degraded empirical service.
- Jangar distinguishes `observe`, `measure_outcome`, `dispatch_repair`, `dispatch_normal`, `merge_ready`,
  `paper_canary`, `live_micro_canary`, and `live_scale`.
- `observe` and `measure_outcome` can be allowed during a stage brownout when runtime kits, database, watches, and the
  Torghut zero-notional proof floor are current.
- `dispatch_repair` remains held until the repair has a Jangar-owned packet, an owner, a TTL, max dispatches, max
  runtime, max notional `0`, and a before/after receipt contract.
- `dispatch_normal`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require stage-freeze clearing,
  source/GitOps truth, controller ingestion witness, route stability, fresh empirical proof, and Torghut capital gates.
- Every rejection gives one brownout market ID, one stale-stage receipt or repair outcome receipt ID, and finite reason
  codes.
- The deployer can answer whether a repair is blocked, measurable, or capital-relevant without reading raw status JSON.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 around 19:08Z-19:13Z. I did not mutate Kubernetes resources, database
records, ClickHouse data, broker state, GitOps resources, AgentRun objects, or trading flags.

### Cluster And Rollout Evidence

- The workspace branch was `codex/swarm-torghut-quant-discover` based on `origin/main` at `479774066`.
- `kubectl auth whoami` succeeded as `system:serviceaccount:agents:agents-sa`; the local kube context had to be
  bootstrapped from the in-cluster service account.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar pods were available: `jangar=2/2`, `bumba=1/1`, `symphony-jangar=1/1`, and `jangar-db=1/1`.
- Torghut live and simulation revisions were available: `torghut-00278=2/2` and `torghut-sim-00378=2/2`.
- Argo CD reported `agents`, `jangar`, `torghut`, and `torghut-options` as `Synced/Healthy`.
- Cluster-wide residual risk remained: `cloudnative-pg`, `redis-operator`, `keycloak`, `temporal`, and
  `forgejo-runners` were progressing, and `rook-ceph` was degraded.
- Recent Agents events showed readiness probe timeouts on `agents` and both controller pods, then successful rollout
  to the current replicas.
- Recent Agents events still showed missing ConfigMap mounts for Torghut and Jangar verify pods.
- Recent Torghut events showed rollout/startup probe failures during the latest revision handoff, then readiness for
  current live and simulation revisions.

### Jangar Status Evidence

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok` for serving, but its execution-trust block
  was degraded by a stale verify stage and swarm freeze windows.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` reported runtime
  adapters `workflow`, `job`, and `temporal` configured.
- Runtime kits for serving and collaboration were healthy; `codex-nats-publish`, `codex-nats-soak`, and `nats` were
  present.
- `watch_reliability.status=healthy` with two streams, more than 1500 AgentRun events in the window, zero errors, and
  zero restarts.
- `execution_trust.status=degraded` because `jangar-control-plane:verify` was stale.
- `agentrun_ingestion.status=unknown` with message `agents controller not started`.
- `source_rollout_truth_exchange.deployer_summary.settlement_state=heartbeat_projection_split`.
- `route_stability_escrow.route_stability_window.state=escrow_repair_only`.
- Route-stability escrow allowed `serve_readonly` and `torghut_observe`, held `dispatch_repair`, `dispatch_normal`,
  `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked `live_micro_canary` and `live_scale`.
- Jangar empirical services were not authoritative: forecast was `degraded` with `registry_empty`, Lean was
  `disabled`, and jobs were `degraded` because all required empirical job classes were stale.

### Torghut Evidence Consumed By Jangar

- Torghut liveness returned `{"status":"ok","service":"torghut"}`.
- Torghut `/db-check` returned `ok=true`, expected/current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one graph branch, no duplicate revisions, and lineage ready.
- Direct CNPG `psql` was blocked by RBAC: the service account cannot create `pods/exec` in namespace `torghut`.
  Typed HTTP readiness and status endpoints are therefore the database witnesses for this pass.
- Live `/trading/health` returned `status=degraded`; proof floor was `repair_only`, capital state was
  `zero_notional`, and `max_notional=0`.
- Live submission was closed by `simple_submit_disabled`; alpha readiness had three shadow hypotheses, zero promotion
  eligible, and three rollback required.
- Live routeability had zero routeable symbols, five blocked symbols, and three missing symbols.
- Jangar quant health for the live account had 144 latest metrics and an update inside the current minute, but stage
  coverage was empty and the endpoint still alternated between ok/degraded states as pipeline evidence arrived.
- Simulation `/trading/health` returned `status=ok` operationally, but its proof floor remained `repair_only` with
  one probing symbol, seven missing symbols, empty quant latest metrics, and zero notional.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and already assembles runtime adapters, execution
  trust, database projection, watch reliability, route stability, source rollout truth, material verdicts, and
  empirical services.
- `services/jangar/src/server/torghut-quant-metrics.ts` is 928 lines and already separates latest metric freshness
  from stage health.
- `services/torghut/app/trading/proof_floor.py`, `route_reacquisition.py`, `revenue_repair.py`, and
  `submission_council.py` already expose the Torghut proof and repair ingredients Jangar needs to consume.
- The missing source surface is a clearing reducer that turns brownout-safe repair attempts into settled outcomes
  instead of more status fragments.

## Problem

Jangar currently has enough data to hold dangerous actions, but not enough structure to choose useful repairs during a
stale-stage brownout.

The failure modes are specific:

1. A stale verify stage degrades execution trust even when the current serving and controller rollouts are healthy.
2. Source rollout truth can hold material actions even while route-stability escrow allows observation.
3. AgentRun ingestion can be unknown while watch reliability and controller deployments are healthy.
4. Torghut can prove zero notional and active repair candidates, but Jangar still has no outcome-clearing object that
   says whether a repair was worth spending dispatch capacity.
5. Deployer and engineer stages can see many true facts but still lack a single auditable decision for brownout repair.

If Jangar blocks all repair during this state, Torghut cannot retire stale empirical, quant, route, or context proof.
If Jangar allows repair by default, stale verify and source split are bypassed. The architecture needs a third path:
bounded measurement with zero capital authority.

## Alternatives Considered

### Option A: Block All Actions Until Verify Is Fresh

Pros:

- Simple and strongly fail-closed.
- No new reducer or status schema.
- Avoids accidental dispatch during source rollout split.

Cons:

- Prevents zero-notional Torghut repairs that could clear the stale proof blocking future stages.
- Keeps stale empirical jobs, missing route symbols, and simulation proof debt aging while the control plane waits.
- Treats observation, repair measurement, normal dispatch, merge, paper, and live capital as the same risk.

Decision: reject. This is safe, but it stops the work that makes the system safer.

### Option B: Let Route-Stability Escrow Allow Repair Dispatch Directly

Pros:

- Uses an existing Jangar payload.
- Moves faster than a full stage-clear requirement.
- Keeps live capital blocked.

Cons:

- Route-stability escrow currently holds `dispatch_repair`; using it to bypass its own hold would be incoherent.
- It does not price repairs by outcome or require before/after settlement.
- It does not address stale verify, source rollout split, or unknown AgentRun ingestion as independent brownout causes.

Decision: reject. It is too loose for the current evidence.

### Option C: Add Repair Outcome Brownout Market And Stage-Freeze Clearing

Pros:

- Allows only observation and outcome measurement during brownout.
- Requires every repair to publish zero-notional limits, TTLs, packet refs, and before/after receipt contracts.
- Converts stale-stage recovery from a manual interpretation problem into a finite decision payload.
- Gives deployer a compact rule: no normal dispatch, merge, paper, or live action until outcome and stage clearing
  receipts exist.

Cons:

- Adds a new status reducer and schema.
- Requires repair jobs to emit receipts even when they only measure.
- Keeps dispatch repair held until the contract exists, which is slower than ad hoc manual repair.

Decision: select Option C.

## Architecture

Add `repair_outcome_brownout_market` under `services/jangar/src/server/`. It is a pure reducer. It does not call
Kubernetes, databases, GitHub, Temporal, or Torghut directly. It consumes already assembled status evidence.

Inputs:

- `execution_trust`
- `route_stability_escrow`
- `source_rollout_truth_exchange`
- `agentrun_ingestion`
- `watch_reliability`
- `database`
- `runtime_kits`
- `runtime_adapters`
- `empirical_services`
- Torghut proof floor summary, when present in status assembly
- Torghut repair packet refs, when present

`RepairOutcomeBrownoutMarket` fields:

- `market_id`
- `generated_at`
- `fresh_until`
- `namespace`
- `brownout_state`: `clear`, `measurement_only`, `dispatch_hold`, or `block`
- `brownout_causes`
- `allowed_action_classes`
- `held_action_classes`
- `blocked_action_classes`
- `stage_freeze_receipt_ref`
- `route_stability_escrow_ref`
- `source_rollout_truth_ref`
- `controller_ingestion_ref`
- `watch_reliability_ref`
- `runtime_kit_refs`
- `repair_outcome_bids`
- `clearing_receipts`
- `decision_by_action_class`
- `rollback_target`

`RepairOutcomeBid` fields:

- `bid_id`
- `packet_ref`
- `repair_class`
- `target_blocker`
- `consumer`: `torghut`
- `requested_action_class`: `observe`, `measure_outcome`, or `dispatch_repair`
- `max_notional`: always `0` for brownout measurement
- `max_dispatches`
- `max_runtime_seconds`
- `before_ref`
- `required_after_ref`
- `expected_unblock_value`
- `admission_decision`: `allow_measurement`, `hold_dispatch`, or `block`
- `reason_codes`
- `expires_at`

`StageFreezeClearingReceipt` fields:

- `receipt_id`
- `stage_ref`
- `before_status`
- `after_status`
- `cleared_at`
- `stale_seconds_before`
- `observed_stage_run_ref`
- `remaining_blockers`
- `action_classes_released`
- `action_classes_still_held`

Decision rules:

- `observe` is allowed when serving, database, runtime kits, and watch reliability are fresh.
- `measure_outcome` is allowed when the Torghut packet is zero-notional and has a before/after receipt contract.
- `dispatch_repair` is held when source rollout truth, controller ingestion, or stale verify is unresolved.
- `dispatch_normal`, `merge_ready`, and `paper_canary` require no brownout causes and at least one successful clearing
  receipt for the stale stage.
- `live_micro_canary` and `live_scale` are blocked whenever Torghut proof floor is `repair_only` or capital state is
  `zero_notional`.

## Failure-Mode Reduction

This design reduces the current failure modes directly:

- Stale verify no longer forces total inactivity; it allows measurement only, with zero notional and short TTLs.
- Healthy serving cannot be mistaken for material authority because action classes remain separated.
- Unknown AgentRun ingestion remains a blocker for dispatch, but not for read-only outcome measurement.
- Source rollout split cannot be bypassed by repair jobs because `dispatch_repair` remains held.
- Torghut repair evidence has to settle before Jangar can spend more dispatch capacity.

## Engineer Implementation Scope

1. Add the pure reducer and types under `services/jangar/src/server/`.
2. Wire the reducer into the control-plane status payload in shadow mode.
3. Add fixture tests for stale verify, source rollout split, unknown AgentRun ingestion, healthy watches, and
   zero-notional Torghut repair packets.
4. Add tests proving `measure_outcome` can be allowed while `dispatch_repair`, `merge_ready`, `paper_canary`, and live
   capital remain held or blocked.
5. Add tests proving missing before/after receipt contracts block measurement.
6. Keep all existing material action decisions unchanged until the shadow payload has deployer adoption.

## Deployer Acceptance Gates

Before deployer can treat the payload as authoritative:

- `bun run --filter jangar test -- control-plane-status` passes.
- The status route includes `repair_outcome_brownout_market.market_id`.
- Stale verify produces `brownout_state=measurement_only` or stricter; it never produces normal dispatch authority.
- Source rollout split keeps `dispatch_repair`, `dispatch_normal`, `merge_ready`, `paper_canary`, and live capital held
  or blocked.
- A Torghut repair bid with `max_notional>0` is rejected.
- A repair bid without `before_ref` and `required_after_ref` is rejected.
- The payload cites route-stability escrow, source rollout truth, watch reliability, and stage-freeze refs.

## Rollout Plan

1. Ship the reducer in shadow mode and emit it from status without changing existing decisions.
2. Compare deployer output against existing route-stability and material action receipts for at least one full verify
   cadence.
3. Allow `measure_outcome` consumers to cite the payload only for zero-notional Torghut repairs.
4. After a successful stage-freeze clearing receipt, allow deployer to use it as a prerequisite for repair dispatch.
5. Promote to enforcement only after the payload has stable reason codes and no disagreement with existing holds.

## Rollback Plan

- Hide `repair_outcome_brownout_market` from deployer enforcement while keeping it in status for diagnostics.
- Fall back to existing `route_stability_escrow` and `source_rollout_truth_exchange` decisions.
- Keep Torghut in observe mode and zero notional.
- Treat all missing or malformed brownout-market payloads as `dispatch_hold`.
- Do not delete historical clearing receipts; mark them `shadow_ignored` if the reducer is rolled back.

## Risks

- The reducer can become another status object that no one enforces. Mitigation: require deployer gates to cite the
  market ID and receipt IDs.
- Measurement jobs can still consume scarce runner capacity. Mitigation: max dispatches, short TTLs, and outcome ROI
  requirements.
- A stale stage can clear while source rollout truth remains split. Mitigation: action classes require both stage and
  source clearing before material authority.
- Torghut can produce many repair bids. Mitigation: accept only ranked bids with finite expected unblock value and
  zero notional during brownout.

## Handoff To Engineer And Deployer

Engineer should implement the brownout market as a pure shadow reducer first. Do not change live material action
admission until tests prove stale verify, source split, unknown ingestion, and zero-notional Torghut packets behave
exactly as described.

Deployer should keep normal dispatch, merge readiness, paper canary, and live capital held until there is one
stage-freeze clearing receipt and one repair outcome receipt for the target blocker. Observation can continue.
Outcome measurement can run only when the packet is zero-notional, bounded, and has a before/after contract.
