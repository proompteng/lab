# Leader Election Design (Agents Controllers)

Status: Current, source-verified 2026-08-30

Docs index: [README](README.md)

This document describes the active Agents leader-election contract. The implementation and chart are authoritative;
this document is an operational design note, not a second configuration source.

## Purpose and scope

Agents uses one Kubernetes Lease to ensure that only one replica runs the leader-gated controller work for a
configured Agents installation. Followers continue serving the process and read-only APIs, but their controller
runtimes are stopped and their mutating APIs reject requests with a retryable response.

The contract covers:

- Lease acquisition, renewal, expiry, release, and identity.
- The controller-runtime callback boundary.
- HTTP/gRPC mutation gates and readiness/status reporting.
- Helm values, environment-variable wiring, RBAC, and validation.

It does not provide sharding, multiple active reconcilers, cross-cluster coordination, or multi-region election.

## Current implementation and topology

The active code paths are:

- `services/agents/src/server/leader-election.ts:11-18,20-48` — configuration, status, callbacks, and service API.
- `services/agents/src/server/leader-election-config.ts:12-68` — environment parsing, defaults, and the
  `required` decision.
- `services/agents/src/server/controller-runtime.ts:82-148` — controller start/stop callbacks and lifecycle.
- `services/agents/src/server/kube-types.ts:301-319,381-410` and
  `services/agents/src/server/kube-gateway.ts:561-568` — Kubernetes client and Lease operations.
- `services/agents/src/server/ready.ts:55-206` and `services/agents/src/app-routes/ready.ts:1-10` — readiness.
- `services/agents/src/server/control-plane-status.ts:174-185,345-410` and
  `services/agents/src/routes/v1/control-plane/status.ts:1-10` — status.
- `charts/agents/values.yaml:38-40,368-382,441-449` and
  `charts/agents/templates/deployment.yaml:271-305,387-408` — control-plane defaults and wiring.
- `charts/agents/templates/deployment-controllers.yaml:271-305,387-408` — controller-workload wiring.
- `charts/agents/templates/rbac.yaml:325-335,357-373` — Lease RBAC and ServiceAccount binding.

There are two supported chart shapes:

1. The chart defaults to `controllers.enabled=false`, `controller.enabled=true`, and one control-plane replica. In
   this shape the control-plane process has controller flags enabled and therefore owns the Lease.
2. The production Argo values enable `controllers.enabled=true` with `controllers.replicaCount: 2` while keeping the
   control-plane at `replicaCount: 1` (`argocd/applications/agents/values.yaml:1-5,201-209`). The chart sets the
   controller flags to `0` in the control-plane and runs the controller loops in `Deployment/agents-controllers`.
   The controller workload then owns the Lease.

Both deployments receive the leader-election environment variables. Only a process whose controller-workload flags
make election `required` should participate. Accidentally enabling controller flags in both workloads makes them
contend for the same Lease and is a configuration error.

## Runtime contract

`startControllerRuntimes()` starts the Agents controller, orchestration controller, primitives reconciler,
supporting controller, and control-plane cache (`services/agents/src/server/controller-runtime.ts:82-88`).
`stopControllerRuntimes()` cancels/stops all five (`:90-100`). When election is required, the runtime passes these
functions as `onLeader` and `onFollower` callbacks to `ensureRuntime` (`:102-124`). When election is not required,
the runtime starts the controllers directly.

An active election process starts in follower state and calls `onFollower` before its first asynchronous Lease
attempt (`services/agents/src/server/leader-election.ts:313-336,343-347,460-462`). A successful acquisition calls
`onLeader`; losing leadership calls `onFollower`. This makes the controller-loop boundary explicit: a follower must
not keep watches or reconciliation work running while it waits for the Lease.

Election is bypassed for test environments (`NODE_ENV=test` or a Vitest environment) and whenever `required` is
false (`services/agents/src/server/leader-election-config.ts:25-26,54-59`;
`services/agents/src/server/leader-election.ts:277-305`). In the bypass path, status reports `isLeader: true` and
the callback starts the configured controller work.

## Lease contract

The resource is a `coordination.k8s.io/v1` `Lease` (`services/agents/src/server/leader-election.ts:147-161`):

- Name: `agents-controller-leader` by default.
- Namespace: `AGENTS_LEADER_ELECTION_LEASE_NAMESPACE` when set; otherwise the pod namespace. The chart resolves an
  empty `controller.leaderElection.leaseNamespace` to the Helm release namespace.
