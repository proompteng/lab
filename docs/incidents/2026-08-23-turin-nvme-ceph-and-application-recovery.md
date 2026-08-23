# Incident Report: Turin NVMe Loss, Ceph Recovery, And Application Restoration

- **Date**: 2026-08-23 UTC
- **Detected by**: Kubernetes pod state, Argo CD, Talos disk inventory, Rook Ceph health, and service probes
- **Primary infrastructure affected**: `turin`, Rook Ceph, RBD CSI, registry, and Altra host-local CNI IPAM
- **Primary applications affected**: Temporal, Forgejo, observability, Torghut, Plex, and the private registry
- **Additional affected namespaces**: `agents`, `arc`, `attic`, `bilig`, `buzz`, `flamingo`, `forgejo-runners`,
  `froussard`, `hermes`, `jangar`, `kafka`, `oirat`, and `synthesis`
- **Severity**: Critical cluster-wide workload outage
- **Status at write time**: Applications restored; Ceph data is available and backfill is improving; a historical
  BlueStore slow-operation warning remains visible and must not be suppressed

## Impact Summary

The outage initially presented as a broad set of `ImagePullBackOff`, `ContainerCreating`, `CrashLoopBackOff`, `Pending`,
and `Unknown` pods. The failures crossed unrelated applications because several shared dependencies were unavailable at
the same time:

- Turin stopped enumerating all four expected NVMe devices.
- Three Ceph OSDs on Turin lost their NVMe-backed BlueStore DB/WAL path and went unavailable.
- The private registry and RBD-backed stateful services could not mount or use their storage consistently.
- Registry unavailability turned new pod starts into `ImagePullBackOff`, amplifying the storage outage.
- Two Mimir RBD filesystems and the registry RBD filesystem required offline ext4 repair after storage returned.
- Altra's host-local `cbr0` IPAM directory contained leases for every usable address in its `/24` PodCIDR, preventing
  additional pods from receiving an address even after storage recovered.

The pasted outage snapshot contained failed workloads in 18 namespaces, including both Forgejo runners, Forgejo,
Kafka's entity operator, Plex, Mimir, the registry, Temporal consumers in Jangar, and Torghut's feed, runtime, websocket,
options, and reconciliation workloads.

## User-Facing Symptoms

- Forgejo and its runners were unavailable.
- Temporal-dependent Jangar and Bumba workloads could not start reliably.
- The private registry was unavailable, so otherwise healthy nodes could not pull missing images.
- Plex was `Unknown` because its pod was on the disrupted Turin node.
- Mimir distributors, ingesters, and ruler were unavailable.
- Torghut Hyperliquid feed/runtime, websocket, options enrichment, and reconciliation paths were unavailable or failing.
- Argo CD showed a mixture of `Degraded`, `Progressing`, and `OutOfSync` applications, but those aggregate states did not
  identify the common infrastructure failure by themselves.

## Root Cause

This incident had one primary infrastructure cause and several independent residual causes exposed during recovery.

### Primary infrastructure cause

Turin's running Talos system did not enumerate any of the four expected NVMe devices. A normal application restart or
Kubernetes reschedule could not restore devices that were absent below the operating-system storage layer. An authorized
BMC/IPMI chassis power cycle caused the PCIe/NVMe devices to enumerate again:

| Device                       |   Size | Role                           |
| ---------------------------- | -----: | ------------------------------ |
| Transcend `TS256GMTE652T2`   | 256 GB | rebuildable local scratch only |
| Intel `SSDPEKKF256G8L`       | 256 GB | rebuildable local scratch only |
| Kingston `SNV3S1000G`        | 1.0 TB | Turin Ceph BlueStore DB/WAL    |
| ORICO `13CBMEK6HEW8CN2X9AKW` | 4.1 TB | Talos install and EPHEMERAL    |

The recovery proves that a full chassis power transition restored enumeration. It does not prove why the PCIe carrier or
firmware stopped exposing all four devices. That hardware/firmware cause remains open and must not be replaced with an
unsupported conclusion.

### Residual storage cause

The abrupt loss of RBD availability left ext4 metadata inconsistent on two Mimir volumes and the registry volume.
Bringing all Ceph OSDs back `up/in` restored block availability, but it did not repair those filesystems. Each affected
RBD image was snapshotted, detached from its workload, proved unmounted, repaired offline, verified read-only, and then
returned to service.

### Residual scheduling cause

Altra advertises an allocatable pod count of `500`, but its live PodCIDR was `10.244.5.0/24`. Host-local CNI had lease
files for all 252 usable addresses (`10.244.5.3` through `10.244.5.254`). Five files were zero-byte, old, and had no live
pod owner:

```text
10.244.5.218
10.244.5.225
10.244.5.231
10.244.5.232
10.244.5.236
```

