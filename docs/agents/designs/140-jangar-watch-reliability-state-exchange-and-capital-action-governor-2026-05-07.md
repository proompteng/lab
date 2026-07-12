# 140. Jangar Watch Reliability State Exchange And Capital Action Governor (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane reliability, watch restart failure modes, stale stage settlement, Torghut capital action
receipts, safe rollout, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/144-torghut-state-coherent-profit-auction-and-tca-renewal-governor-2026-05-07.md`

Extends:

- `136-jangar-controller-authority-settlement-and-endpoint-parity-ledger-2026-05-07.md`
- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
- `134-jangar-evidence-census-and-projection-settlement-exchange-2026-05-07.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting **a watch-reliability state exchange with a capital action governor** as the next Jangar architecture
step.

The current cluster is not down. That is the important point. Jangar is serving, leader election is healthy, the
database is connected, migration consistency is green, and runtime kits are healthy. The failure mode is subtler and
more dangerous for downstream automation: watch reliability is blocked while serving, repair, and observe can still
look locally healthy.

At `2026-05-07T09:30Z`, Jangar status reported database latency of `3` ms, `28` registered migrations, `28` applied
migrations, and no unexpected migrations. The same response reported execution trust healthy. Watch reliability was
degraded in the latest 15 minute window with `1,133` events, `4` watch errors, and `9` restarts across five streams,
which pushed dependency quorum to `block` with `watch_reliability_blocked`. Material action verdicts allowed
`serve_readonly`, `dispatch_repair`, and `torghut_observe`, held `dispatch_normal`, `deploy_widen`, `merge_ready`, and
`paper_canary`, and blocked `live_micro_canary` and `live_scale`.

That behavior is directionally right, but the contract is still too implicit. A downstream client has to infer why
observe is allowed, repair is allowed, deploy widening is held, and live capital is blocked. The selected design makes
that explicit: Jangar will emit a short-lived state exchange receipt that separates serving availability, repair
authority, normal dispatch, merge readiness, deploy widening, paper canary, and live capital authority.

The tradeoff is stricter gates during noisy watch windows. I accept that. The six-month risk is not that we delay one
deployment by a few minutes. The risk is that a local green status and a degraded watch stream are read as the same
kind of evidence.

## Runtime Objective And Success Metrics

Success means:

- Jangar keeps serving read-only traffic when runtime kits, leader election, and database health are good.
- `dispatch_repair` remains available when watch reliability is degraded but repair evidence is fresh.
- `dispatch_normal`, `merge_ready`, `deploy_widen`, `paper_canary`, `live_micro_canary`, and `live_scale` require a
  fresh state exchange receipt.
- The state exchange names watch error counts, watch restart counts, stale stage windows, database projection state,
  controller witness state, and Torghut consumer evidence state.
- A stale verify stage can degrade serving and repair decisions without silently widening deploy or capital authority.
- A watch reliability breach always maps to an action class: observe allowed, repair bounded, normal dispatch held,
  deploy widening held, paper held, live blocked.
- Deployer rollback can disable enforcement while leaving shadow receipts visible.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps state, broker state,
trading flags, or AgentRun records.

### NATS Context

The latest shared NATS context before this pass said an earlier plan selected Jangar runtime cells and Torghut proof
exchange because Jangar was serving while control-plane trust was degraded, and Torghut liveness was green while
DB-backed readiness/status had timed out. I treated that as shared state and rechecked the current cluster instead of
copying it forward as fresh evidence.

### Cluster, Rollout, And Event Evidence

