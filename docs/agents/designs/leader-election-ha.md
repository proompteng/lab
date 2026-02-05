# Leader Election for HA (Jangar Controllers)

Status: Draft (2026-02-05)

## Purpose
Define how Jangar controllers use Kubernetes leader election to support safe horizontal scaling, prevent double
reconciliation, and provide predictable failover behavior.

## Current State
- Code: No leader election is implemented. Controllers start unconditionally via `ensureAgentCommsRuntime` in
  `services/jangar/src/server/agent-comms-runtime.ts`, and readiness is not gated on leadership.
- Chart: There is no `controller.leaderElection` configuration in `charts/agents/values.yaml` or the deployment
  template.
- Cluster: The `agents` deployment runs `replicaCount: 1` from `argocd/applications/agents/values.yaml`, so HA is
  not active. The namespace includes a PDB named `agents` with `minAvailable: 1`, and gRPC is enabled on port 50051.

## Design Summary
- Use a single Kubernetes Lease to elect one leader across all controller loops running in the Jangar process.
- Only the leader runs reconciliation loops and accepts mutating requests (webhooks, gRPC mutation endpoints).
- Non-leaders stay alive and serve read-only endpoints but report not-ready to avoid traffic.

## Lease Details
- Resource: `coordination.k8s.io/v1` Lease in the controller namespace.
- Default lease name: `jangar-controller-leader`.
- Owner identity: `<pod-name>_<uid>`.
- Timing defaults: `leaseDurationSeconds=30`, `renewDeadlineSeconds=20`, `retryPeriodSeconds=5`.

## Controller Gating
- Gate `startAgentsController`, `startOrchestrationController`, `startSupportingPrimitivesController`, and
  `startPrimitivesReconciler` behind the leader election guard.
- On leadership loss, stop watches and reconcile loops cleanly before returning not-ready.

## Traffic and Readiness
- Readiness probe should report ready only on the leader.
- Non-leader behavior:
  - HTTP mutation endpoints return `503` with `Retry-After`.
  - gRPC mutation methods return `Unavailable` with a retry hint.
  - Read-only status endpoints remain available.

## Configuration
Add a new `controller.leaderElection` section to `charts/agents/values.yaml`:
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

## Failure Modes and Recovery
- Leader crash: a standby replica should acquire the lease within one lease duration.
- Network partition: if the leader cannot renew before `renewDeadlineSeconds`, it must stop reconciling and become
  not-ready so a new leader can take over.
- Split brain: rely on Lease semantics; controllers must stop all reconcile loops on leadership loss.

## Observability
- Log leadership acquisition/loss with lease name and namespace.
- Add metrics:
  - `jangar_leader_elected` (gauge, 1 for leader, 0 for follower)
  - `jangar_leader_changes_total` (counter)
- Extend `services/jangar/src/server/control-plane-status.ts` to report leader status.

## Rollout Plan
1. Add leader election implementation and env wiring behind a feature flag.
2. Deploy with `replicaCount=2` in a non-prod namespace and confirm only one pod is ready.
3. Enable the feature flag in production and increase replicas.

## Validation
- Kill the leader pod and verify another pod becomes leader within 30 seconds.
- Confirm webhooks and gRPC mutation calls are rejected by non-leaders.
- Confirm read-only endpoints remain available during leadership transitions.
