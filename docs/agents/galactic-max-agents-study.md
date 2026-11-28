# Galactic AgentRun capacity study

**2026-11-28 decision:** for standard `proompteng/lab` Jobs using `agents/codex-agent`, **32 runs is the first binding
ceiling** (`controller.concurrency.perAgent`). With six runs already admitted, that is 26 additional runs. Removing
the admission limits alone would not make 64 safe: the captured background fits **51 total** in the safe
node-placement model (60 without the safety margins). Turin binds on working set; Altra binds on ephemeral-storage
requests. More controller replicas do not increase these caps.

These are snapshot ceilings, not a load-test result, a fleet-wide promise for other providers, or authorization to
change production. No Agents or CNPG values are changed by this study.

## Reproduce or refresh

Run from the repository root:

```sh
script=packages/scripts/src/agents/measure-cluster-agent-capacity.ts
fixture=docs/agents/fixtures/galactic-agent-capacity.json
bun run "$script" --fixture "$fixture" --format json
bun run "$script" --fixture "$fixture" --format markdown --target 96
```

The [checked-in fixture](fixtures/galactic-agent-capacity.json) contains aggregates, not raw Pod specifications.
`--target` selects the displayed sizing recommendation and adds a tier if needed (for example, `--target 224`).
Without it, the CLI selects the first of 64, 96, 128, 160 and 200 above the safe ceiling. A zero exit code means the
measurement succeeded, not that a target fits. For monitoring, compare `safe.total`, `safe.additional`, `safe.bindings`
and each node's headroom using the same workload inputs. `null` in the limits means the constraint is disabled,
not applicable, or not an additional limiting factor.

For a new measurement, confirm the explicit context using the [Galactic access runbook](../runbooks/galactic-kubernetes-access.md).
Extract the `assumptions` object, then replace the dated values with current measurements and the exact profile being
sized. In particular, verify the **effective** deployment environment for concurrency, rates, runner requests and
pool maxima, not just Helm defaults. Do not copy database URLs, credentials, or full deployment environment arrays.

```sh
inputs=$(mktemp)
jq '.assumptions' "$fixture" > "$inputs"
# Refresh the numeric inputs and verify this kubeconfig context before running.
bun run "$script" --context galactic-tailscale --assumptions "$inputs" --format json
rm -f "$inputs"
```

Live mode uses only `kubectl get`. It requires reads of Nodes, all-namespace Pods and AgentRuns, and
`metrics.k8s.io/v1beta1/nodes`. It will not exec into a pod, read Secrets, use a GitHub credential, or apply changes.
To size an already collected `kubectl` snapshot, use `--fixture <path>` (or `--fixture -` for stdin) with a JSON
envelope containing `capturedAt` (UTC), `assumptions` as in the fixture, and `kubernetes` in place of `observations`:

| `kubernetes` key | Complete JSON list                                                    |
| ---------------- | --------------------------------------------------------------------- |
| `nodes`          | `kubectl get nodes -o json`                                           |
| `pods`           | `kubectl get pods --all-namespaces -o json` (including terminal Pods) |
| `nodeMetrics`    | `kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes`                |
| `agentRuns`      | `kubectl get agentruns.agents.proompteng.ai --all-namespaces -o json` |

Use an explicit confirmed context on each read. Do not commit the raw JSON. For a compact offline capture, use the
fixture's `observations` shape: CPU in millicores, memory and ephemeral storage in bytes, with CPU/requests already
summed as effective Pod requests. `observations.running` is grouped by namespace and AgentRef. Only select AgentRefs
that can actually run this profile. An empty `agents` list watches a namespace for existing consumption but does not
schedule the new cohort there.

## What was observed

Read-only Kubernetes and CNPG observations from **2026-11-28 03:47 UTC**. GiB values are rounded in this table; the
fixture preserves the exact values used in the model.