- `kubectl get pods -n jangar -o wide` showed `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI,
  `symphony`, and `symphony-jangar` all Running.
- `kubectl get deploy -n jangar` showed `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar`
  available.
- Jangar events showed the current pod `jangar-75d54f6fbc-5cs4r` rolled about 7 minutes before the assessment, with a
  transient readiness probe failure during startup.
- Jangar logs showed repeated watch failures for approval policies, jobs, and orchestrations with `Too Many Requests`.
- Jangar logs also showed unresolved Git refs for several swarm branches, including this plan branch before it was
  pushed again.
- `kubectl config current-context` was unset in this workspace, but explicit namespace Kubernetes reads still worked
  through the in-cluster service account.

### Jangar Endpoint And Database Evidence

- `GET /ready` returned `status=ok`, with leader election healthy and runtime kit proofs current. Its embedded
  execution-trust block still reported the plan stage stale, while the control-plane status route below reported
  execution trust healthy; that route divergence is another reason clients need one explicit action receipt.
- `GET /api/agents/control-plane/status?namespace=agents` returned:
  - `generated_at=2026-05-07T09:30:23.907Z`;
  - `execution_trust.status=healthy`;
  - `execution_trust.reason="execution trust is healthy."`;
  - database `configured=true`, `connected=true`, `status=healthy`, `latency_ms=3`;
  - migration consistency `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`;
  - latest registered and applied migration `20260505_torghut_quant_pipeline_health_window_index`;
  - `watch_reliability.status=degraded`;
  - `watch_reliability.window_minutes=15`;
  - `watch_reliability.total_events=1133`;
  - `watch_reliability.total_errors=4`;
  - `watch_reliability.total_restarts=9`;
  - `dependency_quorum.decision=block`;
  - `dependency_quorum.reasons=["watch_reliability_blocked"]`.
- The degraded streams were approval policies with `2` errors and `4` restarts, jobs with `1` error and `2` restarts,
  orchestrations with `1` error and `2` restarts, signal deliveries with `1` restart, and AgentRuns with `1,131`
  events.
- The status response allowed `serve_readonly`, bounded `dispatch_repair`, and `torghut_observe`; held
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; and blocked `live_micro_canary` and
  `live_scale`.
- Direct SQL and direct ClickHouse checks were not available from this run because `pods/exec` is forbidden in the
  `torghut` namespace, and CNPG cluster listing is forbidden.

### Torghut Consumer Evidence

- Torghut `/trading/health` reported Postgres, ClickHouse, Alpaca, universe, empirical jobs, DSPy runtime, and quant
  evidence dependencies as reachable or informational, but overall status was degraded.
- Torghut alpha readiness reported three hypotheses, zero promotion eligible, three rollback required, and dependency
  quorum delayed or blocked by Jangar watch reliability.
- Torghut proof floor was `repair_only`, capital state `zero_notional`, with blocking reasons
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- TCA evidence was stale from `2026-04-02T20:59:45.136640Z`; average absolute slippage was about `568.61` bps against
  an `8` bps guardrail.
- Quant latest metrics were fresh, but scoped stage evidence was still degraded: `stage_count=3`, compute and
  materialization were current, and ingestion lag was `56,689` seconds.
- Jangar therefore has to distinguish "Torghut observe/repair can proceed" from "Torghut paper/live capital can
  proceed".

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is already the right aggregation boundary for controller,
  database, watch, runtime kit, execution trust, and empirical service state.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already emits material action classes and
  current hold/block decisions.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already carries negative evidence for watch
  reliability, Torghut consumer gaps, forecast degradation, and action contradictions.
- `services/jangar/src/routes/api/agents/control-plane/status.ts` exposes the status contract to Torghut and deployer
  workflows.
- The missing source contract is the reducer that turns those facts into a stable state exchange receipt with explicit
  action-class consequences.

## Problem

Jangar has reliable enough serving health and database health, but it lacks a compact state exchange for clients that
need to decide whether an action is only observable, repairable, deployable, paper-safe, or live-safe.

The current status route contains enough data to make that decision. The problem is that the decision is distributed
across execution trust, watch reliability, material action receipts, empirical service status, database consistency,
and Torghut consumer evidence. That makes the system hard to audit during a noisy watch window.

This matters because Torghut consumes Jangar as capital authority. A watch restart storm is not the same as a failed
database migration. A stale verify stage is not the same as a missing runtime kit. A fresh quant latest store is not
the same as paper capital authority. The control plane should say those distinctions plainly.

## Alternatives Considered

### Option A: Keep The Endpoint Parity Ledger As The Sole Gate

Pros:

- Builds on the accepted endpoint parity contract.
- Avoids another status shape.
- Keeps the design surface small.

Cons:

- Endpoint parity says whether surfaces agree; it does not price the action class consequence of watch errors.
- It can still leave Torghut to interpret whether a degraded parity epoch means observe, repair, paper hold, or live
  block.
- It does not give deployer workflows a bounded repair allowance while holding widen/merge.

Decision: reject as the sole gate.

### Option B: Use One Global Watch Reliability Gate

Pros:

- Easy to implement.
- Safe for material actions.
- Easy to explain during incidents.

Cons:

- It would stop zero-notional repair and observe work even when that work is exactly how the control plane recovers.
- It treats AgentRun watch noise and live capital authority as one binary state.
- It creates false coupling between Jangar reliability repair and Torghut evidence collection.

Decision: reject.

### Option C: Watch-Reliability State Exchange And Capital Action Governor

Pros:

- Separates read-only serve, observe, repair, normal dispatch, deploy widen, paper, and live authority.
- Converts watch errors and stale stages into explicit action consequences.
- Allows repair under degraded watch reliability without widening rollout or capital.
- Gives Torghut a single receipt to cite in its profit-state auction.
- Keeps rollback simple: shadow the receipt, hold material actions, and preserve serve/repair.

Cons:

- Requires a new reducer and fixture set.
- Requires deployer workflows to check one more receipt.
- Requires tuning watch thresholds so transient API throttling does not hold too much for too long.

Decision: select Option C.

## Architecture

Jangar emits one state exchange receipt per namespace and status window.

```text
control_plane_state_exchange_receipt
  receipt_id
  namespace
  generated_at
  fresh_until
  parity_epoch_ref
  database_projection_ref
  controller_witness_ref
  watch_reliability_ref
  execution_trust_ref
  torghut_consumer_ref
  action_states[]
  required_repairs[]
  rollback_target
