# 142. Jangar Repair Dividend Handoff Gates And Actuation Contracts (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, repair dividend settlement, action-class actuation, rollout validation, rollback,
and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/146-torghut-submission-quorum-handoff-and-profit-repair-gates-2026-05-07.md`

Extends:

- `141-jangar-controller-witness-escrow-and-repair-dividend-settlement-2026-05-07.md`
- `141-jangar-proof-renewal-leases-and-trading-state-custody-2026-05-07.md`
- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md`

## Decision

I am selecting **repair dividend handoff gates with explicit actuation contracts** as the plan-stage architecture
direction for the next engineer and deployer lanes.

The current cluster is not down. At `2026-05-07T10:23Z`, the Jangar serving deployment was available, the controllers
deployment was `2/2`, leader election had a holder, `/ready` returned `status=ok`, execution trust was healthy,
runtime kits were fresh, and the Jangar database projection reported `28` registered Kysely migrations, `28` applied
migrations, zero unapplied migrations, zero unexpected migrations, and `4` ms latency.

The control plane still should not graduate material action. The same status route reported
`watch_reliability.status=degraded` with `1,253` events, `0` errors, and `637` restarts across six streams in the
latest 15 minute window. Kubernetes events also showed recent serving and controller readiness probe failures, and one
controller pod had restarted twice within the assessment window. The material action receipts are doing the right
thing: `serve_readonly`, `dispatch_repair`, and `torghut_observe` are allowed; `dispatch_normal`, `deploy_widen`,
`merge_ready`, and `paper_canary` are held; live capital classes are blocked.

The decision is to make that behavior durable and testable. Jangar should not rely on a human reading many route fields
to know whether a repair can graduate action authority. The engineer lane should implement a reducer that turns
negative evidence into bounded repair leases, accepts repair dividends only when the source witness recovers, and emits
one actuation contract per material action class. The deployer lane should roll this out in shadow first, then enforce
it only when shadow receipts match the existing material action decisions.

The tradeoff is stricter graduation. Normal dispatch and merge-ready can remain held even when deployments and database
checks are green. I accept that because the current risk is not availability; it is acting on optimistic rollout health
while watch and downstream trading proof are still degraded.

## Runtime Objective And Success Metrics

Success means:

- Jangar keeps serving read-only traffic when runtime kits, leader election, and database projection are healthy.
- `dispatch_repair` stays available during watch degradation, but every repair launch cites a lease with an expiry,
  target witness, max dispatch count, max runtime, and settlement gate.
- A repair dividend can graduate an action class only after the degraded source witness improves, not merely after a
  repair job exits successfully.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` remain held while watch reliability,
  AgentRun ingestion, Torghut consumer evidence, or forecast authority are still negative.
- `live_micro_canary` and `live_scale` remain blocked unless the Jangar action contract and Torghut submission quorum
  both allow them.
- The status route exposes open leases, pending dividends, accepted dividends, rejected dividends, and action
  graduation state without requiring pod exec or secret reads.
- Rollback can shadow the new reducer while preserving the underlying negative evidence and current action receipts.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, GitOps
resources, trading flags, AgentRun objects, or empirical artifacts.

### Cluster, Rollout, And Event Evidence

- `kubectl auth whoami` identified this runner as `system:serviceaccount:agents:agents-sa`.
- `deployment/agents` was available `1/1` on image
  `registry.ide-newton.ts.net/lab/jangar-control-plane:f0ab857e`.
- `deployment/agents-controllers` was available `2/2` on image `registry.ide-newton.ts.net/lab/jangar:f0ab857e`.
- The leader lease `jangar-controller-leader` was held by an `agents-controllers` pod.
- Current scheduled Jangar and Torghut quant CronJobs use the `f0ab857e` Jangar image. The latest scheduled plan,
  discover, verify, and Torghut quant runner jobs completed, while older attempts from roughly six hours earlier remain
  in `Error` or `Failed` state.
- Recent warning events included serving readiness probe timeouts, controller readiness timeouts, and one controller
  liveness failure followed by restart and recovery.
- Torghut live revision `torghut-00253` and sim revision `torghut-sim-00353` were both available `1/1`.
- Torghut data-plane pods for Postgres, ClickHouse, Keeper, TA, sim TA, options TA, options catalog, options enricher,
  websocket services, Alloy, and guardrail exporters were running.
- Torghut events repeatedly reported ambiguous ClickHouse PodDisruptionBudget matches and a Keeper PDB with no matching
  pods, so disruption policy still needs cleanup before widening data-plane rollout confidence.

### Jangar Route And Database Evidence

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`.
- `/ready` reported execution trust healthy, memory provider healthy, serving runtime kit healthy, collaboration
  runtime kit healthy, and fresh swarm plan/implement/verify admission passports.
- `GET /api/agents/control-plane/status?namespace=agents` returned
  `generated_at=2026-05-07T10:23:05.622Z`.