Removing only those proven-stale files under the host-local IPAM lock restored immediate scheduling capacity. It did not
resolve the durable mismatch between `maxPods: 500` and a single `/24` address range.

### Residual Torghut causes

Infrastructure recovery exposed three application-level failures that needed code fixes rather than repeated restarts:

1. The scheduler's TigerBeetle protocol health path repeatedly created native clients. Reusing one process-local client
   and closing it on reset and shutdown removed the connection and memory growth.
2. The options archive empty-result safeguard treated already-expired catalog rows as evidence that a Sunday provider
   response could not legitimately be empty. The guard now considers only rows whose `expiration_date` is on or after
   the observation date.
3. Hyperliquid feed readiness scanned roughly 88 million ClickHouse rows every 30 seconds. During recovery, query time
   crossed the readiness window and caused endpoint churn. The query now restricts reads to active parts modified within
   the ingest readiness window plus a 60-second grace. It intentionally does not filter `event_ts`, so delayed and replayed
   records retain ingest-based readiness semantics.

## Five Whys

### Cluster-wide workload failure

1. **Why were unrelated applications down?** Their pods could not pull images, mount RBD volumes, or remain connected to
   stateful dependencies.
2. **Why did those shared paths fail?** Turin was unavailable as a storage host and the registry and stateful RBD clients
   were disrupted.
3. **Why was Turin unavailable as a storage host?** Talos could not see any of the four expected NVMe devices, including
   the Kingston BlueStore DB/WAL device and the ORICO Talos disk.
4. **Why did an ordinary workload restart not repair it?** NVMe enumeration had failed below Kubernetes and the Talos
   service layer; the devices returned only after a BMC chassis power cycle.
5. **Why did some stateful services remain down after Ceph returned?** Their ext4 filesystems had inconsistent metadata
   and required controlled offline repair before they could be mounted safely.

### Scheduling remained blocked after storage recovery

1. **Why did new pods still fail to start on Altra?** Host-local IPAM reported no available addresses.
2. **Why were there no addresses?** Every usable address in `10.244.5.0/24` had a lease file.
3. **Why did the lease count exceed live pod ownership?** Five old zero-byte files were not released with their previous
   pods.
4. **Why can this recur?** The node is configured for 500 pods while one `/24` supplies only 252 host-local leases.
5. **What actionable system change is required?** Align the node pod limit and PodCIDR capacity, then alert before lease
   utilization reaches exhaustion.

## Contributing Factors

- Three Turin HDD OSDs share one host-local Kingston NVMe for BlueStore DB/WAL.
- The private registry is itself stateful, so its failure turns later restarts into image-pull failures.
- Ceph backfill, client I/O, and filesystem repair competed for the same recovering storage resources.
- Several controllers kept retrying while their shared dependencies were unavailable, creating noisy terminal pods.
- Argo CD aggregate health mixed current failures, generated-resource drift, and historical conditions.
- The Altra `maxPods` documentation expected a `/23`, but the live node had a `/24`.
- Torghut readiness checks and native client lifetime amplified recovery load independently of the storage failure.

## What Was Not The Root Cause

- The many `ImagePullBackOff` pods did not prove 18 independent image or credential failures. Registry and node recovery
  restored the common pull path.
- `Application/rook-ceph` being `Synced/Degraded` does not mean Ceph data is unavailable. At write time all six OSDs were
  `up/in`; Argo remained degraded because Ceph still exposed a real warning and active backfill.
- `agents`, `buzz`, and `hermes` being `OutOfSync/Healthy` did not mean their workloads were down. Their remaining drift
  was generated-resource drift and was not blindly synchronized during the incident.
- `home-media` being `Synced/Degraded` did not mean Plex was still unavailable. The live Plex pod was `1/1 Running`.
- A normal empty provider result on Sunday was not an upstream options outage.
- No evidence showed loss of Ceph objects. Recovery snapshots were retained and the final Ceph volume state was healthy.

## Recovery Actions

### 1. Protected control-plane quorum before the power action

- Verified the other two control-plane nodes and etcd quorum.
- Cordoned `turin`.
- Moved etcd leadership off Turin and verified the new leader.
- Used the already signed-in 1Password CLI session to pass the authorized BMC credential to `ipmitool` without printing,
  persisting, or putting it on the command line.
- Issued one chassis power cycle to the verified Turin BMC target.

The reusable credential and power-control procedure is in
[`devices/turin/docs/bmc-fan-bringup.md`](../../devices/turin/docs/bmc-fan-bringup.md).

### 2. Proved Talos and NVMe recovery

- Waited for the Talos API and Kubernetes node to return.
- Verified all four NVMe models, serials, and sizes from the current Turin endpoint.
- Verified `turin` became `Ready` with no memory, disk, or PID pressure.
- Uncordoned Turin only after storage and scheduling gates were satisfied.

