# Galactic request headroom reclamation (Wave 19E)

This is a Git-source audit of [the pre-change `main` revision](https://github.com/proompteng/lab/commit/aa0a2d91f1f20dca27e59634655311676f26d102).
The supplied snapshot showed Turin at 182.4 CPU requested versus 19.5 CPU in use, and
`talos-192-168-1-85` (Altra) at 107.8 requested versus 11.2 in use. This explains why idle CPU does not translate
directly into scheduler headroom. The snapshot does not establish any individual container's peak CPU or working
set. No live cluster reads, syncs, or mutations were performed for this PR.

## Requests reclaimed

Both changed workloads have one replica. Values below are for their application containers; the request savings
are also the per-workload and per-namespace deltas. All limits, replica counts, placement rules, quotas, storage
and runtime settings are unchanged.

| Namespace / workload                                                                            | CPU request before → after | Memory request before → after | CPU / memory reclaimed | CPU / memory limits retained |
| ----------------------------------------------------------------------------------------------- | -------------------------: | ----------------------------: | ---------------------: | ---------------------------: |
| `jangar` / [`StatefulSet/open-webui`](../../argocd/applications/jangar/openwebui-values.yaml)   |                      4 → 2 |                     8Gi → 4Gi |                2 / 4Gi |                      4 / 8Gi |
| `codex-devbox` / [`StatefulSet/codex-turin`](../../argocd/applications/devbox/statefulset.yaml) |                      8 → 4 |                   64Gi → 64Gi |                4 / 0Gi |                     8 / 64Gi |
| **Total reclaimed**                                                                             |                            |                               |            **6 / 4Gi** |                              |

- **Open WebUI:** [The original increase](https://github.com/proompteng/lab/pull/1950) raised requests and limits
  together from 2 CPU / 4Gi to 4 CPU / 8Gi to protect streaming. The chart runs the web application and sends model
  traffic to upstream APIs; its bundled Ollama and Pipelines are disabled. Restore the old scheduling floor, not
  the old caps. The current image still needs qualification under representative streams and document workloads;
  the previous resource values are not a current measurement. The chart's terminating `copy-app-data` init
  container and Jangar's LimitRange are unchanged and do not dominate these requests.
- **Devbox:** The `codex-devbox` namespace is owned by the Argo Application `devbox` at
  [`argocd/applications/devbox`](../../argocd/applications/devbox/kustomization.yaml). The single persistent,
  interactive workstation is pinned to `turin`. Reserve half its CPU limit for contention, while keeping the
  [qualified 8-vCPU / 64-GiB guest budget](../../services/devbox/README.md). Kata 4.1.0's
  [sandbox sizing](https://github.com/kata-containers/kata-containers/blob/4.1.0/src/runtime-rs/crates/resource/src/cpu_mem/initial_size.rs)
  uses CPU quota/period and the memory limit, not the CPU request. The workstation's CPU weight is lower under
  contention and its Pod template changes from Guaranteed to Burstable. Do not assume this is performance-neutral
  under a busy build mix. The VM's full memory request and the [`kata-dragonball` overhead](../../argocd/applications/kata/runtime-class.yaml)
  (250m CPU / 130Mi memory) stay reserved; effective workstation CPU request is 8.25 → 4.25 CPU.

### Reviewed and retained

No CPU or memory requests are reclaimed from these workloads:

- **Tengri:** The six-slot pool is the large reservation, not the two controllers at 200m / 192Mi each.
  [`pod.rs`](../../services/tengri/src/pod.rs) generates slot Pods; its Firecracker runner reserves 4 CPU / 12Gi
  plus a separate supervisor. The memory budget covers guest RAM and host overhead. Sleeping guests retain their
  Pod envelope. The quota caps admission, not node capacity. The controllers, worker, and separate `restate`
  reader already have small requests.
- **Torghut:** Keep active Flink, ClickHouse/Keeper, WebSocket, notebooks and Alloy unchanged. The archive's
  eight two-slot TaskManagers request 2 CPU apiece because
  [running readers fell behind when sharing one CPU](https://github.com/proompteng/lab/pull/14316). The live
  TA job also has two slots per TaskManager; changing Flink memory would affect its JVM process budget.
  [Alloy's 256Mi request and 512Mi limit](../../argocd/applications/torghut/README.md) follow a handover OOM.
  Retired Torghut manifests are not counted as capacity.
- **Other Jangar workloads:** Retain the Codex-serving Deployment, CNPG, Redis, Alloy and backup/upgrade Jobs.
  The Docker sidecar reservation was already removed in [PR #15429](https://github.com/proompteng/lab/pull/15429).
- **Media:** There is no `argocd/applications/media` directory or `media` destination in the checked-in
  ApplicationSets. This checkout provides no owning manifest or placement to right-size.

## AgentRun capacity on Turin and Altra

At the audited commit, [`controller.defaultWorkload`](../../argocd/applications/agents/values.yaml) requests
**500m CPU, 4Gi memory, and 8Gi ephemeral storage** per default AgentRun workload. Use the admitted Pod's effective
requests for any different release or override. These numbers describe scheduler fit, not how many workloads the
hosts can run at peak use. The workstation contributes its delta only to Turin. Open WebUI has no hard hostname
selector and uses a Ceph RBD claim, so its savings count only on its verified node. Assuming it stays on the same
node before and after the rollout and all other reservations stay constant:

| Open WebUI placement | Turin requests reclaimed (CPU / memory) | Turin extra CPU slots | Altra requests reclaimed (CPU / memory) | Altra extra CPU slots |
| -------------------- | --------------------------------------: | --------------------: | --------------------------------------: | --------------------: |
| Turin                |                                 6 / 4Gi |                **12** |                                 0 / 0Gi |                 **0** |
| Altra                |                                 4 / 0Gi |                 **8** |                                 2 / 4Gi |                 **4** |
| Elsewhere            |                                 4 / 0Gi |                 **8** |                                 0 / 0Gi |                 **0** |

For example, Altra's reported 20.1 CPU of request headroom fits 40 default runs by CPU. If Open WebUI stays there,
22.1 CPU fits 44. The 4Gi delta can add one slot by memory on Open WebUI's host; the devbox adds none by memory.
There is no per-node free memory or disk request budget in the supplied data. For each node and each side of the
rollout, compute:

```text
fit = max(0, min(floor(free_millicpu / 500), floor(free_memory_GiB / 4),
                 floor(free_local_ephemeral_GiB / 8), free_pod_slots))
extra = fit_after - fit_before
```

Here `free` is node allocatable minus requests of assigned, nonterminal Pods, including effective init requests
and Pod overhead; it is not hardware capacity minus utilization. For example, the 8–12 extra runs on Turin
themselves require 32–48Gi of memory and 64–96Gi of local disk. If Open WebUI moves, recalculate from the actual
Pod placements. Apply namespace quotas, AgentRun admission/concurrency limits, and required node affinity, taints
and volume placement separately. Do not spend request headroom if real memory or disk pressure is rising.
Lowering a request does not free physical resources, and unchanged memory limits do not prevent
[node-pressure eviction or node OOM](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/).

## Rollout and acceptance (for an authorized operator)

1. **Baseline before merge.** Using the [Galactic access runbook](galactic-kubernetes-access.md), record the
   deployed revisions, target Pod placement, allocatable and effective Pod requests on both nodes, restart and
   eviction history, CPU contention and working set. Qualify Open WebUI's 4Gi request against a representative
   peak window including cold start, authenticated streaming, and document traffic if enabled. Do not roll out
   the memory cut if that working set does not fit with margin or the evidence is missing. Confirm the devbox
   does not rely on exclusive CPUs and coordinate a workstation restart with its owner. Choose a window safe for
   both restarts: the two automatic Kargo promotions are independent, so the following acceptance order is not a
   cross-application sync guarantee.
2. **Jangar first.** Use the [normal image promotion path](../release-automation.md) through
   `jangar-release:jangar` and verify the Stage-generated `kargo/jangar` revision contains the request change.
   Confirm resource values on the new Open WebUI Pod, then exercise an authenticated stream through Jangar and
   any in-use document path. Watch stream latency/errors, worker working set, throttling and restart/OOM counts
   under comparable traffic. The single-replica rollout can briefly interrupt requests.
3. **Turin devbox second.** Let active builds finish before the maintenance window. Verify the matching promotion
   from `devbox-release:devbox` to `kargo/devbox`. The StatefulSet replaces its single Pod; keep its existing PVC
   and initializer in place. Confirm the same PVC UID and SSH identity, `ssh codex-turin devbox-verify`, the same
   8-vCPU / 64-GiB guest sizing, and a representative build and Codex session under concurrent node load. Compare
   latency, throttling, working set and restart/eviction counts to the baseline.
4. **Recompute before spending the headroom.** Verify the effective request deltas at the actual placements and
   apply the fit calculation above. Do not change admission limits in this rollout. Stop if there is new memory or
   disk pressure, `OOMKilled`/evictions, sustained stream or build regression, or a persistence/identity mismatch.

## Rollback

Stop admitting additional work against the reclaimed headroom and let running work finish if the old requests
need more room to fit. Restore only the affected requests in a reviewed Git revert or follow-up, in reverse order
if both are regressing:

1. **Devbox:** Restore `requests.cpu: "8"`; keep `requests.memory: 64Gi` and both limits. Let the matching eligible
   artifact follow `devbox-release:devbox` to `kargo/devbox`, then recheck guest sizing, SSH, build latency, and the
   existing volume's identity and contents. Do not rerun initialization, format the device, or delete the PVC.
2. **Open WebUI:** Restore `requests.cpu: "4"` and `requests.memory: 8Gi`, with limits unchanged. Use
   `jangar-release:jangar` and `kargo/jangar` and recheck an actual stream, document traffic where used, and
   persistence. Do not delete or restore data just to undo a request change.

Verify the exact generated revision, Pod resources and actual behavior on each rollback. Use GitOps, not direct
resource edits, manual image retagging, or changes to namespace ownership.