- Database projection was healthy: configured, connected, `latency_ms=4`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`, and latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was degraded: `window_minutes=15`, `observed_streams=6`, `total_events=1253`,
  `total_errors=0`, and `total_restarts=637`.
- Degraded streams included AgentRuns, Agents, AgentProviders, ImplementationSpecs, ImplementationSources, and
  VersionControlProviders.
- AgentRun ingestion was still projected as `unknown` with message `agents controller not started`, even while the
  controller heartbeat and rollout evidence were healthy.
- Material action receipts allowed `serve_readonly`, `dispatch_repair`, and `torghut_observe`; held
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; and blocked live capital classes.
- Direct CNPG inspection was not available to this runner. `kubectl cnpg psql -n jangar jangar-db -- -c 'select now();'`
  failed because the service account cannot create `pods/exec` in namespace `jangar`.

### Torghut Consumer Evidence

- `GET http://torghut.torghut.svc.cluster.local/trading/health` returned HTTP `503` with `status=degraded`.
- Postgres, ClickHouse, Alpaca, universe, scheduler, readiness cache, empirical jobs, and DSPy informational checks
  were individually OK.
- The live submission gate was closed by `simple_submit_disabled` with `capital_stage=shadow`.
- The proof floor was `repair_only`, `capital_state=zero_notional`, with blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- Quant evidence was informationally degraded: latest metrics were current, but ingestion lag was `59,905` seconds for
  the live account/window.
- Execution TCA was stale from `2026-04-02T20:59:45.136640Z`, with average absolute slippage about `568.61` bps
  against an `8` bps guardrail.
- Direct Torghut database shell inspection was blocked by the same read-only RBAC boundary:
  `pods/exec` is forbidden in namespace `torghut`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the aggregation boundary for database status, controllers,
  runtime adapters, execution trust, watch reliability, negative evidence, empirical services, and material action
  receipts.
- `services/jangar/src/server/control-plane-watch-reliability.ts` records events, errors, restarts, and top streams,
  but it is still a reliability summary rather than a repair-settlement ledger.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` maps watch, Torghut consumer, forecast, and
  workflow evidence to action consequences.
- `services/jangar/src/server/agents-controller/index.ts` tracks controller ingestion and heartbeat authority.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule runners, CronJobs, runner ConfigMaps,
  workspace PVC lifecycle, swarm reconciliation, and requirement dispatch. At `3,298` lines, it is too large for repair
  settlement rules to be embedded directly.
- `services/jangar/src/server/primitives-kube.ts` now includes PVC aliases, which removes the prior workspace storage
  blind spot.
- Focused tests already exist for control-plane status, watch reliability, negative evidence routing, action clocks,
  controller witness, AgentRun ingestion, supporting primitives, and primitive Kubernetes resources. The missing
  fixture is a full repair lease to dividend to action graduation lifecycle.

## Problem

Jangar can now separate serving health from material action health. It still lacks a durable handoff gate that tells
engineer and deployer lanes exactly when repair work has earned more authority.

The current failure modes are:

1. **Rollout health can outrun watch truth.** Deployments can be available while watch streams are restarting hundreds
   of times in the same status window.
2. **Repair dispatch has no balance sheet.** `dispatch_repair` is allowed, but the route does not yet expose the cost,
   target witness, settlement evidence, or graduation target for each repair.
3. **Negative evidence is repeated, not settled.** Watch, AgentRun ingestion, forecast, and Torghut consumer blockers
   continue to appear as route facts rather than repair debts with open/retired state.
4. **Source modules are already too broad.** Adding settlement logic to the largest controllers would make future
   reliability work harder to verify.
5. **Least-privilege evidence is the operating model.** Routine gates cannot depend on privileged `pods/exec`, secret
   reads, or ad hoc database shell access.

## Alternatives Considered

### Option A: Freeze All Material And Repair Dispatch Until Watch Reliability Is Healthy

Pros:

- Strongest safety posture for rollout and capital.
- Simple to explain during an incident.
- Prevents repair work from adding load while watches are unstable.

Cons:

- Blocks the bounded repair actions needed to recover the degraded witness.
- Converts every watch restart burst into a human-only incident.
- Wastes the current healthy serving, database, runtime-kit, and observe surfaces.

Decision: reject.

### Option B: Keep Current Material Action Receipts Without A Dividend Gate

Pros:

- Smallest implementation change.
- Existing receipts already hold risky action classes.
- Engineers can continue using route fields and logs during repair.

Cons:

- Repair success remains ambiguous.
- Deployer lanes must infer graduation from scattered route fields.
- Torghut cannot consume one Jangar receipt when ranking profit repairs and submission gates.

Decision: reject as the complete architecture.

### Option C: Repair Dividend Handoff Gates With Actuation Contracts

Pros:

- Keeps serving and bounded repair available while preserving holds on higher authority.
- Converts negative evidence into explicit leases and dividends.
- Requires source-witness recovery before action graduation.
- Gives engineer, deployer, and Torghut one actuation contract per action class.
- Fits least-privilege validation because it uses route and Kubernetes object evidence.

Cons:

- Adds a reducer and status payload.
- Requires careful expiry and replay behavior.
- May keep normal dispatch held longer when evidence is noisy but improving.

Decision: select Option C.

## Architecture

Jangar emits one handoff gate per namespace and status window.

```text
repair_dividend_handoff_gate
  gate_id
  namespace
  generated_at
  fresh_until
  source_status_ref
  database_projection_ref
  controller_heartbeat_ref
  watch_reliability_ref
  agentrun_ingestion_ref
  torghut_consumer_ref
  open_repair_leases[]
  pending_repair_dividends[]
  accepted_repair_dividends[]
  rejected_repair_dividends[]
  action_actuation_contracts[]
