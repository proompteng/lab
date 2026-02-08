# Leader Election Design (Jangar Controllers)

Status: Implemented (2026-02-08)

Docs index: [README](README.md)

## Purpose
Define how Jangar controllers use Kubernetes leader election to support safe horizontal scaling, prevent double
reconciliation, and provide predictable failover behavior.

## Implementation (As Of 2026-02-08)
- Code: Leader election runtime lives in `services/jangar/src/server/leader-election.ts`.
- Code: Controllers are started/stopped based on leadership via `ensureAgentCommsRuntime` in
  `services/jangar/src/server/agent-comms-runtime.ts`.
- Code: Lease CRUD is implemented via `kubectl get/create/replace lease` to remain Bun-compatible (avoids TLS issues
  with the Kubernetes client in some environments).
- HTTP readiness: `/ready` exists and reports controller health, not leadership. See `services/jangar/src/routes/ready.tsx`.
- HTTP readiness: `/ready` includes `leaderElection` status in the response body for debuggability.
- Mutation gating: HTTP mutation routes can use `requireLeaderForMutationHttp()` from `services/jangar/src/server/leader-election.ts`.
- Mutation gating: gRPC mutation methods are gated in `services/jangar/src/server/agentctl-grpc.ts`.
- Chart: Values are `controller.leaderElection.*` in `charts/agents/values.yaml` with schema in `charts/agents/values.schema.json`.
- Chart: Env wiring is in `charts/agents/templates/deployment.yaml` and `charts/agents/templates/deployment-controllers.yaml`.
- Chart: RBAC is in `charts/agents/templates/rbac.yaml` (Lease permissions in the namespace).
- Cluster (GitOps desired state): `argocd/applications/agents/values.yaml` runs control plane with `replicaCount: 1`.
- Cluster (GitOps desired state): `argocd/applications/agents/values.yaml` runs controllers HA with `controllers.replicaCount: 2`.

## Goals
- Ensure exactly one active reconciler across the controller loops in a given Jangar release at any time.
- Provide fast, deterministic failover on leader loss.
- Keep webhook and gRPC mutation paths leader-gated to avoid duplicate writes.
- Surface clear status and metrics around leadership changes.

## Non-Goals
- Sharding reconciliation across multiple active leaders.
- Cross-cluster coordination or multi-region leader election.
- Replacing Kubernetes coordination primitives.

## Design Summary
- Use a single Kubernetes Lease to elect one leader across all controller loops running in the Jangar controllers
  process (the `Deployment/agents-controllers` workload).
- Only the leader runs reconciliation loops and accepts mutating requests (webhooks, gRPC mutation endpoints).
- Non-leaders stay alive, remain ready, and serve read-only endpoints. Mutation endpoints are rejected with retry
  semantics, and controller loops are stopped on leadership loss.

Note: This design is intentionally "one leader per release per namespace". If we later add sharding, this document
becomes the baseline and a sharding design should explicitly replace the "single Lease" contract.

## Lease Details
- Resource: `coordination.k8s.io/v1` Lease in the controller namespace.
- Default lease name: `jangar-controller-leader`.
- Namespace: release namespace (same as the deployment), configurable.
- Owner identity: `<pod-name>_<uid>`.
- Timing defaults:
  - `leaseDurationSeconds=30`
  - `renewDeadlineSeconds=20`
  - `retryPeriodSeconds=5`

Timing must satisfy `retryPeriod < renewDeadline < leaseDuration`.

### Naming And Collision Avoidance
The lease name must be stable across rollouts (to prevent a "double leader" during an upgrade) and unique within the
namespace (to prevent unrelated installs fighting over leadership). Recommended options:
- Default: a fixed name like `jangar-controller-leader` when there is one `agents-controllers` deployment per namespace.
- Alternative: include the Helm release name if multiple releases may share a namespace.

## Controller Gating
Gate all controller loops behind the leader election guard. At minimum:
- `startAgentsController`
- `startOrchestrationController`
- `startSupportingPrimitivesController`
- `startPrimitivesReconciler`

On leadership loss, stop watches and reconcile loops cleanly before returning not-ready.

### Implementation Sketch (Lease Acquire/Renew)
Jangar controllers are implemented in TypeScript, so this is not using `controller-runtime`'s built-in leader election.
The intended behavior is still the Kubernetes standard:
1. Try to read the Lease.
2. If missing, create it with `spec.holderIdentity=<identity>` and `spec.renewTime=now`.
3. If present:
   - If `holderIdentity` is unset or the `renewTime` is older than `leaseDurationSeconds`, try to acquire.
   - If `holderIdentity` matches our identity, renew.
   - Otherwise, remain follower.
4. Write updates using optimistic concurrency (`metadata.resourceVersion`) to avoid clobbering other contenders.
5. Run renew attempts every `retryPeriodSeconds`. If we fail to renew for longer than `renewDeadlineSeconds`, we must
   stop all leader-gated work and transition to follower immediately.

Important: Use server time semantics (`renewTime` set to "now" from this pod) but be robust to modest clock skew by
comparing times with a safety margin (for example, treat a lease as expired only after `leaseDurationSeconds + 2s`).

