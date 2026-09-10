# 160. Jangar Split-Authority Repair Escrow And Dispatch Reentry Packets (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, split-controller authority, bounded repair dispatch, source rollout truth,
schedule-runner safety, validation, rollout, rollback, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/164-torghut-zero-notional-route-repair-packets-and-paper-rehearsal-2026-05-07.md`

Extends:

- `159-jangar-closed-loop-repair-outcome-ledger-and-material-action-reentry-2026-05-07.md`
- `158-jangar-controller-ingestion-epochs-and-profit-evidence-refill-gates-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md`

## Decision

I am selecting split-authority repair escrow with dispatch reentry packets as the next Jangar control-plane
architecture step.

The current system is not down. Jangar serving is healthy, Agents deployments are available, database consistency is
healthy through the control-plane status route, and watch reliability is healthy. The remaining failure mode is more
specific: Jangar has enough live evidence to observe bounded repairs, but the source rollout truth exchange still holds
`dispatch_repair` because split-controller authority is treated as not fresh enough for any dispatch class.

That is the wrong conservative shape. Normal dispatch, deploy widening, merge readiness, paper, and live capital should
remain held while source/GitOps revision and image identity are missing. Bounded repair should not be held by the same
rule when the controller-process heartbeat, rollout, route, database, and watch epoch are current. Jangar needs a
short-lived repair packet that permits exactly the repair work needed to retire the split, not a broad allow.

The tradeoff is that we add another admission object. I accept that because the object reduces a live deadlock: the
platform can currently explain the split but cannot safely let the repair lane act on it. The packet gives engineers and
deployers one place to prove that a repair was bounded, observed by the controller process, and closed by the repair
outcome ledger before any stronger action class reenters.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `split_authority_repair_escrow`.
- `dispatch_repair` can be `allow` or `repair_only` under split authority only when the packet is current.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  or blocked while source/GitOps revision, desired/live image identity, or proof-floor closure is missing.
- Each packet cites controller-process heartbeat, Agents rollout, watch epoch, route stability, database projection,
  source rollout truth receipt, repair outcome ledger ref, and rollback target.
- Packets have explicit caps: max dispatches, max runtime, max concurrent repairs, max notional zero, and expiry.
- Schedule-runner admission must reject a packet if the supporting ConfigMaps, system prompt, or inputs are missing at
  launch time.
- A packet cannot renew itself. Renewal requires a fresh status snapshot and a previous outcome of `effective` or
  `not_applicable`.
- Deployer checks can answer whether the system is repair-open, normal-closed, or capital-closed without parsing raw
  pod phases.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 from 18:18Z to 18:28Z. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRun objects, broker state, or Torghut capital flags.

### Cluster And Rollout Evidence

- The local kubeconfig current context was unset, but the in-cluster service account could read Kubernetes objects.
- Jangar namespace was available: `jangar-594b6746fd-5lhwp` had both containers ready, `jangar` deployment was `1/1`,
  `bumba` was `1/1`, and Jangar events only showed stale `elasticsearch-master-pdb` `NoPods` noise.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents pods counted `7 Running`, `163 Succeeded`, and `38 Failed`. The failed pods were retained audit debt, mostly
  older schedule-runner cron waves from the 03:50Z to 04:35Z window.
- Current schedule cron waves completed: discover `29636285`, implement `29636255`, verify `29636270`, and plan
  `29636300` all had succeeded jobs.
- Two current Jangar plan/discover step jobs were active, and one Torghut quant verify step was active.
- Recent Agents events still showed transient controller readiness probe timeouts and `FailedMount` warnings for
  retained completed pods whose input/spec ConfigMaps had already been cleaned up.
- Torghut live and simulation Knative revisions were running at `torghut-00276=1/1` and `torghut-sim-00376=1/1`.
- Torghut Flink TA and TA simulation had recently restarted and reached `RUNNING`; startup probe refusals were rollout
  noise, not current availability failure.

### Jangar Status And Database Evidence

- Jangar status generated at 2026-05-07T18:25Z reported leader election healthy.
- Database status was healthy through the Jangar route: configured, connected, latency 12 ms,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG inspection was blocked by RBAC. Listing CNPG clusters in `jangar` and `torghut` was forbidden, and
  `kubectl cnpg psql` failed because the `agents-sa` service account cannot create `pods/exec`.
- Watch reliability was healthy with one observed stream in the current compact payload, more than 4000 AgentRun
  events, zero errors, and zero or one restart depending on the sample.
- `agentrun_ingestion.status` was `unknown` with message `agents controller not started`, while controller witness
  decision was `allow_with_split` and reason `controller_process_heartbeat_authoritative`.
- `source_rollout_truth_exchange.deployer_summary.settlement_state` was `heartbeat_projection_split`.
- Source rollout truth held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`,
  `live_micro_canary`, and `live_scale`.