- Holder identity: `<HOSTNAME>_<pod UID>` when the downward-API UID is available. If the UID is unavailable, the
  runtime appends a random UUID; if the hostname is unavailable it uses `unknown_<UUID>`
  (`services/agents/src/server/leader-election.ts:83-90`; chart injection at
  `charts/agents/templates/deployment.yaml:271-278` and `deployment-controllers.yaml:271-278`).
- Spec on creation: `holderIdentity`, `leaseDurationSeconds`, `acquireTime`, `renewTime`, and
  `leaseTransitions: 0`.

The current defaults are `leaseDurationSeconds: 30`, `renewDeadlineSeconds: 20`, and `retryPeriodSeconds: 5`
(`services/agents/src/server/leader-election.ts:52-59`). Configuration is normalized at runtime so that
`retryPeriodSeconds < renewDeadlineSeconds < leaseDurationSeconds`. If the first inequality is invalid, renew and
retry values reset to 20/5; if the second remains invalid, all three reset to 30/20/5
(`services/agents/src/server/leader-election-config.ts:28-50`). The Helm schema enforces positive integers but does
not encode the cross-field ordering (`charts/agents/values.schema.json:1005-1020`), so runtime normalization remains
the final guard.

### Acquire and renew algorithm

The runtime uses the Kubernetes client through `KubeGateway`; it does not shell out to `kubectl`
(`services/agents/src/server/kube-types.ts:301-319,381-410`; `services/agents/src/server/kube-gateway.ts:561-568`).

On each attempt (`services/agents/src/server/leader-election.ts:350-421`):

1. Read the named Lease.
2. If it is absent, create it with this identity. If creation races and returns `AlreadyExists`, read it again.
3. Treat an empty holder, an expired Lease, or this identity as acquirable. Otherwise remain follower.
4. Acquire or renew by preserving the current object and replacing it with its `metadata.resourceVersion`, the
   current holder, duration, `renewTime`, and `acquireTime` when absent. A holder change increments
   `leaseTransitions` (`:163-183`).
5. On a replace conflict, remain follower with no election error so the next retry can observe the winner. Other
   Kubernetes errors transition to follower with the formatted error. A missing Lease after read/create is an error.
6. Schedule the next attempt after `retryPeriodSeconds`.

Expiry is computed from the local process clock and `spec.renewTime`. A missing or invalid renew time is expired; a
valid Lease expires only when elapsed time is greater than `leaseDurationSeconds + 2s`
(`services/agents/src/server/leader-election.ts:128-145`). The two-second safety margin is deliberate; this code does
not claim Kubernetes server-time synchronization.

When a leader has not successfully replaced the Lease within `renewDeadlineSeconds`, it transitions to follower with
`lastError: "renew deadline exceeded (<N>s)"` and invokes `onFollower` (`:389-418,405-408`). The implementation is
best-effort around shutdown: on `SIGTERM` or `SIGINT` it stops the timer, sets follower status with `terminating` or
`interrupt`, invokes `onFollower`, and attempts to clear its holder only if the Lease still names this identity
(`:423-457`). Release failure is ignored; Lease expiry remains the recovery path.

## Traffic gates

`requireLeaderForMutationHttp()` is a no-op when election is disabled, not required, or currently leader. Otherwise
it returns HTTP `503`, JSON `{ok:false,error:"Not leader; retry on the elected controller replica."}`, and
`Retry-After: 5` (`services/agents/src/server/leader-election.ts:253-270`). The control plane wires this gate to the
HTTP mutation dependencies (`services/agents/src/server/control-plane.ts:294-348,379-405`), including Agent/AgentRun,
rerun, memory, orchestration, and implementation-source webhook mutation paths. This is a configured mutation gate,
not a claim that every HTTP route is leader-only.

The gRPC mutating handlers use the same status and return gRPC `UNAVAILABLE` with the same retry message
(`services/agents/src/server/agentctl-grpc.ts:182-187,220-254,922-926`). Read/list/get handlers remain available to
followers. The gRPC path does not add an HTTP `Retry-After` header.

## Readiness and status

### `/ready`

The route is `services/agents/src/app-routes/ready.ts:1-10`; the control plane handles `/ready` before generic route
dispatch (`services/agents/src/server/control-plane.ts:400-405`). The default chart readiness probe is `/ready` on
the HTTP container (`charts/agents/values.yaml:368-382`; deployment probes in
`charts/agents/templates/deployment.yaml:515-557` and `deployment-controllers.yaml:512-541`).

