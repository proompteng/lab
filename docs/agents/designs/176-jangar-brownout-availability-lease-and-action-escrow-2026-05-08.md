# 176. Jangar Brownout Availability Lease And Action Escrow (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, brownout detection, endpoint lease safety, rollout behavior, action escrow,
Torghut capital dependency gates, validation, rollout, rollback, and acceptance criteria.

Companion Torghut contract:

- `docs/torghut/design-system/v6/180-torghut-dependency-priced-capital-frontier-and-session-reentry-2026-05-08.md`

Extends:

- `175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`
- `174-jangar-observer-rights-and-source-settled-capital-ledger-2026-05-08.md`
- `173-jangar-action-broker-and-proof-carrying-rollout-cells-2026-05-08.md`
- `docs/torghut/design-system/v6/179-torghut-capital-repair-frontier-and-route-yield-clearance-2026-05-08.md`

## Decision

I am selecting a **brownout availability lease with action escrow** for Jangar.

The prior design correctly priced retained failure debt, but the refreshed cluster state exposed a sharper failure
mode: the control-plane application can disappear during a rollout while downstream jobs, stale endpoints, and healthy
adjacent services make the system look partially alive. On 2026-05-08 between 03:10Z and 03:17Z, `argocd` reported
`jangar` as `Synced` and `Progressing`, while `torghut` and `agents` were `Synced` and `Healthy`. The `jangar`
Deployment showed `1 desired | 0 updated | 0 total | 0 available`, `strategy.type=Recreate`, and no app pod in the
namespace. Recent events showed the old `jangar-665d446c8` pod being deleted and the deployment scaled down from 1 to 0. Service calls to `http://jangar.jangar.svc.cluster.local/health` and
`/api/agents/control-plane/status?namespace=agents` returned HTTP `000` with connection refused or timeout. At the
same time, EndpointSlices still advertised the removed pod IP `10.244.5.155` for `jangar`, `jangar-tailscale`, and
`jangar-vscode-tailscale`.

The app recovered later in the same run. A follow-up check at about 03:22Z showed `deployment/jangar` back to `1/1`,
Argo CD `Synced/Healthy`, EndpointSlices moved to `10.244.5.12`, and `/health` returning HTTP 200. That recovery is
good news, but it does not erase the failure mode. It proves the gap is transient rollout brownout with stale endpoint
authority, not a permanent outage.

That is not just an availability incident. It is an authority incident. Jangar is the witness surface for source
settlement, material action, Torghut quant health, market-context health, schedule state, NATS visibility, and PR/CI
progress. When the app is down or its service endpoints point at a non-existent pod, downstream systems must not infer
that the last successful status is still valid. The system needs an availability lease outside the Recreate app path
and an action escrow that holds material actions when the lease is absent, stale, or contradicted by Kubernetes.

The tradeoff is that Jangar will become more conservative during rollouts. Some repair or swarm jobs that would have
run through stale cached state will be delayed or downgraded to retry-only. I accept that. A control plane that can
launch or bless capital decisions while its own service has zero available pods is more dangerous than a conservative
control plane that holds action until the serving witness is fresh.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- The workspace was on `codex/swarm-torghut-quant-discover`, based on `main`, with a clean worktree before this
  document set.
- The in-cluster identity was `system:serviceaccount:agents:agents-sa` after bootstrapping a local `in-cluster`
  kubeconfig from the mounted service-account token.
- `argocd` reported `jangar sync=Synced health=Progressing revision=aad37ea347eb3fe61e639c9f78bb252579afce74`.
  `torghut` and `agents` were both `Synced` and `Healthy` on the same revision.
- `deployment/jangar` reported `1 desired | 0 updated | 0 total | 0 available | 0 unavailable`, with
  `StrategyType: Recreate`.
- Jangar namespace events showed the old app pod deleted, the replica set scaled down, and no replacement pod serving
  by the end of the assessment window.
- EndpointSlices still listed `10.244.5.155` for `jangar`, `jangar-tailscale`, and `jangar-vscode-tailscale` after the
  app pod was gone.
- `curl` to `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` failed three
  times with HTTP `000`, first by timeout and then by connection refused.