| Node                         | Architecture | Capacity / allocatable CPU | Node / allocatable RAM (GiB) | Node working set (GiB) | Pod CIDR        | Advertised pod cap |
| ---------------------------- | ------------ | -------------------------: | ---------------------------: | ---------------------: | --------------- | -----------------: |
| Turin, `turin`               | amd64        |              384 / 383.950 |            1038.25 / 1037.66 |                 252.97 | `10.244.0.0/23` |                500 |
| Altra, `talos-192-168-1-85`  | arm64        |              128 / 127.950 |              753.69 / 753.09 |                 142.26 | `10.244.4.0/23` |                500 |
| Ryzen, `talos-192-168-1-194` | amd64        |                32 / 31.950 |               ~62.36 / 61.77 |                 ~31.10 | `10.244.3.0/24` |     500 (excluded) |

| Node  | Bound CPU / memory requests | Free CPU | Free memory requests (GiB) | Free ephemeral requests (GiB) | Safe physical RAM free (GiB) | Active Pods (non-host-network) | Succeeded / Failed | Unreused terminal IP claims | Safe additional runs |
| ----- | --------------------------- | -------: | -------------------------: | ----------------------------: | ---------------------------: | -----------------------------: | -----------------: | --------------------------: | -------------------: |
| Turin | 181.918 CPU / 585.68 GiB    |  202.032 |                     451.97 |                       3060.93 |                       629.55 |                      350 (336) |             54 / 2 |                           3 |                   36 |
| Altra | 117.165 CPU / 291.04 GiB    |   10.785 |                     462.05 |                         72.38 |                       498.38 |                      179 (164) |             20 / 2 |                          22 |                    9 |

- **Live vs. desired:** The running Deployments advertised 1 CPU / 4 GiB / 8 GiB ephemeral requests and a 16 GiB memory
  limit; captured Jobs also included 2 CPU / 8 GiB requests. The fixture sizes new Jobs at the live defaults. The
  live Job TTL was one day. The workspace cache DaemonSet and mount were not live.
- **Working-set evidence:** Mimir's `kubelet-cadvisor` stream reported 108 pods with an `agent-runner` container in
  `agents` in the 24 hours ending at capture. For each pod, take its sampled peak, then the nearest-rank 95th
  percentile of those peaks. P95 was **18,690,637,824 bytes (17.41 GiB)**; max was 21.92 GiB. The fixture uses the exact
  P95 and an extra **15%** node RAM reserve. Peaks are sampled, include the prior workload mix, and are not a cap.
- **Start rate evidence:** 36 `codex-agent` runs with successful, complete start/finish timestamps in the same window
  averaged 1754.2 seconds. The fixture rounds down to 1754. There were no matching failed records with both timestamps
  in that sample. Controller limits were 32 per AgentRef, 40 per namespace, 100 cluster-wide and 30/120/600 starts per
  repository/namespace/cluster per 60 seconds. Only `agents/codex-agent` is selected; `synthesis` is watched but not a
  source of interchangeable jobs. With another eligible AgentRef in `agents`, the policy bottleneck would move to
  40 per namespace; making more namespaces eligible would not remove the 51-run safe placement ceiling.
- **CNPG evidence:** `agents-db-next` exposed `max_connections=100`, `reserved_connections=0`, and
  `superuser_reserved_connections=3` in `cnpg_pg_settings_setting`. Two controller replicas at 8 sessions each and
  one control-plane replica at 8 were live, with surge one apiece. The fixture includes **10 other client connections**
  and **10 extra safe reserve** as allowances, and budgets **37 steady / 63 during surge with reserve**. Built-in audit event storage shares the
  [primitives store](../../services/agents/src/server/primitives-store.ts) pool; it does not add a second pool. Size any
  separate audit writer explicitly.
- **External estimates, not observations:** `arc-amd64` advertised `maxRunners=10`. The model assumes two slots for
  other traffic, 75% target utilization, and 120 runner-seconds per completed AgentRun (e.g. one 8-minute job per four
  runs). It assumes one 5,000 REST requests/hour budget, 1,000/hour for other traffic and 80% use of the remainder. Use
  observed costs and the budget for the actual credential/installation, not the credential used to run the CLI.

### Projected on the rebased `main` defaults

