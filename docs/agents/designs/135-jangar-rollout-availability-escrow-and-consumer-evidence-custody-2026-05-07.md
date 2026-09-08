# 135. Jangar Rollout Availability Escrow And Consumer Evidence Custody (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane rollout safety, service availability, controller watch reliability, consumer evidence
custody, Torghut capital handoff, validation, rollout, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/139-torghut-profit-evidence-custody-and-capital-reentry-auction-2026-05-07.md`

Extends:

- `134-jangar-evidence-census-and-projection-settlement-exchange-2026-05-07.md`
- `132-jangar-stage-freshness-escrow-and-capital-authority-reclocking-2026-05-07.md`
- `129-jangar-consumer-evidence-return-ledger-and-rollout-settlement-2026-05-06.md`
- `76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`

## Decision

I am selecting **rollout availability escrow with consumer evidence custody** as the next Jangar control-plane
architecture step.

The cluster is not in a total outage. The read-only pass at `2026-05-07T07:12Z` showed Argo CD reporting `jangar`,
`agents`, `torghut`, `torghut-options`, and `nats` as Synced and Healthy at revision
`840b22ce2fac7cd6aa2fc50c198ed3ecf8821ae3`. Jangar reported healthy execution trust, healthy database connectivity,
all registered Kysely migrations applied through `20260505_torghut_quant_pipeline_health_window_index`, runtime kits
with `bun`, `codex-nats-publish`, `codex-nats-soak`, `nats`, workspace, and `NATS_URL` present, and empirical jobs
fresh. NATS itself had a three-pod quorum with every pod `2/2` Running.

The current failure mode is sharper than that. Jangar's own control-plane status still reported watch reliability as
`degraded`: `2701` AgentRun events in a 15 minute window, `4` total watch restarts, and restarts on `AgentRun`,
`ApprovalPolicy`, and `job` watches. Material action receipts allowed read-only serving and one repair dispatch, but
held normal dispatch, deploy widening, merge-ready, paper canary, and all live capital classes on watch reliability,
Torghut consumer evidence, forecast service, and paper settlement. During the same evidence pass, the live Jangar
rollout made the service unreachable while the replacement pod was `Init:0/1`. The manifest explains why: the Jangar
Deployment is `replicas: 1` with `strategy.type: Recreate`, and the readiness probe only gates the new pod after the
old endpoint is already gone.

I am not choosing another status-field patch. Jangar already knows a lot of truth; it needs to put availability and
consumer evidence into custody before it lets downstream consumers treat that truth as actionable. The chosen design
adds a rollout availability escrow receipt that must be current before deploy widening or merge-ready claims, and a
consumer evidence custody receipt that tells Torghut whether Jangar's current evidence is safe for observe, paper, or
live capital. The tradeoff is that we will hold more actions during Jangar churn. I accept that because the observed
failure was exactly a green-looking control plane losing service during rollout while trading consumers still needed a
defensible answer.

## Runtime Objective And Success Metrics

This contract increases resilience by separating "Jangar has useful evidence" from "Jangar is currently safe to widen
or to authorize a trading consumer".

Success means:

- Jangar serving rollout is not settled while the service has zero ready endpoints, even if Argo CD later reports
  Healthy.
- Recreate-style single-replica rollouts are classified as `availability_gap` for material action and Torghut capital
  consumers until the manifest is changed or the gap is explicitly waived.
- Watch restart debt is budgeted by resource class and action class instead of flattened into one degraded bit.
- Torghut receives a custody receipt that says which evidence is allowed for observe, repair, paper canary, or live
  capital.
- Read-only Jangar operations can continue through degraded watches; deploy widening, merge-ready, paper, and live
  actions wait for current availability and custody receipts.
- Deployer can roll back by holding the escrow receipts in `serve_readonly`/`repair_only` without mutating cluster
  resources by hand.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps resources, or AgentRun records.

### Cluster And Rollout Evidence

- Jangar namespace initially had `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI, Symphony, and
  `symphony-jangar` Running.
- `deployment/jangar` initially reported `1/1` available, but the manifest is `replicas: 1` and
  `strategy.type: Recreate`.
- During the evidence pass, the old Jangar pod terminated, the replacement `jangar-59f474c888-9zj6j` was `0/2`
  `Init:0/1`, and `curl http://jangar.jangar.svc.cluster.local/health` failed with connection refused.
- Recent Jangar events included readiness probe failures against `/health` on the previous pod.
- Agents controllers were `2/2` available, but recent events showed readiness probe timeouts, EOFs, one liveness
  failure, and a controller restart inside the observation window.
- Recent Agents events also showed scheduling pressure for verification pods:
  `0/2 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 1 node(s) had untolerated taint(s)`.
- Jangar, Agents, Torghut, Torghut options, and NATS Argo CD Applications were Synced and Healthy at the same Git
  revision, which means GitOps health alone did not expose the service availability gap.

### Route And Runtime Evidence

- `GET /health` returned `status=ok` before the rollout gap and showed the in-process agents controller disabled while
  the external Agents controller was the active authority.
