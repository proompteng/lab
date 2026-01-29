# Leader Election Design for Jangar Controllers

Status: Current (2026-01-29)

## Context
The Agents Helm chart already supports replica scaling via `replicaCount` and optional HPA settings, but the Jangar
controllers do not implement leader election today. Running more than one replica can cause duplicate reconciles and
multiple AgentRun submissions. This design introduces Kubernetes Lease-based leader election so each controller runs
with a single active leader while allowing safe horizontal scaling for failover and upgrades.

## Goals
- Provide safe horizontal scaling for all Jangar controllers (agents, supporting, orchestration).
- Prevent duplicate reconciles and duplicate AgentRun submissions when multiple replicas are deployed.
- Keep single-replica deployments simple and safe by default.
- Expose a clear configuration surface in the Helm chart and Jangar env vars.
- Add RBAC permissions for `coordination.k8s.io/leases`.
- Define observability signals and failure handling for leadership transitions.

## Non-Goals
- Implementing leader election across multiple Jangar deployments in different namespaces.
- Providing a separate leader election service or external coordination system.
- Changing controller behavior beyond gating reconcile loops on leadership.

## Architecture Overview
### Lease model
- Use Kubernetes Leases (`coordination.k8s.io/v1`) for leader election.
- Create one Lease per controller type in the release namespace.
- Lease names are deterministic: `<release>-<controller>-leader` (example: `agents-jangar-agents-controller-leader`).
- Each Jangar replica competes for each controller Lease; only the leader runs that controller reconcile loop.

### Controller behavior
- Each controller process participates in a leader election loop before starting reconciliation.
- Only the leader executes reconciles and submits AgentRuns.
- Non-leaders remain idle but continue to renew or attempt leadership for their controller.
- Leadership loss triggers a clean stop of the controller loop and emits a log and metric event.

### Lease parameters
Use standard client-go style timings:
- `leaseDurationSeconds`: how long a leader lease is valid (default 15s).
- `renewDeadlineSeconds`: how long a leader tries to renew before stepping down (default 10s).
- `retryPeriodSeconds`: interval between attempts to acquire or renew (default 2s).

## Configuration Surface
### Helm values (proposed)
```yaml
leaderElection:
  enabled: false
  leaseDurationSeconds: 15
  renewDeadlineSeconds: 10
  retryPeriodSeconds: 2
  leaseNamePrefix: ""

controller:
  enabled: true

supportingController:
  enabled: true

orchestrationController:
  enabled: true
```

Notes:
- `leaderElection.leaseNamePrefix` defaults to the Helm release name when empty.
- Each controller derives its Lease name as `<leaseNamePrefix>-<controller>-leader`.
- Leader election applies to all enabled controllers. If a controller is disabled, no Lease is created for it.

### Environment variables (proposed)
- `JANGAR_LEADER_ELECTION_ENABLED` ("true" or "false")
- `JANGAR_LEADER_ELECTION_LEASE_NAME_PREFIX`
- `JANGAR_LEADER_ELECTION_LEASE_DURATION_SECONDS`
- `JANGAR_LEADER_ELECTION_RENEW_DEADLINE_SECONDS`
- `JANGAR_LEADER_ELECTION_RETRY_PERIOD_SECONDS`

### Default behavior and gating rules
- Default is `leaderElection.enabled=false` because single-replica deployments are safe without leader election.
- The chart must enforce that multi-replica deployments enable leader election.
- Values schema gating rules:
  - If `autoscaling.enabled=true`, then `leaderElection.enabled` must be true.
  - If `replicaCount > 1`, then `leaderElection.enabled` must be true.
  - If `leaderElection.enabled=false`, enforce `replicaCount=1` and `autoscaling.enabled=false`.

## RBAC Changes
Jangar needs access to Leases in the release namespace:
- `get`, `list`, `watch`, `create`, `update`, `patch` on `coordination.k8s.io/leases`.
- When `rbac.clusterScoped=true`, include these verbs in ClusterRole. Otherwise include in Role.

## Observability and Metrics
### Metrics (proposed)
- `jangar_leader_election_leader{controller="agents"}`: 1 when leader, 0 otherwise.
- `jangar_leader_election_transitions_total{controller="agents"}`: leadership changes.
- `jangar_leader_election_renew_errors_total{controller="agents"}`: renewal failures.

### Logs and events
- Log when leadership is acquired, renewed, or lost.
- Emit a Kubernetes Event on leadership changes for quick cluster troubleshooting.
- Expose leader election status in `agentctl status` output and control-plane health endpoint.

## Failure Modes and Mitigations
- **Missing RBAC for Leases**: controller never becomes leader; emit error and mark control-plane status degraded.
- **API server unavailable**: leader cannot renew; controller steps down; other replicas attempt takeover.
- **Leader flapping**: increase lease duration or retry period; surface `transitions_total` spikes.
- **Lease name collision**: use release name prefix and controller name to avoid collisions.
- **Clock skew**: rely on Kubernetes API server timestamps for Lease; do not use local wall clock in logic.
- **Leader loss during reconcile**: reconcile is retried by new leader with idempotency protections.

## Rollout Plan
1) Add Lease-based leader election in Jangar controllers with safe start/stop hooks.
2) Add RBAC permissions for `coordination.k8s.io/leases`.
3) Add Helm values and schema gating rules for leader election.
4) Default to single replica (leader election disabled) but document production guidance for multi-replica.
5) Update `agentctl status` and control-plane health to report leader election status.
6) Update runbooks to include Lease checks and leadership troubleshooting steps.

## Acceptance Criteria
- Multi-replica Jangar deployments run with exactly one active leader per controller.
- No duplicate AgentRun submissions during normal operation or failover.
- Leadership transfers within one lease duration after a leader crash or eviction.
- Helm schema prevents `replicaCount > 1` or HPA when leader election is disabled.
- Control-plane status and metrics expose leader election state and errors.