### 3. Recovered Ceph sequentially

- Verified monitor quorum before making storage changes.
- Brought the three Turin OSDs back without purging or recreating their identities.
- Kept all six OSDs `up/in` and let Rook/Ceph perform normal recovery and backfill.
- Did not force drains, bypass PDBs, purge OSDs, clear health warnings, or hide slow-operation alerts.
- Restored normal recovery flags after the bounded filesystem-maintenance windows.

### 4. Repaired affected RBD filesystems

- Created `pre-fsck-20260823T075900Z` snapshots for the two affected Mimir RBD images.
- Created `pre-fsck-20260823T082500Z` for the affected registry RBD image.
- Recorded the exact retained rollback targets:

  | Namespace       | PVC                                      | RBD image                                      | Snapshot                    |
  | --------------- | ---------------------------------------- | ---------------------------------------------- | --------------------------- |
  | `observability` | `storage-observability-mimir-ingester-0` | `csi-vol-4df92d86-33be-46fe-b74c-7e206c31ee42` | `pre-fsck-20260823T075900Z` |
  | `observability` | `storage-observability-mimir-ingester-1` | `csi-vol-f4332a73-8f5e-4dd5-bd0c-9507fd600de0` | `pre-fsck-20260823T075900Z` |
  | `registry`      | `registry-data`                          | `csi-vol-0b93afd9-7273-4d72-8110-8d5b000056aa` | `pre-fsck-20260823T082500Z` |

- Scaled the exact owning workloads down and waited for mounts and attachments to clear.
- Proved each target block device was unmounted and unused before running `e2fsck`.
- Performed the required ext4 repairs from a bounded privileged maintenance pod.
- Re-ran read-only filesystem checks, unmapped temporary devices, deleted the maintenance pods, and restored the exact
  workloads.
- Retained all three snapshots for rollback; this incident did not authorize snapshot deletion.

### 5. Recovered Altra host-local IPAM

- Counted 252 `cbr0` lease files for Altra's `10.244.5.0/24` PodCIDR.
- Compared lease filenames with live pod IPs on `talos-192-168-1-85`.
- Inspected the five candidates and proved they were old, zero-byte files with no live pod owner.
- Removed exactly those five files with `flock` held on `/var/lib/cni/networks/cbr0/lock` from a Talos debug container.
- Verified the files were gone and allowed normal CNI allocation to recreate only leases it needed.

### 6. Recovered and hardened Torghut

