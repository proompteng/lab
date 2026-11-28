# Galactic AgentRun fleet health

Run this read-only snapshot before and during a concurrency ramp. It uses Bun and a working
[`galactic-tailscale` kubectl context](../runbooks/galactic-kubernetes-access.md). It does not apply, patch, delete, exec,
or fetch Secrets or logs.

```sh
bun run packages/scripts/src/agents/inspect-agent-fleet-health.ts
bun run packages/scripts/src/agents/inspect-agent-fleet-health.ts --format json --fail-on-critical
```

Live mode does five parallel GETs: cluster-wide AgentRun, Job, Pod, and PodMetrics lists, and the Node list. The Pod
list must include all namespaces because non-AgentRun Pods also use PodCIDR addresses. The report includes only the
identifiers and derived evidence needed for triage; workload env, annotations, free-form status messages, and raw
kubectl stderr are not printed. The lists are separate reads, not an atomic cross-resource snapshot. Confirm a desync
with a second snapshot before acting.

| Exit | Meaning                                                                                          |
| ---: | ------------------------------------------------------------------------------------------------ |
|    0 | Report produced. Without `--fail-on-critical`, inspect the report even if the command succeeded. |
|    1 | Report produced with at least one critical finding and `--fail-on-critical` set.                 |
|    2 | Usage error, invalid fixture/snapshot, or a required API read failed. No health verdict.         |

## Interpret the report

| Finding                               | Severity | What to check                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase_pod_desync`                    | Critical | An unset or Pending run already has a Running or terminal Pod, a Job with ready Pods, or a terminal Job. Check the named workload against `status.runtimeRef` and the controller's reconciliation. `Blocked:RateLimit` is shown only when that condition is still true.                                              |
| `stuck_admission`                     | Critical | An unset or Pending run was created more than 180 seconds ago and has neither a live Pending/Running Pod nor a Job reporting active Pods. Check the run's admission conditions and queue, concurrency, and rate limits. Explicit Temporal/custom runs and runs being deleted are excluded from the admission checks. |
| `workload_identity`, `mcp_projection` | Critical | A fleet Pod does not use `codex-auto-ontology-runner` or its `agent-runner` container lacks the Auto Ontology MCP projection. Compare the rendered Pod to the [provider contract](auto-ontology-mcp.md) and check runtime service account overrides. Inspect metadata, not the mounted token.                        |
| `node_skew`                           | Warning  | A schedulable node runs more than 85% of scheduled active fleet Pods while its schedulable peer has more than 100 estimated free pod IPs. Check scheduling constraints, multi-arch image availability, and real capacity on the peer before changing placement.                                                      |
| `memory_pressure`                     | Warning  | A Running Pod has a container with a [working set](https://kubernetes.io/docs/reference/external-api/metrics.v1beta1/) over 80% of its memory limit. Check the named container's limits, memory trend, and OOM history.                                                                                              |
| `memory_check_incomplete`             | Warning  | Some Running Pods lack a usable metric or memory limit for at least one container. Check `metrics.k8s.io` list access and metric availability, or the Pod's limits. Missing data is not zero usage.                                                                                                                  |

**Scope.** A fleet Pod is identified by the AgentRun label or by its ownership/reference chain (Pod → Job → AgentRun).
Namespace and available UIDs distinguish recreated resources or same-named workloads. Active Pods are non-deleting
Pending or Running Pods. Unassigned active Pods are reported separately; Pods assigned to nodes other than Turin
(`amd64`) and Altra (`arm64`) count in the scheduled denominator. The schedulability check requires Ready, no cordon,
and no hard taint except the fleet's control-plane `NoSchedule` toleration. It does not simulate scheduling.

**Pod IP estimate and terminal bloat.** Free IPv4 addresses are estimated from the node's IPv4 `spec.podCIDR` minus
the network, gateway and broadcast addresses and unique, in-range non-host-network Pod IPs reported on that node.
Terminal Pods still reporting an address are counted conservatively; a stale Pod status can outlive its lease, and
unreported allocations cannot be seen in a snapshot. This is neither a CNI lease count nor kubelet slot capacity.
The terminal table counts Succeeded and Failed fleet Pods by namespace, including Pods whose AgentRun or Job is gone
if the fleet label remains. Check Job TTL and runtime cleanup if these counts grow; this CLI never removes anything.

## Offline replay

Save a **sanitized** JSON object with an RFC 3339 `capturedAt` and these Kubernetes list fields. For example, this
fixture represents an empty fleet with unavailable PodMetrics:

```json
{
  "capturedAt": "2026-11-28T12:00:00Z",
  "agentRuns": { "items": [] },
  "jobs": { "items": [] },
  "pods": { "items": [] },
  "nodes": { "items": [] },
  "podMetrics": null
}
```

Retain names, namespaces and UIDs, AgentRun creation timestamps, workload linkage and phases, Pod container
resource limits and projected-volume metadata, node conditions and CIDRs, and PodMetrics container memory quantities
as needed for the checks. Do not include credentials, environment variables, or token contents. Use `null` (or omit
`podMetrics`) if the endpoint is unavailable; an empty `items` list instead means the read succeeded without samples.

```sh
bun run packages/scripts/src/agents/inspect-agent-fleet-health.ts --fixture fleet-snapshot.json --format markdown
```

Fixture mode does not call kubectl. The capture time, rather than wall-clock time, determines admission age, so the
same snapshot yields the same report.