- The freshest source rollout blocker was `source_rollout_truth_missing:source_or_gitops_revision`.
- Route stability was stable enough for `serve_readonly` and `torghut_observe`, but dispatch and capital classes stayed
  held or blocked.

### Source Evidence

- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` builds controller heartbeat evidence.
  `allow_with_split` becomes heartbeat status `split`, and `isControllerFresh` only treats `fresh` as usable.
- The same reducer then holds `dispatch_repair` when split authority exists, even when controller-process heartbeat,
  database, route, watch, and rollout evidence are otherwise healthy.
- `services/jangar/src/server/control-plane-status.ts` assembles source rollout truth before route stability and
  material action receipts. It only adds `agentrun_ingestion` to namespace degradation when status is `degraded`, not
  when status is `unknown`.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule-runner CronJob creation, admission
  status URL wiring, runner image selection, service account choice, and fire-time launch shape. It is the right
  consumer for repair packets and launch-time ConfigMap checks.
- Existing tests cover controller witness, source rollout truth, material action verdicts, route stability, runtime
  proof surfaces, and status assembly. The missing regression surface is split authority where `dispatch_repair` is
  open with strict caps while all stronger classes remain closed.

### Database And Data Quality Evidence

- Jangar's Kysely migration registry includes the component-heartbeat schema and Torghut control-plane cache schemas.
- `agents_control_plane.component_heartbeats` has a freshness index on `(cluster, namespace, component, expires_at)`
  and can carry the controller-process heartbeat needed for packet admission.
- `torghut_control_plane.quant_metrics_latest`, `quant_metrics_series`, `quant_alerts`, and
  `quant_pipeline_health` are indexed for account/window/stage freshness.
- Live Torghut quant evidence for `PA3SX7FYNUTF/15m` had 144 latest metrics updated around 18:25Z, but zero pipeline
  stages and a missing update alarm.
- Simulation quant evidence for `TORGHUT_SIM/15m` had zero latest metrics, no stages, and an empty latest store alarm.
- Live Torghut proof floor stayed `repair_only`, `zero_notional`, with stale market context, stale empirical jobs, and
  zero routeable symbols.

## Problem

Jangar has built enough conservative gates that it now risks a new failure mode: a repair deadlock. The status route
says the controller-process heartbeat is authoritative under split topology, but the source rollout truth exchange
still classifies the split as not current and holds the only class that can repair it.

That creates four concrete risks:

1. Operators can see the exact blocker but cannot admit bounded repair work without bypassing the material-action
   contract.
2. Retained failed pods and missing ConfigMap warnings keep adding audit noise even after current cron waves succeed.
3. Torghut evidence repair remains zero-notional, which is correct, but it lacks a Jangar packet that proves the repair
   was authorized under the current split.
4. Deployer checks have to reason from raw receipts instead of a single repair-open/normal-closed state.

## Alternatives Considered

### Option A: Keep All Dispatch Held Until Full Source Truth Converges

Pros:

- Simplest and safest enforcement posture.
- Avoids widening any action while source and GitOps revision are absent.
- Matches the current implementation.

Cons:

- Blocks the bounded repair lane needed to create the missing evidence.
- Forces humans to bypass the contract or wait for unrelated rollout metadata.
- Treats an authoritative controller-process heartbeat as unusable.

Decision: reject. Full freeze is safe but creates repair deadlock.

### Option B: Treat Split Authority As Fresh For Every Action Class

Pros:

- Easy code change in source rollout truth.
- Normal dispatch can recover quickly once controller heartbeat is current.
- Fewer held classes in the status payload.

Cons:

- Source/GitOps revision and desired/live image mismatch remain unresolved.
- Normal dispatch and deploy widening would move without source identity.
- Torghut paper/live could inherit too much confidence from controller heartbeat alone.

Decision: reject. Split authority is enough for repair observation, not enough for normal action.

### Option C: Add Split-Authority Repair Escrow And Dispatch Reentry Packets

Pros:

- Opens only bounded repair under current split evidence.
- Keeps stronger action classes closed until source identity, image identity, and proof floor converge.
- Gives schedule-runner admission a concrete packet to check at fire time.
- Gives Torghut a zero-notional repair authority without capital leakage.

Cons:

- Adds a reducer and launch-time checks.
- Requires packet renewal and outcome attribution discipline.
- Some repairs will expire before completion and need a new snapshot.

Decision: select Option C.

## Architecture

Add a pure reducer named `control-plane-split-authority-repair-escrow` under `services/jangar/src/server/`.

Inputs:

- Controller witness quorum.
- Source rollout truth exchange.
- Route stability escrow.
- Material action verdict epoch.
- Database status and migration consistency.
- Watch reliability.
- Rollout health for `agents` and `agents-controllers`.
- Workflow reliability and recent schedule failure summary.
- Repair outcome ledger, when available.
- Runtime proof surface and admission passports.

Output shape:

```text
split_authority_repair_escrow
  escrow_id
  mode                    # shadow, warn, enforce
  generated_at
  fresh_until
  namespace
  topology_state          # converged, split_repair_open, split_repair_closed, unknown
  packet_decision         # allow, hold, block
  packet_reason_codes[]
  packet_ref
  required_witness_refs[]
  blocked_action_classes[]
  repair_action_classes[] # dispatch_repair only in this stage
  max_dispatches
  max_concurrent_repairs
  max_runtime_seconds
  max_notional
  required_launch_artifacts[]
  required_after_evidence[]
  rollback_target