```

Each action state is explicit.

```text
control_plane_action_state
  action_class                 # serve_readonly, torghut_observe, dispatch_repair, dispatch_normal,
                               # merge_ready, deploy_widen, paper_canary, live_micro_canary, live_scale
  decision                     # allow, hold, block
  authority_level              # serving, observe, repair, deploy, paper, live
  max_dispatches
  max_runtime_seconds
  max_notional
  positive_refs[]
  negative_refs[]
  reason_codes[]
  required_repairs[]
```

The watch reliability reducer uses the existing status evidence:

- `watch_reliability.status`;
- per-stream error count;
- per-stream restart count;
- last seen timestamp;
- stale stage windows from execution trust;
- controller witness state;
- database projection health.

Initial action policy:

| State evidence                                | Serve | Observe | Repair        | Normal dispatch | Merge ready | Deploy widen          | Paper                 | Live                 |
| --------------------------------------------- | ----- | ------- | ------------- | --------------- | ----------- | --------------------- | --------------------- | -------------------- |
| Database unhealthy or migrations inconsistent | hold  | hold    | hold          | block           | block       | block                 | block                 | block                |
| Runtime kit missing                           | block | block   | block         | block           | block       | block                 | block                 | block                |
| Watch reliability degraded only               | allow | allow   | allow bounded | hold            | hold        | hold                  | hold                  | block                |
| Stale verify stage only                       | allow | allow   | allow bounded | hold            | hold        | hold                  | hold                  | block                |
| Torghut consumer evidence missing             | allow | allow   | allow bounded | hold            | hold        | hold                  | hold                  | block                |
| All authority current                         | allow | allow   | allow         | allow           | allow       | allow by rollout ring | paper by Torghut gate | live by Torghut gate |

## Implementation Scope For Engineer

1. Add a state exchange reducer under `services/jangar/src/server/`.
2. Feed it from the existing status inputs rather than adding new Kubernetes scans.
3. Add `state_exchange_receipt` and `state_exchange_ref` to material action receipts.
4. Extend `/api/agents/control-plane/status` with the new receipt in shadow mode first.
5. Add focused tests for:
   - watch reliability degraded with healthy database;
   - stale verify stage with fresh runtime kits;
   - Torghut consumer evidence missing;
   - database migration inconsistency;
   - all authority current.
6. Update deploy verification so `merge_ready` and `deploy_widen` must cite a fresh state exchange receipt before
   widening beyond the current rollout ring.

## Validation Gates

Engineer acceptance:

- Unit tests cover every row in the initial action policy table.
- Status route snapshot tests prove `state_exchange_ref` appears on `deploy_widen`, `merge_ready`, `paper_canary`, and
  `live_micro_canary` receipts.
- Existing endpoint parity and material action tests still pass.
- The reducer never performs direct database or Kubernetes calls; it consumes bounded status inputs.

Deployer acceptance:

- `curl -sS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.state_exchange_receipt'`
  returns a fresh receipt.
- During degraded watch reliability, `serve_readonly`, `torghut_observe`, and bounded `dispatch_repair` are allowed,
  while `merge_ready`, `deploy_widen`, paper, and live are held or blocked.
- During a clean window, `merge_ready` and `deploy_widen` move only after the receipt is fresh and the deploy ring is
  current.
- Torghut `/trading/health` can cite the receipt when explaining `watch_reliability_blocked`.

## Rollout

1. Ship the receipt in shadow mode with no behavior change.
2. Compare receipt decisions against existing material action receipts for at least one full Jangar plan/implement/verify
   cycle.
3. Enforce the receipt for `merge_ready` and `deploy_widen`.
4. Enforce the receipt for Torghut `paper_canary`.
5. Enforce the receipt for Torghut live classes only after paper receipts prove no false allows.

## Rollback

If the reducer creates false holds:

- keep `/health`, `/ready`, and status route serving;
- disable enforcement while leaving `state_exchange_receipt.shadow=true`;
- fall back to existing material action receipts and endpoint parity receipts;
- keep Torghut paper/live capital at zero notional until the false-hold root cause is fixed.

If the reducer creates a false allow:

- immediately force `merge_ready`, `deploy_widen`, paper, and live action states to `hold` or `block`;
- keep repair dispatch bounded;
- record the failed receipt id in deploy verification and Torghut handoff artifacts;
- require a new test fixture before re-enabling enforcement.

## Risks

- Watch reliability thresholds can be too sensitive during Kubernetes API throttling.
- A state exchange receipt can become another unread field unless deployer and Torghut consumers are required to cite
  it.
- Direct database and ClickHouse reads remain RBAC-blocked from this agent runtime, so deployer validation must use
  typed service status until read-only SQL access is granted.

## Handoff

Engineer should build the reducer as a pure function over existing status inputs and keep all new tests fixture-based.
Do not add route-time scans. The implementation is successful when the same evidence that currently appears across
watch reliability, execution trust, material action receipts, and Torghut consumer state is condensed into one
short-lived receipt.

Deployer should treat the receipt as a material-action passport. Read-only serve and repair can continue under degraded
watch reliability; merge, deploy widen, paper, and live cannot move without a fresh allow state.
