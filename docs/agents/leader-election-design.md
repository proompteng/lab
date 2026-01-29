# Leader Election Design (Jangar Controllers)

Status: Current (2026-01-29)

## Purpose
Define how Jangar controllers use Kubernetes leader election to support safe horizontal scaling, prevent double
reconciliation, and provide predictable failover behavior.

## Goals
- Ensure exactly one active reconciler per controller group at any time.
- Provide fast, deterministic failover on leader loss.
- Keep webhook and gRPC mutation paths leader-gated to avoid duplicate writes.
- Surface clear status and metrics around leadership changes.

## Non-Goals
- Sharding reconciliation across multiple active leaders.
- Cross-cluster coordination or multi-region leader election.
- Replacing Kubernetes coordination primitives.

## Design Overview
Jangar runs with multiple replicas but only one replica actively reconciles resources. Leader election uses the
Kubernetes Lease API (`coordination.k8s.io/v1`) with a single shared lock per controller group.

### Lease Details
- **Resource**: `Lease` in the controller namespace.
- **Default lease name**: `jangar-controller-leader`.
- **Namespace**: release namespace (same as the deployment), configurable.
- **Owner identity**: `<pod-name>_<uid>`.

### Controller Grouping
- **Default**: one lease for the whole Jangar controller process (agents, supporting, orchestration).
- **Future**: allow split leases per controller group if we separate processes.

### Timing Defaults
- `leaseDurationSeconds`: 30
- `renewDeadlineSeconds`: 20
- `retryPeriodSeconds`: 5

These values are conservative and align with Kubernetes controller-runtime defaults. They may be tuned for
higher-latency clusters but must keep `retryPeriod < renewDeadline < leaseDuration`.

## Traffic & Readiness
- **Readiness**: only the leader reports ready. Non-leaders stay alive but not ready to receive traffic.
- **Webhook ingestion**: leader-only. Non-leaders return `503` with a `Retry-After` header.
- **gRPC** (optional): leader-only. This ensures `agentctl` and automation always hit the active reconciler.

## Failure Modes & Recovery
- **Leader crash**: a standby replica acquires the lease within ~1 lease duration.
- **Network partition**: if the leader cannot renew before `renewDeadline`, it stops reconciling and reports
  not-ready; a new leader takes over.
- **Split brain prevention**: Lease API guarantees single-holder semantics; controllers must halt reconcile
  loops when leadership is lost.

## Observability
- Events: log leadership acquisition and loss with lease name and namespace.
- Metrics:
  - `jangar_leader_elected` (gauge, 1 for leader, 0 for follower)
  - `jangar_leader_changes_total` (counter)
- Status endpoint: expose `leader: true|false`, `lease_name`, and `lease_namespace`.

## RBAC Requirements
Jangar service account must be able to manage Leases in its namespace:
- `get`, `list`, `watch`, `create`, `update`, `patch` on `leases.coordination.k8s.io`.

## Configuration (Helm Values)
Expose the following values under `controller.leaderElection`:
- `enabled` (default `true`)
- `leaseName` (default `jangar-controller-leader`)
- `leaseNamespace` (default release namespace)
- `leaseDurationSeconds` (default `30`)
- `renewDeadlineSeconds` (default `20`)
- `retryPeriodSeconds` (default `5`)

## Validation
- Deploy with `replicaCount=2` and confirm only one pod is ready.
- Kill the leader pod and verify another pod becomes leader within 30s.
- Confirm webhooks and gRPC calls are rejected by non-leaders.

## Related Docs
- `docs/agents/agents-helm-chart-implementation.md`
- `docs/agents/jangar-controller-design.md`
- `docs/agents/production-readiness-design.md`