Readiness is not a simple leader boolean:

- An active leader is ready only when controller CRD checks pass and its AgentRun ingestion is not degraded.
- A follower/standby is HTTP-ready after at least one clean election attempt (`lastAttemptAt != null` and
  `lastError == null`), even though its controller loops are stopped. Its AgentRun ingestion entry is `unknown` with
  `AgentRun ingestion is owned by the active controller leader`.
- Before the first attempt, or after a missing Lease/Kubernetes error/termination, readiness is HTTP `503` with
  `leader_election_not_ready` in `reason_codes`.
- The response body has schema `agents.proompteng.ai/ready/v1`, camelCase `leaderElection`, `httpReady`, and
  `agentrun_ingestion` fields (`services/agents/src/server/ready.ts:68-70,110-124,148-196`). The top-level
  `status` can be `degraded` while HTTP remains 200 when only AgentRun ingestion health is degraded.

Do not remove follower pods from Service endpoints solely because they are followers. Safety comes from stopping their
controller loops and gating mutations; the readiness endpoint deliberately keeps a clean standby available.

### `/v1/control-plane/status`

The status route is `services/agents/src/routes/v1/control-plane/status.ts:1-10`. Its `leader_election` object uses
snake_case keys: `enabled`, `required`, `is_leader`, `lease_name`, `lease_namespace`, `identity`,
`last_transition_at`, `last_attempt_at`, `last_success_at`, and `last_error`
(`services/agents/src/server/control-plane-status.ts:174-185,394-410`). `/ready` and this status endpoint therefore
expose the same state with intentionally different field casing; do not document `leaderElection` as the status
endpoint key.

## Configuration and chart wiring

The values live under `controller.leaderElection` (`charts/agents/values.yaml:441-449`):

| Helm value                                       |                            Default | Environment variable                            |
| ------------------------------------------------ | ---------------------------------: | ----------------------------------------------- |
| `controller.leaderElection.enabled`              |                             `true` | `AGENTS_LEADER_ELECTION_ENABLED`                |
| `controller.leaderElection.leaseName`            |         `agents-controller-leader` | `AGENTS_LEADER_ELECTION_LEASE_NAME`             |
| `controller.leaderElection.leaseNamespace`       | empty (release namespace in chart) | `AGENTS_LEADER_ELECTION_LEASE_NAMESPACE`        |
| `controller.leaderElection.leaseDurationSeconds` |                               `30` | `AGENTS_LEADER_ELECTION_LEASE_DURATION_SECONDS` |
| `controller.leaderElection.renewDeadlineSeconds` |                               `20` | `AGENTS_LEADER_ELECTION_RENEW_DEADLINE_SECONDS` |
| `controller.leaderElection.retryPeriodSeconds`   |                                `5` | `AGENTS_LEADER_ELECTION_RETRY_PERIOD_SECONDS`   |

Both deployment templates render this table and inject `AGENTS_POD_NAMESPACE` and `AGENTS_POD_UID`
(`charts/agents/templates/deployment.yaml:271-305`; `deployment-controllers.yaml:271-305`). The resolver computes
`required` as true when any of `AGENTS_CONTROLLER_ENABLED`, `AGENTS_ORCHESTRATION_CONTROLLER_ENABLED`,
`AGENTS_SUPPORTING_CONTROLLER_ENABLED`, or `AGENTS_PRIMITIVES_RECONCILER` is true, except in test environments
(`services/agents/src/server/leader-election-config.ts:52-67`).

`enabled=false` bypasses Lease coordination and reports the process as leader so configured controller loops run. It
is an emergency compatibility switch, not a safe read-only mode. `controllers.replicaCount: 1` does not disable
election: when `required=true`, the single process still performs the normal acquire/renew loop. Production HA is
the `controllers.enabled=true` / `controllers.replicaCount: 2` overlay, not a special single-replica algorithm.

## Observability

On each leader/follower transition the runtime logs the service name, transition, Lease namespace/name, identity, and
optional error (`services/agents/src/server/leader-election.ts:198-221`). It creates the OpenTelemetry counter
`agents_leader_changes_total` with `to=leader|follower` (`:104-114,206-220`). There is no current
`agents_leader_elected` gauge in the Agents source, and no active alert rule for this counter was found in the
repository as of this status date. Any flapping/no-leader alerts are future work and must not be described as
deployed. Alert proposals should use status/readiness and transition data only after the metric export and alert
rule are verified in the target environment.