- `GET /api/agents/control-plane/status` reported:
  - `execution_trust.status=healthy`;
  - `database.status=healthy`;
  - `migration_consistency.status=healthy`;
  - `latest_applied=20260505_torghut_quant_pipeline_health_window_index`;
  - `watch_reliability.status=degraded`;
  - `total_restarts=4` in a 15 minute window.
- Runtime kits were healthy for both serving and collaboration. The collaboration kit included
  `/usr/local/bin/codex-nats-publish`, `/usr/local/bin/codex-nats-soak`, `nats`, `/app/services/jangar`, and
  `NATS_URL`.
- Material action receipts were correctly conservative: `serve_readonly` and `torghut_observe` were allowed, while
  `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` were held or
  blocked.
- Empirical jobs were fresh, but the forecast empirical service was degraded with `registry_empty`.

### Source Evidence

- `argocd/applications/jangar/deployment.yaml` defines the serving Deployment as `replicas: 1` and `strategy.type:
Recreate`.
- The same manifest runs a workspace bootstrap init container before the app and docker containers can become ready,
  which makes single-replica replacement a hard availability risk.
- The app readiness probe checks `/health` with `timeoutSeconds: 5` and `failureThreshold: 6`; that helps prevent a
  bad pod from becoming ready, but it does not keep an old endpoint serving during init.
- `services/jangar/src/server/control-plane-status.ts` already composes execution trust, controller witness,
  dependency quorum, runtime admission, material action verdicts, and Torghut empirical services. The new escrow should
  feed this reducer rather than adding independent policy in the route layer.
- `services/jangar/src/server/control-plane-cache-store.ts` and heartbeat storage already carry the projection and
  heartbeat substrate needed for custody receipts.
- The missing source layer is the availability and custody reducer that binds service endpoints, rollout strategy,
  watch restarts, runtime kits, and consumer evidence into one material-action receipt set.

## Problem

Jangar can report a sophisticated control-plane status while its serving endpoint is temporarily absent.

That creates four material risks:

1. **Rollout health and service availability are not the same proof.** A GitOps Application can be Synced and Healthy
   while a Recreate rollout has zero ready endpoints.
2. **Watch reliability is degraded but not action-scoped enough.** Four restarts are tolerable for observe and repair;
   they are not tolerable for deploy widening, merge-ready claims, or trading capital.
3. **Consumer evidence is mixed with platform evidence.** Torghut needs to know whether forecast, quant ingestion, TCA,
   and paper settlement are custody-grade for capital, not just whether Jangar is generally alive.
4. **Runtime kits can be green while availability is red.** The runtime kit correctly proved the helper binaries and
   NATS path, but it did not assert that Jangar still had a serving endpoint.

The right control-plane product is not another large status payload. It is a small set of receipts that say which
actions are allowed under the current evidence custody state.

## Alternatives Considered

### Option A: Patch Jangar To Two Replicas And RollingUpdate Immediately

Pros:

- Directly addresses the observed endpoint gap.
- Simple Kubernetes remediation.
- Likely reduces user-visible outages during normal image promotions.

Cons:

- It does not classify existing watch restart debt.
- It does not tell Torghut which evidence is custody-grade for capital.
- It can hide control-plane disagreement if the new replica topology is the only change.
- It belongs in the engineer/deployer stage after this architecture contract defines the acceptance gates.

Decision: reject as the architecture-only answer. Keep it as the first engineer implementation item.

### Option B: Freeze All Jangar Material Actions During Any Rollout

Pros:

- Safe and easy to reason about.
- Prevents merge-ready and deploy widening while the platform is changing.
- Requires little new data modeling.

Cons:

- It blocks useful read-only serving and repair dispatch.
- It does not distinguish a harmless rolling restart from zero-endpoint availability loss.
- It gives Torghut no graded observe, repair, paper, and live contract.

Decision: reject.

### Option C: Rollout Availability Escrow With Consumer Evidence Custody

Pros:

- Explicitly detects zero ready endpoints, Recreate single-replica rollouts, watch restarts, and consumer evidence
  gaps.
- Preserves read-only and repair throughput while holding risky actions.
- Gives Torghut a stable custody receipt instead of asking it to interpret several Jangar internals.
- Produces concrete engineer and deployer gates.

Cons:

- Adds one reducer and one receipt family.
- Requires calibration so watch restart budgets do not over-hold routine work.
- May block merge-ready and paper longer than the current material-action reducer.

Decision: select Option C.

## Architecture

Jangar emits one rollout availability escrow receipt per serving workload and one consumer evidence custody receipt per
material consumer.

```text
rollout_availability_escrow_receipt
  receipt_id
  generated_at
  namespace
  workload_ref
  jangar_revision
  desired_replicas
  ready_replicas
  ready_endpoint_count
  rollout_strategy
  init_phase
  watch_reliability_ref
  state                 # current, degraded, availability_gap, rollout_pending, blocked
  allowed_effects       # serve_readonly, dispatch_repair, torghut_observe
  blocked_effects       # dispatch_normal, deploy_widen, merge_ready, paper_canary, live_micro, live_scale
  reason_codes
  fresh_until
  rollback_target
```