- A later follow-up showed recovery: `deployment/jangar` `1/1`, `pod/jangar-59d6bfbb9-bh8k5` `2/2 Running`,
  EndpointSlices at `10.244.5.12`, Argo CD `Synced/Healthy`, and `/health` HTTP 200.
- Agents controllers were available as `2/2`, but both current pods had restarted within the preceding 24 minutes.
  Controller logs still showed `otlp metrics export failed` with connection refused to
  `observability-mimir-nginx.observability.svc.cluster.local`.
- NATS was healthier than the earlier soak: `nats-0`, `nats-1`, and `nats-2` were all `2/2 Running`, and service
  endpoints covered all three broker pods.
- The assessment account could read pods, deployments, events, named Torghut secrets, and logs, but it could not list
  StatefulSets, ReplicaSets, CNPG cluster resources, broad secrets, or create `pods/exec`. The design cannot rely on
  broad observer power to distinguish app brownout from data brownout.

### Source Evidence

- `argocd/applications/jangar/deployment.yaml` declares one `jangar` replica and `strategy.type: Recreate`. The same
  pod owns the application server, Docker sidecar, workspace PVC, terminals, source status, Torghut quant projection,
  and material-action API surface.
- `services/jangar/src/server/control-plane-status.ts` has 793 lines and is already the aggregator for execution trust,
  runtime kits, source rollout truth, admission passports, material action, and downstream Torghut evidence.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` has 632 lines and already models action
  classes such as `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `torghut_observe`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` has 528 lines and converts source truth into
  action decisions, but it currently assumes the Jangar app can serve the status projection.
- `services/jangar/src/server/supporting-primitives-controller.ts` has 3314 lines. The controller path can continue
  scheduling while the Jangar web/status path is unavailable, so schedule success cannot be treated as serving health.
- Jangar has focused tests for control-plane status, material action verdicts, source rollout truth, runtime admission,
  controller witness, watch reliability, Torghut quant runtime, and market context. The next implementation should add
  a small availability-lease reducer with synthetic Kubernetes inputs instead of expanding the main status reducer
  first.

### Database And Data Evidence

- The Jangar database pod was running, but direct CNPG cluster metadata reads were denied to the assessment identity.
- The Jangar application was unavailable during the assessment window, so application-projected database health was not
  authoritative.
- Torghut direct Postgres read-only queries worked through the named app secret, which proves the assessment identity
  can support scoped database evidence without `pods/exec`. Jangar should use the same least-privilege pattern for
  brownout evidence where possible.
- Torghut and ClickHouse remained readable while Jangar was down. That means Jangar brownout must be represented as an
  upstream authority failure, not as a generic cluster outage.

## Problem

Jangar has good status projections when it is serving. It does not yet have an authoritative status for the moment when
Jangar itself is not serving.

The current failure modes are concrete:

1. A single Recreate deployment can have desired replicas while exposing zero total pods.
2. Stale EndpointSlices can advertise a removed pod IP after the app is gone.
3. Argo CD can be `Synced` while health is `Progressing`, which is not enough information for downstream action
   authority.
4. Agents controllers and schedules can continue to run while the Jangar web/status plane is unavailable.
5. Downstream systems can still query Torghut and NATS, so a partial system can look operational while Jangar authority
   is absent.
6. Current status APIs live inside the app that may be down, so they cannot be the only brownout witness.

The control plane needs a small, independent availability lease and an action escrow that makes missing Jangar
authority explicit.

## Alternatives Considered

### Option A: Keep Recreate And Increase Probe Patience

Keep the current single-pod Recreate model, raise readiness failure thresholds, and rely on Argo CD health plus
operator awareness during rollouts.

Advantages:

- Lowest implementation cost.
- Avoids splitting the workspace and Docker sidecar from the app.
- Keeps existing deployment manifests mostly intact.

Disadvantages:

- Does not remove the zero-pod brownout.
- Does not solve stale endpoints.
- Does not provide a status witness when the app is unavailable.
- Leaves Torghut and swarm action gates dependent on human interpretation.

Decision: reject. Probe tuning can reduce noise, but it does not create action-grade authority.

### Option B: Switch The Whole Jangar App To RollingUpdate With More Replicas

Run multiple full Jangar pods, use `RollingUpdate`, and keep one pod available during image changes.

Advantages:

- Directly improves serving availability.
- Uses standard Kubernetes rollout behavior.
- Makes synthetic probes simpler.

Disadvantages:

- The current app pod owns a workspace PVC and Docker sidecar, so multi-replica rollout is not safe without separating
  stateful workbench behavior from stateless status behavior.
- It risks two pods competing for terminal/workspace state.
- It is too broad as the first fix.

Decision: reject as the immediate step. It is a target state after the app is split.

### Option C: Brownout Availability Lease And Action Escrow

Add a small availability witness outside the Recreate app path. The witness compiles Kubernetes deployment state,
EndpointSlice state, Argo CD health, recent synthetic HTTP probes, source revision, controller liveness, and NATS
publishability into a short-lived lease. Jangar and downstream runners consume the lease through an action escrow.

Advantages:

- Detects zero-pod, stale endpoint, and HTTP `000` failures even when the Jangar app cannot answer.
- Allows read-only observation and debt-reducing repair while holding normal dispatch, rollout widening, merge
  readiness, and Torghut capital action.
- Can be shadowed before enforcement.
- Creates a clear migration path to a split stateless `jangar-status` plane and stateful `jangar-workbench` plane.

Disadvantages:

- Adds one more authority payload.
- Requires careful RBAC so the witness can observe enough without broad secret or exec rights.
- During early enforcement, some schedules will be held more often.

Decision: select Option C.

## Architecture

Jangar adds a `control_plane_availability_lease` and an `action_escrow_receipt`.

```text
control_plane_availability_lease
  lease_id
  generated_at
  valid_until
  source_revision
  gitops_revision
  app_deployment_ref
  desired_replicas
  updated_replicas
  available_replicas
  observed_generation
  endpoint_pod_uids
  missing_endpoint_pod_uids
  synthetic_probe
  argocd_health
  controller_witness
  nats_publish_witness
  decision               # serve | brownout | outage | unknown
  reasons