## Traffic And Readiness
- Readiness probe reports process/controller health, not leadership. This prevents readiness flapping when leadership
  changes and avoids removing non-leader pods from Service endpoints.
- Non-leader behavior:
  - HTTP mutation endpoints return `503` with `Retry-After` via `requireLeaderForMutationHttp()`.
  - gRPC mutation methods return `Unavailable` via `requireLeaderForMutation()` in `agentctl-grpc.ts`.
  - Read-only status endpoints remain available.

### Readiness Implications
Because followers remain ready, Services may still route traffic to non-leaders. This is safe because mutation paths
are explicitly leader-gated and return retryable errors on followers.

## Configuration
Add a `controller.leaderElection` section to `charts/agents/values.yaml`:
- `enabled` (default `true`)
- `leaseName` (default `jangar-controller-leader`)
- `leaseNamespace` (default release namespace)
- `leaseDurationSeconds` (default `30`)
- `renewDeadlineSeconds` (default `20`)
- `retryPeriodSeconds` (default `5`)

Map values into env vars consumed by the controller runtime, for example:
- `JANGAR_LEADER_ELECTION_ENABLED`
- `JANGAR_LEADER_ELECTION_LEASE_NAME`
- `JANGAR_LEADER_ELECTION_LEASE_NAMESPACE`
- `JANGAR_LEADER_ELECTION_LEASE_DURATION_SECONDS`
- `JANGAR_LEADER_ELECTION_RENEW_DEADLINE_SECONDS`
- `JANGAR_LEADER_ELECTION_RETRY_PERIOD_SECONDS`

### Defaults And Backwards Compatibility
- When `enabled=false`, controllers behave as they do today (no gating, always ready). This is for emergencies only.
- When `replicaCount=1`, leader election still runs but should be effectively no-op: the single pod should always
  acquire leadership and stay ready. This avoids a "different behavior in prod vs dev".

## Failure Modes And Recovery
- Leader crash: a standby replica should acquire the lease within one lease duration.
- Network partition: if the leader cannot renew before `renewDeadlineSeconds`, it must stop reconciling and become
  not-ready so a new leader can take over.
- Split brain: rely on Lease semantics; controllers must stop all reconcile loops on leadership loss.

### Termination/Drain Behavior
To reduce "gap time" during rolling updates:
- On `SIGTERM`, the leader should stop renewing immediately and fail readiness quickly (for example, within 1-2
  seconds), so another replica can acquire leadership before the terminating pod exits.
- Ensure termination grace is long enough for controllers to stop watches and in-flight work cleanly.

## Observability
- Log leadership acquisition/loss with lease name and namespace.
- Metrics:
  - `jangar_leader_changes_total` (counter) is emitted on leader<->follower transitions.
- Status:
  - `services/jangar/src/server/control-plane-status.ts` reports leader status.
  - `/ready` includes leader status in the response body (for quick in-cluster inspection).

### Alerts (Future)
Once metrics exist, add alerting for:
- Leadership flapping (`jangar_leader_changes_total` increasing rapidly).
- No leader present (all replicas `jangar_leader_elected=0` for > 1 minute).

## RBAC Requirements
Jangar service account must be able to manage Leases in its namespace:
- `get`, `list`, `watch`, `create`, `update`, `patch` on `leases.coordination.k8s.io`.

## Rollout Plan
- Default is enabled. To disable in an emergency, set `controller.leaderElection.enabled=false` in values.
- HA is enabled by scaling the controllers deployment, for example `controllers.replicaCount: 2`.

## Validation
- Kill the leader pod and verify another pod becomes leader within 30 seconds (validated in the `agents` namespace on
  2026-02-08).
- Confirm webhooks and gRPC mutation calls are rejected by non-leaders.
- Confirm read-only endpoints remain available during leadership transitions.

### Validation Commands (In Cluster)
Assuming namespace `agents` and release `agents`:

```bash
kubectl -n agents get lease jangar-controller-leader -o yaml
kubectl -n agents get pods -l app.kubernetes.io/name=agents-controllers -o wide

# Observe leadership transitions
kubectl -n agents logs deploy/agents-controllers --tail=200 | rg -n \"leader|lease\" -S
```

## Operational Considerations
- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Risks And Mitigations
- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput; mitigate with caps and monitoring.

## Related Docs
- `docs/agents/agents-helm-chart-implementation.md`
- `docs/agents/jangar-controller-design.md`
- `docs/agents/production-readiness-design.md`
- `docs/agents/designs/leader-election-ha.md` (includes repo/chart/cluster handoff appendix)

## Diagram

```mermaid
sequenceDiagram
  autonumber
  participant P1 as Pod A
  participant P2 as Pod B
  participant L as Lease (coordination.k8s.io)

  P1->>L: acquire/renew lease
  P2-->>L: observe lease held
  Note over P2: follower stays ready; controller loops are stopped
  P1-->>L: renew until crash/partition
  P1-xL: stop renewing
  P2->>L: acquire lease after timeout
```