```text
consumer_evidence_custody_receipt
  receipt_id
  generated_at
  consumer               # torghut_quant, jangar_deployer, github_merge, schedule_runner
  action_class
  rollout_escrow_ref
  runtime_kit_refs
  watch_reliability_ref
  forecast_ref
  quant_evidence_ref
  tca_ref
  paper_settlement_ref
  custody_state          # observe_only, repair_only, paper_hold, live_block, current
  max_dispatches
  max_notional
  required_repairs
  evidence_refs
  contradiction_refs
  fresh_until
```

### Action Semantics

- `serve_readonly` is allowed when the old or new serving route responds and database/runtime kit receipts are current.
- `dispatch_repair` is allowed when Jangar has current runtime kits and at least one controller authority path, even if
  watches are degraded.
- `dispatch_normal` requires current watch reliability and no zero-endpoint rollout gap.
- `deploy_widen` requires RollingUpdate availability semantics or a current waiver with explicit rollback.
- `merge_ready` requires current rollout availability escrow and current CI/check evidence.
- `torghut_observe` may continue under `repair_only` custody with `max_notional=0`.
- `paper_canary` requires current rollout escrow, current watch reliability, current consumer evidence, and no forecast
  or quant/TCA holds.
- `live_micro` and `live_scale` require paper settlement plus the paper-canary conditions.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a Jangar reducer that reads Deployment strategy, desired replicas, available replicas, ready endpoints, pod init
  state, and recent watch reliability.
- Add `rollout_availability_escrow` and `consumer_evidence_custody` blocks to the control-plane status response.
- Attach receipt ids and reason codes to existing material action receipts.
- Add tests for these cases:
  - single-replica Recreate rollout with zero endpoints blocks deploy widening and merge-ready;
  - RollingUpdate with at least one ready endpoint allows serving and can allow deploy widening when watches are
    current;
  - degraded watch reliability allows observe/repair and holds normal dispatch;
  - Torghut forecast `registry_empty` plus quant or TCA degradation holds paper/live but allows observe.
- Prepare the follow-up GitOps PR to move Jangar serving to `replicas: 2` and RollingUpdate
  `maxUnavailable: 0`, `maxSurge: 1`, with resource and PVC checks before rollout.

## Validation Gates

Engineer validation:

- `bun run --filter @proompteng/jangar test -- control-plane-status`
- `bun run --filter @proompteng/jangar test -- rollout`
- `bunx oxfmt --check services/jangar/src`

Read-only deployer validation:

- `kubectl get deploy -n jangar jangar -o jsonpath='{.spec.strategy.type} {.spec.replicas} {.status.readyReplicas}'`
- `kubectl get endpoints -n jangar jangar -o json`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.watch_reliability,.material_action_activation_receipts'`
- `curl -fsS http://jangar.jangar.svc.cluster.local/health`

Acceptance gates:

- No deploy widening while `ready_endpoint_count=0`.
- No merge-ready claim while rollout escrow is `availability_gap` or `rollout_pending`.
- Torghut paper canary remains held while forecast is `registry_empty`, quant ingestion is degraded, or TCA is stale.
- Observe and one bounded repair dispatch remain allowed when runtime kits and database are current.

## Rollout And Rollback

Rollout is two-phased:

1. Ship the receipt reducer in shadow mode and compare its decisions against existing material action receipts for at
   least one Jangar rollout and one Torghut quant cycle.
2. Make deploy widening, merge-ready, and Torghut paper gates consume the custody receipts after shadow parity is
   clean.

Rollback is explicit:

- If receipts over-hold read-only service, disable enforcement and keep receipt emission in shadow mode.
- If endpoint detection is noisy, keep current material action logic and repair the endpoint reader before re-enabling.
- If Torghut receives contradictory custody receipts, hold paper/live, allow observe only, and publish the
  contradiction refs in NATS and the PR/handoff artifact.

## Risks And Tradeoffs

- The reducer must not become another expensive Kubernetes poller. Use cached watch data where possible and bounded
  direct reads only for deployer validation.
- Two-replica Jangar rollout will require resource review because the current app container requests `2` CPU and `6Gi`
  memory and the docker sidecar requests additional capacity.
- Watch restart budgets need calibration. A strict budget can hold too much work; a loose budget recreates the current
  ambiguity.
- Consumer evidence custody must remain additive and explainable. Torghut should never infer capital permission from a
  missing receipt.

## Handoff

Engineer owns the reducer, route payload, and tests. The first implementation should prove receipt emission and action
classification before changing GitOps rollout strategy.

Deployer owns the follow-up availability change and must not widen Jangar while escrow reports `availability_gap`.
The deployer gate is current only when Jangar has at least one ready endpoint throughout rollout, watch reliability is
current, and material action receipts allow `deploy_widen`.

Torghut consumes the custody receipt as a hard paper/live gate and a soft observe/repair gate. If custody is missing or
stale, Torghut stays in `zero_notional` or `shadow` and reports the missing receipt as a capital blocker.