## RBAC

The chart grants the workload ServiceAccount `get`, `list`, `watch`, `create`, `update`, and `patch` on
`leases` in API group `coordination.k8s.io` (`charts/agents/templates/rbac.yaml:325-335`). It intentionally does not
grant `delete`; shutdown clears `holderIdentity` through an update. With `rbac.clusterScoped=false`, the chart emits a
Role/RoleBinding in the release namespace. With `rbac.clusterScoped=true`, it emits a ClusterRole/ClusterRoleBinding,
while the subject remains the chart-selected ServiceAccount in the release namespace
(`charts/agents/templates/rbac.yaml:1-14,357-373`).

## Rollout and recovery expectations

- Keep the Lease name stable across rollouts and unique to the Agents installation/namespace. Changing it creates a
  new election domain and must be an intentional migration.
- Keep `retryPeriodSeconds < renewDeadlineSeconds < leaseDurationSeconds`; rely on the runtime normalization and
  validate the effective values in rendered manifests.
- During a leader crash or partition, the standby can acquire after the old Lease expires. The exact delay is bounded
  by the configured duration plus retry scheduling and Kubernetes API availability; do not promise a fixed one-second
  failover.
- On a normal leadership loss, the old leader stops controller work and remains an HTTP-ready standby only after a
  clean election attempt. On termination it becomes not-ready because `lastError` is set.
- Restore normal election and verify the current holder, controller health, readiness, and mutation behavior before
  calling recovery complete.

## Validation

### Local source and chart checks

Run from the repository root:

```bash
bun run --cwd services/agents test -- src/server/leader-election.test.ts src/server/ready.test.ts src/server/control-plane-status.test.ts
bun run --cwd services/agents tsc
helm lint charts/agents
scripts/agents/validate-agents.sh
```

The chart validation must inspect both the control-plane and controller deployment renders and confirm the six
`AGENTS_LEADER_ELECTION_*` variables, `AGENTS_POD_NAMESPACE`, `AGENTS_POD_UID`, controller flags, readiness path, and
Lease RBAC. The source tests cover Lease/config helpers, readiness states, and snake_case status mapping. If the local
Helm binary is not the supported version, use the repository's pinned Helm 3 toolchain (`mise exec helm@3 -- ...`).

### In-cluster checks

Assuming the production namespace is `agents` and the controller workload is enabled:

```bash
kubectl -n agents get lease agents-controller-leader -o yaml
kubectl -n agents get deploy/agents-controllers -o jsonpath='{.spec.replicas}{"\n"}'
kubectl -n agents get pods -l app.kubernetes.io/name=agents-controllers -o wide
kubectl -n agents logs deployment/agents-controllers --tail=200 | rg -n 'leader election|lease'
```

For endpoint checks, port-forward the chart Service (`service.port` defaults to 80 and targets HTTP 8080):

```bash
kubectl -n agents port-forward service/agents 8080:80
curl -fsS 'http://127.0.0.1:8080/ready' | jq '{status,httpReady,reason_codes,leaderElection,agentrun_ingestion}'
curl -fsS 'http://127.0.0.1:8080/v1/control-plane/status?namespace=agents' | jq '.leader_election'
```

When testing a follower, identify the current holder from the Lease and send a representative mutating request to
the other pod. Expect HTTP 503 plus `Retry-After: 5`, or gRPC `UNAVAILABLE`; verify read/list/get requests still work.
Do not treat a green `/ready` response alone as proof that a controller is the active reconciler: correlate it with
`leaderElection.isLeader`/`leader_election.is_leader`, Lease holder identity, controller logs, and controller health.

## Related docs

- `docs/agents/README.md`
- `docs/agents/agents-helm-chart-implementation.md`
- `docs/agents/jangar-controller-design.md` (historical naming context; active code paths above are authoritative)
- `docs/agents/production-readiness-design.md`
- `docs/agents/runbooks.md`

## Diagram

```mermaid
sequenceDiagram
  autonumber
  participant P1 as Controller pod A
  participant P2 as Controller pod B
  participant L as Lease agents-controller-leader

  P1->>L: read/create/replace via Kubernetes client
  P2-->>L: observe holder and remain follower
  Note over P2: clean standby stays HTTP-ready; controller loops are stopped
  P1-->>L: renew every retryPeriodSeconds
  P1-xL: crash, partition, or renew deadline exceeded
  P2->>L: acquire after lease expiry
  P2-->>P2: start controller runtimes and accept mutations
```
