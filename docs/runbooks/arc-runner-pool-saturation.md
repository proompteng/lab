# ARC runner pool saturation

Use this read-only audit before a large AgentRun or CI burst, or when image publication waits for an ARC worker.
It compares the runner set cap, registered runner state, scheduler requests, and estimated Flannel address headroom.
It does not resize anything, trigger jobs, or use a GitHub token.

## Run

Confirm the intended Galactic context and follow the [Kubernetes access runbook](galactic-kubernetes-access.md).
The default namespace is `arc`. Live mode needs permission to list `autoscalingrunnersets.actions.github.com` and
`ephemeralrunners.actions.github.com` there, and to list Pods across **all** namespaces and Nodes cluster-wide.
Unrelated workloads consume the same node capacity; limiting the Pod list to `arc` would overstate headroom.

```sh
context=$(kubectl config current-context)
kubectl --context "$context" -n arc auth whoami
bun run packages/scripts/src/galactic/audit-arc-runner-pools.ts --context "$context" --format markdown
```

Use `--namespace` for a different runner namespace, or `--format json` for automation. Markdown is the default.
Exit `0` means a report was produced; `1` means an input or collection error. With `--fail-on-saturated`, exit `2`
means at least one pool has zero modeled scale-out slots, a runner blocked in scheduling, or an `Outdated` scale set.
The report is still written on exit `2`. An unknown estimate is not proof of either free capacity or saturation.

## Interpret the result

- **Cap and runner pressure.** `active` counts nonterminal, nondeleting EphemeralRunners; utilization divides that
  by `maxRunners`. `capSlots` subtracts active, failed, and terminating children because ARC also counts the last
  two when deciding whether it can create replacements. An omitted maximum is uncapped; zero disallows new runners.
  `assigned` means ARC recorded an assignment, not that a job is executing. Ready idle runners can accept work even
  at the scale-out cap. Neither an assignment nor a busy pool measures the number of jobs waiting in GitHub.
- **Pending and stuck.** An EphemeralRunner in ARC phase `Pending` can already be ready and waiting for a job. The
  report instead checks runner readiness and the latest nonterminal, nondeleting Pod owned by that runner. A wait
  of at least 300 seconds is marked stuck, using the applicable Pod condition transition, then Pod creation, then
  runner creation. An absent timestamp gives unknown age. `no-pod`, `unscheduled`, and `starting` distinguish
  creation, placement, and startup. Stuck startup alone does not prove scale-out saturation. Unmatched active
  runners cannot be attributed to a set; investigate ARC labels and recollect before treating the report as complete.
- **CPU, RAM, and pods.** Headroom is Node allocatable minus requests for nonterminal bound Pods in all namespaces,
  including terminating Pods until they become terminal. The report uses declared scheduling requests, including init
  peaks, native sidecars, pod-level requests, and overhead. Tmpfs is the count and sum of bounded memory-backed
  `emptyDir` volumes on audited runner Pods; uncapped volumes are counted separately. This is not tmpfs usage or
  additional scheduler-reserved RAM. Node fits use the runner template, node selector, explicit node name, Ready
  and cordon state, and hard taints/tolerations. They are independent per pool; don't add them across pools that share
  a node. This is not a scheduler simulation: it does not model affinity, topology spread, PVC binding, runtime or
  namespace admission defaults absent from the template, in-place resize state, disk throughput, or concurrent demand.
- **PodCIDR.** For Galactic's single IPv4 range, Flannel's default host-local pool excludes the network, bridge
  gateway, and broadcast addresses (253 usable in a `/24`, 509 in a `/23`). The estimate subtracts distinct
  allocatable-range IPs on nonterminal, non-host-network Pods. Bound Pods without an allocatable address are counted
  separately; they may claim more addresses. Missing, invalid, or non-single-IPv4 ranges show unknown. The API does
  not report the host-local lease ledger; stale leases or pending allocations can leave fewer free addresses than
  shown. Confirm CNI allocation failures with the
  [host-local IPAM evidence procedure](galactic-storage-and-workload-recovery.md#phase-5-recover-host-local-ipam-exhaustion)
  before proposing a network change.

### Follow the binding limit

Each node's fit is the minimum number of additional runner Pods allowed by its CPU, RAM, pod count, and address
headroom. The per-set estimate sums those minima (unused resources on different nodes cannot be combined) and
caps the result at `capSlots`. When node resources bind, the report names the one constraint whose removal would
increase that modeled fit the most; ties prefer CPU, RAM, pod slots, then PodCIDR. A tied limit can require changing
more than one constraint to open a slot. A configured cap wins ties with node fit.

An explicit zero cap stops new runners. Otherwise `Outdated` or a scheduling block (an explicit rejection/gate
or an unbound Pod at the stuck threshold) takes priority over theoretical headroom. A scheduler-reported CPU, RAM,
or pod-count shortage is named when it corroborates the zero-fit estimate; otherwise the report names pending
scheduling without guessing a cause. With no eligible nodes,
check placement before adding resources. The top pool is selected by saturation, number of scheduler-blocked runners,
fewest estimated slots (unknown sorts last), most stuck runners, then pool name.

For a cap, first confirm demand and whether ready-idle runners are actually being used. For CPU, RAM or pod count,
compare the node and per-pool tables to see which workloads reserve capacity. For pending scheduling, check the
affected Pod's scheduler events and ARC listener state through existing operator procedures. Treat any proposed
change as separate reviewed work; use the [ARC capacity guidance](../../argocd/applications/arc/README.md#runner-capacity-and-delivery).

## Replay a snapshot offline

Fixtures are JSON objects with an RFC3339 `observedAt` and four full `kubectl get -o json` list objects: `runnerSets`,
`ephemeralRunners`, `pods`, and `nodes`. The four reads are not atomic; recollect if rollout or churn makes the result
inconsistent. Replaying the same data and time gives identical output. Raw Pod JSON can include inline credentials;
keep snapshots private, remove them after use, and never attach them to a PR or an incident ticket. The audit emits
only resource names, fixed classifications, and calculated fields; it does not echo raw objects or error streams.

```sh
(
  set -eu
  umask 077
  context=$(kubectl config current-context)
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  kubectl --context "$context" -n arc get autoscalingrunnersets.actions.github.com -o json > "$tmp/sets"
  kubectl --context "$context" -n arc get ephemeralrunners.actions.github.com -o json > "$tmp/runners"
  kubectl --context "$context" get pods --all-namespaces -o json > "$tmp/pods"
  kubectl --context "$context" get nodes -o json > "$tmp/nodes"
  jq -n --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --slurpfile sets "$tmp/sets" --slurpfile runners "$tmp/runners" \
    --slurpfile pods "$tmp/pods" --slurpfile nodes "$tmp/nodes" \
    '{observedAt: $observedAt, runnerSets: $sets[0], ephemeralRunners: $runners[0], pods: $pods[0], nodes: $nodes[0]}' \
    > "$tmp/snapshot.json"
  bun run packages/scripts/src/galactic/audit-arc-runner-pools.ts --fixture "$tmp/snapshot.json" --format json
)
```