```

A repair lease is the only way to spend repair dispatch while negative evidence is open.

```text
repair_lease
  lease_id
  issued_at
  expires_at
  target_witness
  target_action_class
  negative_evidence_refs[]
  max_dispatches
  max_runtime_seconds
  allowed_commands[]
  settlement_gate
  rollback_target
```

A repair dividend is accepted only when the source witness improves.

```text
repair_dividend
  dividend_id
  lease_id
  observed_at
  source_witness_before
  source_witness_after
  repair_run_refs[]
  accepted
  rejected_reason
  graduated_action_classes[]
```

The actuation contract is the status product that downstream consumers cite.

```text
action_actuation_contract
  action_class
  decision                 # allow, hold, block
  capital_stage
  max_dispatches
  max_runtime_seconds
  max_notional
  positive_authority_refs[]
  negative_authority_refs[]
  required_repair_lease_refs[]
  required_dividend_refs[]
  rollback_target
  expires_at
```

## Implementation Scope

Engineer stage owns:

1. Add a pure reducer for handoff gates, repair leases, repair dividends, and action actuation contracts.
2. Keep the reducer outside `supporting-primitives-controller.ts`; call it from the control-plane status path.
3. Persist or cache only compact route-safe references at first, then add durable storage once the shadow contract is
   stable.
4. Extend control-plane status tests with degraded watch, bounded repair, source witness recovery, rejected repair, and
   action graduation fixtures.
5. Keep existing material action receipts authoritative until shadow parity is proven.

Deployer stage owns:

1. Capture `/ready`, `/api/agents/control-plane/status`, Kubernetes rollout/events, and Torghut `/trading/health`
   before enabling enforcement.
2. Run the reducer in shadow and compare each actuation decision against the existing material action receipt for at
   least two consecutive healthy/degraded windows.
3. Enforce only `dispatch_repair` lease limits first.
4. Enforce `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` graduation after shadow parity and
   accepted dividend evidence.
5. Keep live capital classes blocked until the Torghut companion quorum allows them.

## Validation Gates

Required local checks for the engineer PR:

- `bunx oxfmt --check services/jangar/src/server/control-plane-status.ts services/jangar/src/server/control-plane-negative-evidence-router.ts services/jangar/src/server/__tests__/control-plane-status.test.ts services/jangar/src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bunx oxlint --config ../../.oxlintrc.json services/jangar/src/server/control-plane-status.ts services/jangar/src/server/control-plane-negative-evidence-router.ts`
- Focused Jangar tests for control-plane status, watch reliability, negative evidence, and action clocks.

Required deployer checks:

- `kubectl -n agents get deploy,pods,job,cronjob,lease -o wide`
- `kubectl -n agents get events --sort-by=.lastTimestamp --field-selector type=Warning`
- `curl -sS http://agents.agents.svc.cluster.local/ready`
- `curl -sS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
- `curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://torghut.torghut.svc.cluster.local/trading/health`

## Rollout

1. Ship the reducer behind shadow emission.
2. Expose the handoff gate and actuation contracts in the status route without changing decisions.
3. Verify shadow decisions match existing material action receipts in degraded and healthy windows.
4. Enforce repair lease bounds for `dispatch_repair`.
5. Graduate enforcement for `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` only after accepted
   repair dividends prove source-witness recovery.
6. Leave live capital blocked until Torghut submission quorum is current.

## Rollback

Rollback must:

- disable enforcement and keep shadow emission;
- preserve open negative evidence and rejected dividend records;
- restore the existing material action receipt path as the sole authority;
- keep live capital classes blocked;
- require no Kubernetes resource mutation beyond the normal GitOps rollback.

## Risks

- Watch restart bursts may cause conservative holds even when no user-visible outage exists.
- If repair leases are too broad, they can become another dispatch queue rather than a settlement product.
- If dividends are accepted from repair job logs alone, the design loses its core safety property.
- The first implementation should avoid adding another large branch inside `supporting-primitives-controller.ts`.
- Direct database shell access remains unavailable by design; route-projected migration consistency must stay accurate.

## Handoff

Engineer: implement the reducer and tests as a small, pure module connected to `control-plane-status.ts`. Do not embed
lease/dividend policy in the schedule runner or supporting-primitives controller.

Deployer: validate shadow parity first. Enforce repair bounds before action graduation. Treat degraded watch
reliability or Torghut proof-floor repair-only state as a hard hold for deploy widening, merge-ready, paper, and live
capital.