The [newer Agents values](../../argocd/applications/agents/values.yaml) (base `aa0a2d91f`, Agents changes in
[#16451](https://github.com/proompteng/lab/pull/16451)) use 500m CPU / 4 GiB / 8 GiB ephemeral requests and a
32 GiB memory limit. They set per-AgentRef / namespace / cluster concurrency to **96 / 112 / 160**, rate to
120 / 240 / 600 per 60 s, Job TTL to 1800 s, and opt in to the node-local cache. The controller/control-plane
pools become 24 / 16 per replica and [CNPG](../../argocd/applications/agents/postgres-cluster.yaml) is set to
250 connections. None of these new values was verified live.

Substituting those inputs, but keeping the observed background, P95 and GitHub costs unchanged, gives
**60 theoretical, 51 safe**, both binding on joint node placement rather than the controller. CNPG budgets
**77 steady / 127 safe peak**. The policy changes and smaller CPU reservations alone do not unlock 64.
Re-measure after any rollout: the cache may change the working set, and ARC changes may shift background load.

To refresh the P95, query this expression at the capture time in Mimir and sort the returned values
(`ceil(0.95 × sample count)`, one-indexed). Inspect the sample size and remeasure if the cohort, architecture,
scrape coverage, or cache state changes.

```promql
max_over_time((
  sum by (pod) (container_memory_working_set_bytes{
    job="kubelet-cadvisor",namespace="agents",container!="",container!="POD"
  })
)[24h:30s])
and on (pod) max by (pod) (
  max_over_time(container_memory_working_set_bytes{
    job="kubelet-cadvisor",namespace="agents",container="agent-runner"
  }[24h])
)
```

## Model and interpretation

This is exact arithmetic for **one homogeneous Job Pod per run**, with active work and background consumption
preserved. `A` is the controller's `Running` count in watched namespaces. Size from settled snapshots: these runs
must already be charged in the pod and working-set observations. Drain or budget outstanding launches before
relying on the result. Queued runs are not running. Listing Pods and sampling metrics are not an atomic operation;
the CLI rejects missing metrics and metrics outside a two-minute capture window for eligible nodes.

1. **CPU requests:** `floor(max(0, allocatable mCPU − bound nonterminal effective mCPU) / runner mCPU)` on each
   eligible node. Only the Ready, uncordoned, tolerating members of the two-node build pool count. The standard
   profile tolerates the control-plane `NoSchedule` taint; Ryzen is always excluded.
2. **Memory requests:** same formula in bytes. Include init-container peaks, native restartable init sidecars,
   pod-level requests and pod overhead. Apply the same check to ephemeral-storage requests when the runner asks
   for storage. Requests are scheduling reservations, not RAM use.
3. **Physical RAM:** `floor(max(0, capacityBytes − nodeWorkingSetBytes − reserveBytes) / p95PodWorkingSetBytes)`.
   The theoretical reserve is zero; the safe reserve is rounded up from the configured percentage of physical
   capacity, **additional** to the already observed node working set. Use a pod working set that includes resident
   tmpfs. Kubernetes charges memory-backed `emptyDir` to the writing container; adding tmpfs size limits on top of a
   cgroup working-set measurement would double count it. The runtime's tmpfs size limits are not usage estimates.
4. **Kubelet and CNI:** subtract active bound Pods from `min(capacity.pods, allocatable.pods)`. A `/23` has 510 IPv4
   host addresses (network/broadcast excluded), or 508 potential leases under the model's two extra Flannel
   reservations. Subtract active non-host-network Pods, including ones still waiting on CNI. The
   [scheduler excludes terminal Pods](https://github.com/kubernetes/kubernetes/blob/master/pkg/scheduler/scheduler.go),
   so `Succeeded` and `Failed` objects do **not** directly consume requests or maxPods slots. They can leave old
   addresses and API objects. When measured, supply leases not represented by active Pods in `cni.extraLeases`,
   including an explicit zero. Otherwise, the theoretical variant assumes no extra leases; safe subtracts unique
   terminal status IPs in that CIDR that aren't reused by an active Pod. This is a conservative claim proxy, not
   a host-local lease count or a bound on unseen orphans. Follow the
   [lease evidence runbook](../runbooks/galactic-storage-and-workload-recovery.md#prove-exact-orphan-candidates)
   if CNI is limiting.
5. **Controller:** compute the remaining per-AgentRef capacity, sum it within each namespace, and take the
   minimum with the namespace's remaining concurrency and rate-derived capacity before summing namespaces. Apply
   the cluster and optional repository caps separately. For one repo and mean run lifetime `L`, a positive
   start budget `r` per window `W` supports `floor(r × L / W)` steady runs, not `r` concurrent runs or an
   instantaneous burst of that size. Existing watched runs count against the budgets in this one-repo model;
   disabled rate buckets do not constrain it. Pace ramp-up according to the actual buckets on both admission and
   reconciliation; retries and background submissions can consume them too.
6. **CNPG:** the user connection budget is `max_connections − reserved slots − other clients`. Sum
   `replicas × poolMax` for controllers, control plane and any separate audit writer. Safe adds surge replicas
   and an explicit connection reserve. Runs use shared pools; they do not get one DB session each. A fixed-pool
   overcommit fails the model (zero); otherwise only add a run-count bound if runs independently open connections
   (`floor(free / connectionsPerRun)`). Connection headroom is not evidence of query throughput.
7. **External:** GitHub capacity for one REST budget is `floor(net hourly budget × L / (3600 × requestsPerRun))`.
   Compute this separately for cold and warm runs; the selected mode is explicit. A local Git mirror saves Git
   objects and can shrink tmpfs use, but Git transport is not REST, and warm clones still contact the origin.
   There is **no assumed REST saving** here (10 calls/run in both scenarios). Measure before lowering that input.
   Budget other REST clients and account separately for [secondary limits and backoff](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
   ARC capacity is `floor((maxRunners − otherRunnerSlots) × utilization × L / runnerSecondsPerRun)` using the
   critical scale set for the workload. The runner-to-agent ratio is `runnerSecondsPerRun / L`. This is a steady CI
   throughput gate; ARC does not launch the AgentRun Job. Check separate runner sets and queue latency if work
   fans out across labels.

Take the **minimum within each node, then sum** the node results and add `A`. Taking a minimum of cluster-wide
CPU and memory sums would allow a Pod to spend CPU on one host and RAM on another. Apply controller, DB and
external caps to that placement result. The safe variant uses reserve-adjusted budgets (including floor of the
usable GitHub requests, and target ARC utilization); all totals are integers. A tie reports all co-binding
limits. Live-snapshot isolated CPU, memory, physical-RAM, pod-count and CNI safe ceilings are **218, 233, 70, 477 and
497** respectively, but their joint ceiling is **51** for this workload and background.

The model does not solve arbitrary pod affinity, resource quotas, GPU/PVC placement, provider availability,
eviction or API-server load. Capture while ARC's expected peak resources are already reserved or deduct them from
the background headroom before a rollout decision. Future ARC pods consume CPU, memory, physical RAM and network
slots too. Verify on both architectures under concurrent cold starts; one node going away invalidates the
two-node ceiling.

## Scaling tiers

For this single AgentRef/namespace, bring `controller.concurrency.perAgent`, `perNamespace` and `cluster` to
at least the target without lowering existing values. The table starts from the live 32 / 40 / 100; if the newer
96 / 112 / 160 settings are in force, keep them for targets they already cover. Do not raise `controller.rate`
solely to reach concurrency: even 224 steady runs here need only eight starts per 60 seconds; the live minimum
bucket is 30. The CLI emits higher values only for a rate knob that actually needs to move.

The table gives **one arithmetic route** with the captured background unchanged: divide the node headroom by the
proposed new placements on that node and keep the lower bound for each resource. RAM/request numbers are integer
bytes, not safe replacement requests measured in a benchmark. Freeing or relocating background load can be
preferable to shrinking requests; remeasure after either change.

| Target | Concurrency (AgentRef / namespace / cluster) | New Turin / Altra | At most mCPU / memory request bytes per new run | At most P95 bytes per new run | ARC `maxRunners` minimum | Max REST calls/run with current safe budget |
| -----: | -------------------------------------------- | ----------------: | ----------------------------------------------- | ----------------------------: | -----------------------: | ------------------------------------------: |
|     64 | 64 / 64 / 100                                |            49 / 9 | 1198 / 9904105269                               |                   13795286241 |           8 (already 10) |                                          24 |
|     96 | 96 / 96 / 100                                |            81 / 9 | 1198 / 5991372323                               |                    8345296615 |                       11 |                                          16 |
|    128 | 128 / 128 / 128                              |           113 / 9 | 1198 / 4294700515                               |                    5982026777 |                       14 |                                          12 |
|    160 | 160 / 160 / 160                              |           145 / 9 | 1198 / 3346904539                               |                    4661855350 |                       17 |                                           9 |
|    200 | 200 / 200 / 200                              |           185 / 9 | 1092 / 2623249503                               |                    3653886626 |                       21 |                                           7 |
|    224 | 224 / 224 / 224                              |           209 / 9 | 966 / 2322015111                                |                    3234301559 |                       23 |                                           6 |

- **64:** after raising policy, physical RAM on Turin and ephemeral requests on Altra bind. With unchanged requests
  the 49/9 split needs P95 no higher than **12.85 GiB**. Alternatively, keep measured P95 and place 36/22; at live
  requests that needs another 11.215 Altra CPU cores and about 104 GiB of Altra ephemeral request headroom. The
  [node-local workspace cache](workspace-cache.md) is a candidate for reducing private Git/Bun tmpfs. Verify the
  DaemonSet on both nodes and the live `controllers.env.vars.AGENTS_AGENT_RUNNER_SHARED_CACHE_HOST_PATH` mount,
  then remeasure cold and warm rather than assuming the RAM target is met.
- **96:** the 81/9 split fits today's requests but needs P95 at most **7.77 GiB** or additional physical headroom.
  The split keeps 8 GiB ephemeral per Job; Altra would have little spare. ARC is below 96 at the modeled mix.
  Increase eligible runner throughput or reduce CI demand; verify
  `maxRunners` for `arc-amd64` in [its Helm values](../../argocd/applications/arc/application.yaml), not Agents values.
- **128 and 160:** today's combined request placement tops out at 127 even with abundant physical RAM; Turin
  has space for only 112 more 4 GiB requests and Altra for nine more 8 GiB ephemeral requests. Right-size
  `controller.defaultWorkload.resources.requests.memory` and the working set for a measured workload class, or
  redistribute background load. The 160 split already
  needs 495 active Turin slots before extra ARC pods, so leave placement slack or move work to Altra. The current
  safe REST scenario is **155** runs, so 160 also needs lower measured REST cost or more spare budget.
- **200+:** in the illustrated Turin-heavy split the 200 tier needs **535** advertised Turin pod slots and **526**
  IPv4 host addresses including today's claims and reservations. A `/23` cannot serve that placement. At 224
  it would need 559 slots and 550 addresses. A `/22` supplies 1022 host addresses (1020 before occupied leases
  with the same reserves), but raising only the CIDR does not raise kubelet's cap. Alternatively, at 200, keep
  Turin at 500 and make room for at least 44 additional Altra pods instead of nine. Do not resize CIDRs for a
  balanced placement that already fits. Expanding Turin's current block in place to `10.244.0.0/22` would
  overlap Ryzen. Follow the [Galactic allocation runbook](../runbooks/galactic-turin-podcidr-23-migration-plan.md)
  for network, routing, and workload gates; a `/22` is a new allocator change, not an Agents Helm knob.
- **Retention and DB gates at every tier:** the CLI proposes `controller.jobTtlSecondsAfterFinished: 600` when
  terminal bloat is present and the observed TTL is longer. Verify log and artifact survival first; the change
  does not reclaim leaked leases or rewrite TTLs for already-finished Jobs. Keep the calculated safe CNPG budget
  below the verified server limit, including other consumers and simultaneous rolling surge. If that stops
  fitting, reduce client pool maxima or evaluate transaction pooling before raising PostgreSQL
  `max_connections`, which has a memory cost. Verify broker/server queues and connection peaks under load.