```

The synthetic probe is intentionally small:

- `GET /health`
- `GET /api/agents/control-plane/status?namespace=agents`
- `GET /api/torghut/trading/control-plane/quant/health?account=paper&window=15m`

The witness marks the lease `brownout` or `outage` when any of these conditions hold:

- desired replicas are greater than zero and available replicas are zero for more than one probe interval;
- a Jangar service EndpointSlice points at a pod IP or pod UID that no longer exists;
- synthetic HTTP probes return `000`, time out, or return a stale generated timestamp;
- Argo CD reports `Progressing` for Jangar while the app has zero available pods;
- source or GitOps revision is missing for an action that requires source settlement;
- the lease itself is older than its `valid_until`.

The action escrow consumes that lease and emits one decision per action class:

```text
action_escrow_receipt
  receipt_id
  lease_id
  action_class             # serve_readonly | torghut_observe | dispatch_repair | dispatch_normal | deploy_widen | merge_ready | paper_canary | live_micro | live_scale
  decision                 # allow | allow_repair | hold | block
  brownout_reasons
  required_clearance
  expiry
  rollback_target
```

Default decisions:

- `serve_readonly`: `allow` only when the lease is `serve`; `hold` on brownout; `block` on outage.
- `torghut_observe`: `allow` when Torghut is independently readable and the lease is not expired; `hold` when Jangar
  is outage and cannot publish quant/context authority.
- `dispatch_repair`: `allow_repair` only for jobs that name the brownout debt they reduce.
- `dispatch_normal`: `hold` on brownout and `block` on outage.
- `deploy_widen`: `hold` until a fresh lease shows at least one status-serving endpoint and no stale endpoint debt.
- `merge_ready`: `hold` when the PR changes Jangar availability, Jangar action gates, or Torghut capital policy and
  the lease is not `serve`.
- `paper_canary`, `live_micro`, `live_scale`: `block` unless Jangar lease is `serve` and Torghut capital gates also
  pass.

## Implementation Scope

Engineer scope:

- Add a pure `control-plane-availability-lease` reducer under `services/jangar/src/server/`.
- Add tests for zero-pod desired deployment, stale EndpointSlice, HTTP `000`, Argo `Progressing`, fresh serve, stale
  lease, and missing source revision.
- Add a narrow Kubernetes reader that needs `get/list` on deployments, pods, endpointslices, and Argo CD applications.
  Do not require broad secret listing or `pods/exec`.
- Add an action escrow reducer that consumes the lease and existing material-action/source-truth projections.
- Publish lease and escrow summaries to the existing control-plane status payload once shadowed.
- Add a NATS status event when the lease changes state, capped to one event per state transition.

Deployer scope:

- Keep the current Recreate app unchanged in the first deploy, but enable the lease in shadow mode.
- Add a stateless `jangar-status` Deployment with two replicas once the reducer is stable. It exposes health, the
  availability lease, action escrow, progress comment helpers, and Torghut status projections without mounting the
  workspace PVC or Docker sidecar.
- Move terminal/workspace/Docker behavior to `jangar-workbench`, which may remain Recreate until PVC ownership changes.
- Point `service/jangar` to the stateless status plane first; expose workbench through a separate internal service.

## Validation Gates

The implementation is not complete until all gates pass:

- Unit tests cover every lease decision branch and every action escrow branch.
- A synthetic fixture with `desired=1`, `available=0`, and stale endpoint pod UID produces `decision=outage`.
- A fixture with Argo `Progressing`, one available status pod, and no stale endpoints produces `decision=brownout` for
  rollout-sensitive actions and `allow` for read-only status.
- `bun run --cwd services/jangar test -- control-plane-availability-lease` passes.
- `bun run --cwd services/jangar test -- control-plane-material-action-verdict control-plane-status` passes.
- In shadow deployment, restarting `jangar-workbench` does not make `service/jangar /health` return HTTP `000`.
- During a Jangar app rollout, `action_escrow_receipt.paper_canary`, `live_micro`, and `live_scale` are `block` until
  the lease returns to `serve`.
- NATS emits one human-readable brownout update on state transition and does not spam every probe.

## Rollout Plan

Phase 0 is documentation and handoff. This document is the contract.

Phase 1 adds the reducer and shadow status. No action gates change. The deployer verifies that the shadow lease would
have marked the observed 2026-05-08 zero-pod state as `outage`.

Phase 2 enables action escrow for Jangar-owned dispatch gates. Normal dispatch and deploy widening hold on brownout;
read-only observation and named repair can continue.

Phase 3 splits `jangar-status` from `jangar-workbench`. Status gets rolling, multi-replica deployment behavior.
Workbench keeps the workspace PVC and Docker sidecar.

Phase 4 makes Torghut capital gates consume the availability lease. Paper and live action require a fresh `serve`
lease. Zero-notional repair can run during brownout only when it names the debt it retires.

## Rollback Plan

- Disable enforcement with `JANGAR_AVAILABILITY_LEASE_ENFORCEMENT=false`.
- Keep shadow lease publication on unless it is causing load; shadow evidence is needed to debug the rollback.
- Repoint `service/jangar` to the legacy app if `jangar-status` split fails.
- On rollback, material actions remain held for 30 minutes unless a fresh legacy `/health` and `/api/agents/control-plane/status`
  response prove the app is serving.
- Torghut paper/live capital remains blocked whenever the lease is missing, stale, or unknown.

## Risks

- The availability witness can become another false-positive gate if probe budgets are too strict. The first rollout
  must run in shadow and compare against observed endpoint and Argo behavior.
- RBAC may be too narrow for EndpointSlice-to-pod UID settlement. If so, the smallest unblocker is `get/list` on pods,
  deployments, endpointslices, and Argo CD applications for the witness service account.
- Splitting status from workbench changes operational habits. The status plane must not accidentally acquire workspace
  or Docker responsibilities.
- Existing schedules may assume Jangar app availability for status reads. They need retry-only behavior when escrow is
  `hold` or `block`.

## Handoff Contract

Engineer acceptance:

- Build the lease reducer, action escrow reducer, and tests.
- Prove the 2026-05-08 zero-pod/stale-endpoint case returns `outage`.
- Prove read-only Torghut observation is separate from paper/live capital.
- Keep the payload compact and versioned as `jangar.control-plane-availability-lease.v1`.

Deployer acceptance:

- Shadow the lease before enforcement.
- Do not widen Jangar rollout or enable Torghut capital consumption until `service/jangar` can answer health while the
  workbench pod restarts.
- Treat HTTP `000`, stale endpoint targets, and expired leases as capital-blocking events.
- Publish a NATS handoff whenever lease enforcement changes state.