- Promoted the TigerBeetle native-client lifecycle fix through PRs
  [#14005](https://github.com/proompteng/lab/pull/14005) and
  [#14006](https://github.com/proompteng/lab/pull/14006), with source commit `88042167a9` and promotion commit
  `793b31c362`.
- Corrected options archive finalization through PRs
  [#14009](https://github.com/proompteng/lab/pull/14009) and
  [#14010](https://github.com/proompteng/lab/pull/14010), with source commit `e28880f2` and promotion commit
  `f4ac0a8121`.
- Bounded Hyperliquid readiness scans without changing ingest semantics through PRs
  [#14011](https://github.com/proompteng/lab/pull/14011) and
  [#14012](https://github.com/proompteng/lab/pull/14012), with source commit `d2db3032`, promotion commit `fc3f9c39`, and
  image digest `sha256:7f0a67c6a08c846afabdb7364a301e182a0ec64096cce68fc3f8a59aa47d4614`.
- Verified runtime behavior after image promotion instead of treating merged source or Argo sync as completion.

### 7. Refreshed Temporal operational guidance

- Verified the installed Temporal CLI as `1.8.2` and live cluster health as `SERVING`.
- Replaced the stale claim that the CLI predates Worker Deployment inspection APIs. The CLI now directly reports Current
  and Ramping Versions, drainage, task queues, and task-queue statistics.
- Retained the Bumba/Jangar routing command as an application-specific `routingConfigUpdateState=COMPLETED` cross-check.
- Added explicit authorization gates for routing changes, version deletion, reset, cancellation, and termination; routine
  recovery must not bypass drainage or missing-poller protections.

## Final Verification

The following was rechecked live at 2026-08-23T17:59Z after the recovery and code promotions.

### Nodes and disks

- All three control-plane nodes were `Ready` on Kubernetes `v1.36.4` and Talos `v1.13.9`.
- `MemoryPressure=False`, `DiskPressure=False`, and `PIDPressure=False` on every node.
- Turin reported all four expected NVMe devices: 256 GB, 256 GB, 1.0 TB, and 4.1 TB.
- No nonterminal, non-ready pod remained in the 18 outage namespaces.

### Ceph

```text
HEALTH_WARN: 4 OSD(s) experiencing slow operations in BlueStore
mon: 3 daemons in quorum
osd: 6 up, 6 in
volumes: 1/1 healthy
pgs: 591 active+clean, 6 backfill_wait, 1 backfilling, 3 scrub/deep-scrub
misplaced: 0.517%
recovery: approximately 15.6 MiB/s
```

Ceph was available and improving, but not `HEALTH_OK`. The warning remains a required operational signal. Recovery is
not complete merely because Argo CD is `Synced`; continue observing backfill, OSD latency, and the BlueStore warning.

### Applications

| Application group | Final proof                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Temporal          | Argo `Synced/Healthy`, all service pods ready, `temporal operator cluster health` returned `SERVING`                              |
| Forgejo           | Argo `Synced/Healthy`; Forgejo and database pods ready; HTTP health and cache/database checks passed                              |
| Registry          | Argo `Synced/Healthy`; pod `2/2 Running`; `/v2/` returned `{}`                                                                    |
| Plex              | live pod `1/1 Running` on Turin                                                                                                   |
| Observability     | Argo `Synced/Healthy`; all 31 nonterminal pods ready                                                                              |
| Torghut           | base, options, Hyperliquid feed, and Hyperliquid runtime applications `Synced/Healthy`                                            |
| Other outage apps | `arc`, `attic`, `bilig`, `flamingo`, `forgejo-runners`, `froussard`, `jangar`, `kafka`, `oirat`, and `synthesis` `Synced/Healthy` |

Known non-outage Argo states at write time:

- `agents`, `buzz`, and `hermes`: `OutOfSync/Healthy` generated-resource drift.
- `home-media`: `Synced/Degraded` stale aggregate while the live Plex pod was ready.
- `rook-ceph`: `Synced/Degraded` because the live Ceph warning and backfill were still real.

### Torghut runtime receipts

- TigerBeetle scheduler soak: 26/26 samples over 15 minutes, zero restarts, three stable connections, and bounded RSS.
- Options archive shard `2026-08-17/2026-08-23`: complete with retry count zero; 295,536 rows transitioned;
  309,760 expired and zero effectively active at the final status readback.
- Hyperliquid: 46/46 feed checks and 46/46 runtime checks over 15 minutes, with zero failures and zero restarts.
- Live freshness queries completed in milliseconds and read MiB rather than scanning the previous multi-GiB table surface.

## Follow-Up Actions

1. Investigate the Turin PCIe carrier, firmware, power management, and hardware logs to determine why all four NVMe
   devices disappeared together.
2. Alert when a Talos node's expected by-id NVMe inventory changes.
3. Continue Ceph observation until all PGs are clean; investigate the four BlueStore slow-operation warnings from current
   OSD latency evidence. Do not clear or lengthen the alert merely to make Argo green.
4. Retain the three pre-fsck RBD snapshots through an explicit rollback window, then remove them only under a separate
   reviewed maintenance decision.
5. Align Altra's PodCIDR capacity with `maxPods: 500`, or lower `maxPods` to the proven address capacity. Add host-local
   lease utilization and orphan detection before exhaustion.
6. Add an expected-storage-inventory and host-local-IPAM section to the cluster recovery runbook.
7. Keep the Torghut TigerBeetle, options archive, and Hyperliquid readiness receipts in maintained operational docs.
8. Reconcile generated Argo drift separately; do not combine it with outage recovery or force a broad sync.

## Lessons Learned

- Start broad application outages at shared storage, registry, node, and CNI dependencies before restarting each app.
- A BMC power cycle is justified only after target, quorum, and storage gates are proven; it is not a first-line workload
  restart mechanism.
- Ceph block availability and filesystem consistency are different gates.
- `Running`, Argo `Healthy`, and a merged source fix are intermediate states. Endpoint behavior and sustained runtime
  receipts close the recovery.
- Host-local IPAM files are mutable node state. Delete only exact proven orphans under the allocator lock.
- Preserve ingest-time readiness semantics for replay-capable market data; an event-time partition filter would have
  hidden valid delayed records.

## References

- [Galactic storage and workload recovery runbook](../runbooks/galactic-storage-and-workload-recovery.md)
- [Rook-Ceph on Talos](../runbooks/rook-ceph-on-talos.md)
- [Galactic Kubernetes and Talos access](../runbooks/galactic-kubernetes-access.md)
- [Turin BMC and fan bring-up](../../devices/turin/docs/bmc-fan-bringup.md)
- [Torghut data-plane recovery](../torghut/data-plane-recovery.md)
- [Torghut TigerBeetle ledger runbook](../torghut/tigerbeetle-ledger-runbook.md)
- [Temporal operations skill](../../skills/temporal/SKILL.md)
- [Temporal Worker Versioning guide](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)
- [Temporal CLI worker command reference](https://docs.temporal.io/cli/command-reference/worker)
- [2026-06-27 Galactic node disruption](2026-06-27-galactic-node-disruption-kafka-ceph-torghut-recovery.md)