```

`split_repair_open` requires:

- controller witness decision `allow_with_split`;
- controller-process heartbeat unexpired;
- `agents-controllers` deployment available;
- watch epoch current and error-free inside the configured window;
- database connected with no unapplied or unexpected migrations;
- route stability allows `serve_readonly`;
- source rollout truth does not report route, database, or watch unknown;
- no active deploy widening or live capital packet;
- repair outcome ledger has no unresolved regression for the same packet class.

`dispatch_repair` receives a reentry packet only under `split_repair_open`. The packet never upgrades
`dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, or `live_scale`.

Schedule-runner admission must check the packet at fire time. It should reject when:

- the packet is expired;
- required input/spec/system-prompt ConfigMaps are missing;
- the runner image digest no longer matches the packet;
- the controller-process heartbeat witness changed without a newer packet;
- the repair class is not named in the packet;
- the requested run has nonzero notional or live submission intent.

## Engineer Implementation Scope

1. Add the pure reducer and unit tests for converged, split-repair-open, split-repair-closed, expired, and regressed
   packet states.
2. Add `split_authority_repair_escrow` to the control-plane status payload in shadow mode.
3. Add launch-time packet checks to supporting-primitives schedule runners without changing CronJob ownership.
4. Keep source rollout truth conservative for normal classes, but consume the packet when deciding bounded repair.
5. Add tests proving `allow_with_split` opens only `dispatch_repair` when packet requirements are met.
6. Add tests proving missing input/spec ConfigMaps reject launch even if the packet is otherwise fresh.

## Validation Gates

- `bun test services/jangar/src/server/__tests__/control-plane-split-authority-repair-escrow.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-status.test.ts -t split_authority_repair_escrow`
- `bun test services/jangar/src/server/__tests__/agents-controller-runtime-resources.test.ts -t repair packet`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.split_authority_repair_escrow'`
- In shadow mode, compare packet decision with source rollout truth for at least three schedule windows.
- No packet may be emitted with `max_notional` above zero in this stage.
- No packet may be emitted if database migration consistency is not healthy.

## Rollout Plan

1. Shadow: publish packets and compare them with current material-action verdicts. No launch behavior changes.
2. Warn: schedule runners log a structured warning when a repair would be rejected by packet rules.
3. Enforce bounded repair: require a packet for `dispatch_repair`; keep normal and capital classes unchanged.
4. Deployer gate: require packet and repair outcome evidence before reporting repair-open.
5. Reentry: let the repair outcome ledger close the packet and remove the split blocker before any stronger action
   class can be reconsidered.

## Rollback Plan

- Disable enforcement with `JANGAR_SPLIT_AUTHORITY_REPAIR_PACKET_ENFORCEMENT=false`.
- Keep the status projection enabled for forensics.
- If packets incorrectly block urgent repair, return to the current source rollout truth behavior and document the
  rejected packet plus status snapshot.
- If packets incorrectly allow repair, set `max_dispatches=0` through configuration and hold `dispatch_repair` until
  the reducer is fixed.
- Never roll back by allowing normal dispatch or Torghut capital while source/GitOps identity is still missing.

## Risks

- Packet drift: a packet can become stale faster than the schedule-runner fire time. The expiry must be short and
  checked at launch.
- False confidence: controller-process heartbeat does not prove source identity. That is why only `dispatch_repair`
  opens.
- Audit noise: retained failed pods can still confuse humans. The packet must cite current workflow reliability and
  not raw retained pod count.
- RBAC blind spot: direct database inspection is blocked for this service account. Status-derived database health is
  acceptable for packet shadowing, but deployer evidence should record the RBAC limitation.

## Handoff Contract

Engineer acceptance:

- Status exposes `split_authority_repair_escrow` with stable packet ids.
- Split authority opens only bounded `dispatch_repair` under tests.
- Launch-time admission rejects expired packets and missing ConfigMaps.
- Existing material-action verdicts remain stricter for normal, deploy, merge, paper, and live classes.

Deployer acceptance:

- Observe three consecutive packet windows where packet state matches controller witness, route, database, and watch
  evidence.
- Confirm `dispatch_repair` packets carry zero notional and bounded runtime.
- Confirm no deploy widening or paper/live action is allowed by packet evidence.
- Roll back enforcement immediately if packet admission blocks all repair while controller-process heartbeat, route,
  database, and watch evidence are healthy.
