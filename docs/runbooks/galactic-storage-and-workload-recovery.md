# Galactic Storage And Workload Recovery

Use this runbook when a Talos node, Ceph, the private registry, and many unrelated workloads fail together. It covers
the safe recovery sequence used for the 2026-08-23 Turin NVMe incident. It does not replace the destructive OSD migration
or recreate procedures in [`rook-ceph-on-talos.md`](rook-ceph-on-talos.md).

## Recovery Contract

Restore in this order:

1. Kubernetes and etcd quorum.
2. The failed node's physical storage inventory.
3. Ceph monitor, OSD, placement-group, and client availability.
4. Filesystem consistency for exact affected RBD images.
5. Node-local CNI capacity.
6. Registry and stateful foundations.
7. Application endpoints and sustained runtime behavior.
8. Argo CD reconciliation, with known drift classified separately.

Stop when an earlier layer is unsafe. Do not compensate for an unavailable shared dependency by repeatedly restarting
all downstream applications.

## Safety Rules

- Operate one control-plane or storage node at a time.
- Check current endpoints in [`galactic-kubernetes-access.md`](galactic-kubernetes-access.md); old `192.168.1.*` node
  names are not current network endpoints.
- Before a power action, verify the exact BMC target, etcd quorum and leader, node cordon, Ceph state, and PDB impact.
- Do not force a drain, bypass a PDB, purge an OSD, zap a disk, reset Talos, or clear a Ceph warning in this flow.
- Never run `e2fsck` on a mounted or in-use block device.
- Snapshot an RBD image before writable filesystem repair and retain that snapshot through a separate rollback window.
- Delete a host-local IPAM lease only after proving the exact file has no live pod owner; hold the allocator lock while
  deleting it.
- Record every live GitOps pause or scale override and restore the previous state before closing the incident.

## Current Node Identity

Resolve live values from the access runbook before every incident. The following values were current on 2026-08-23:

```bash
KUBE_CONTEXT=galactic-lan
TURIN_NODE=turin
TURIN_ENDPOINT=100.100.244.190
TURIN_BMC_HOST=100.100.244.170
ALTRA_NODE=talos-192-168-1-85
ALTRA_ENDPOINT=100.100.244.142
```

`100.100.244.171` was Turin's bring-up/maintenance address; it was not the live Talos API endpoint during the incident.

## Phase 1: Classify The Shared Failure

Capture node, Ceph, Argo, and event evidence before changing anything:

```bash
kubectl --context "$KUBE_CONTEXT" get nodes -o wide
kubectl --context "$KUBE_CONTEXT" get nodes -o json | jq -r '
  .items[] |
  [
    .metadata.name,
    ([.status.conditions[] | select(.type == "Ready")][0].status),
    ([.status.conditions[] | select(.type == "MemoryPressure")][0].status),
    ([.status.conditions[] | select(.type == "DiskPressure")][0].status),
    ([.status.conditions[] | select(.type == "PIDPressure")][0].status),
    .status.allocatable.pods
  ] | @tsv
'

kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf

kubectl --context "$KUBE_CONTEXT" -n argocd get applications.argoproj.io \
  -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision
```

For workload inspection, always query an explicit namespace. Build the namespace list from the affected pods or Argo
applications, then inspect each one:

```bash
for namespace in registry rook-ceph temporal forgejo observability torghut
do
  kubectl --context "$KUBE_CONTEXT" -n "$namespace" get pods -o wide
  kubectl --context "$KUBE_CONTEXT" -n "$namespace" get events --sort-by=.lastTimestamp | tail -n 30
done
```

Classify symptoms before restarting anything:

- Many unrelated `ImagePullBackOff` pods: verify the private registry and its PVC first.
- `ContainerCreating` with RBD mount errors: verify Ceph, VolumeAttachment, and filesystem state.
- Pods `Unknown` on one node: verify Talos and the node's physical disks.
- `FailedCreatePodSandBox` with no IPs: inspect host-local CNI leases and PodCIDR capacity.
- Argo `Degraded`: inspect the actual resource and service condition; do not assume the app is unavailable.

## Phase 2: Recover Turin Storage Enumeration

### Preflight

Check etcd from all current control-plane endpoints:

```bash
talosctl --context ryzen \
  --nodes 100.100.244.141,100.100.244.142,100.100.244.190 \
  etcd status
```

If Turin is the leader and a chassis action is required, move leadership off it and confirm the result:

```bash
kubectl --context "$KUBE_CONTEXT" cordon "$TURIN_NODE"
talosctl --context ryzen --nodes "$TURIN_ENDPOINT" etcd forfeit-leadership
talosctl --context ryzen \
  --nodes 100.100.244.141,100.100.244.142,100.100.244.190 \
  etcd status
```

If the node is healthy enough for a normal reboot, prefer `talosctl reboot --mode=default --wait`. Use BMC/IPMI only
when the normal path cannot restore hardware enumeration or the authorized recovery specifically requires a chassis
transition.

### Authorized BMC power cycle

The workstation already has the operator-provisioned credential file
`~/.config/lab-secrets/turin-bmc.json`. Use the
[Turin credential helper](../../devices/turin/docs/bmc-fan-bringup.md#credential-handling),
which reads that existing source and passes the password through `IPMI_PASSWORD`.
Keep the file at mode `0600` and its directory at mode `0700`. This procedure
does not create another credential copy or change the account, target, or
permissions. Keep the password out of arguments, repositories, chat, and shell
traces. Stop on authentication failure.

```bash
turin_ipmi chassis power status
turin_ipmi chassis power cycle
```

The power command requires explicit authorization. The read-only credential retrieval does not authorize another power
action.

### Post-boot disk proof

Wait for the current Talos endpoint and verify model, serial, and size rather than accepting a node `Ready` condition:

```bash
talosctl --nodes "$TURIN_ENDPOINT" --endpoints "$TURIN_ENDPOINT" version
talosctl --nodes "$TURIN_ENDPOINT" --endpoints "$TURIN_ENDPOINT" get disks -o json | jq -r '
  select(.metadata.id | startswith("nvme")) |
  [.metadata.id, .spec.size, .spec.model, .spec.serial] | @tsv
'
```

Expected Turin NVMe inventory:

```text
nvme0n1  256060514304   TS256GMTE652T2       I203860329
nvme1n1  256060514304   INTEL SSDPEKKF256G8L BTHH851313AU256B
nvme2n1  1000204886016  KINGSTON SNV3S1000G  50026B76878F0B27
nvme3n1  4096805658624  ORICO                 13CBMEK6HEW8CN2X9AKW
```

Device numbers can change. Ceph and Talos configuration must continue to use stable by-id identities.

## Phase 3: Recover Ceph Without Hiding Damage

After Turin returns, verify that the existing OSD identities come back. Do not purge or recreate them merely because
they were temporarily down:

```bash
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd stat
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg stat
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
```

Required availability gate before restoring clients:

- all three monitors are in quorum;
- all six intended OSDs are `up` and `in`;
- no inactive, stale, or unavailable PGs;
- CephFS, RBD, and RGW services used by the workloads are available;
- any recovery or backfill is understood and making progress;
- no recovery-only Ceph flags remain accidentally set.

`HEALTH_WARN` can coexist with available data. Report the exact warning, PG state, misplaced/degraded percentage, client
latency, and recovery direction. Do not turn `Synced/Degraded` into `Healthy` by clearing a warning or increasing its
lifetime.

### Scrub progress during recovery

[`cluster-values.yaml`](../../argocd/applications/rook-ceph/cluster-values.yaml) allows new scrubs during recovery with
`osd_scrub_during_recovery: "true"`. The built-in `high_client_ops` profile retains capacity for
background best effort. Scrub shares the last class with backfill, snap trimming, and PG deletion. `osd_max_scrubs`
allows one local scrub reservation and one remote reservation per OSD. Scrubs can start throughout the day and week.
The former three-reservation catch-up setting adds concurrent scans on the same HDDs that serve synchronous database
WAL. Keep concurrency bounded while retaining periodic integrity checks, recovery-time scrubs, and debt alerts.

A PG marked `scrubbing` can still wait for a replica reservation. Inspect `scrub_schedule` in `ceph pg dump pgs -f json`
and `ceph tell osd.<id> dump_scrub_reservations -f json` to distinguish scans from reservation waits. After a concurrency
change, require `osd_max_scrubs: 1` and `remote_scrub_reservations.max_allowed: 1` from every running OSD. This setting
updates at runtime and does not require OSD restarts.

Roll out a reviewed, merged values change through the existing Rook Argo application. This option updates at runtime;
do not restart OSDs or change the OSD rollout annotation for it. Check effective settings and reservation limits on every OSD:

```bash
set -euo pipefail
for osd in 0 1 2 3 4 5; do
  printf 'osd.%s\n' "$osd"
  kubectl --context galactic-lan -n rook-ceph exec deployment/rook-ceph-tools -c rook-ceph-tools -- \
    ceph tell "osd.$osd" config get osd_scrub_during_recovery -f json \
    | jq -e '.osd_scrub_during_recovery == "true"'
  kubectl --context galactic-lan -n rook-ceph exec deployment/rook-ceph-tools -c rook-ceph-tools -- \
    ceph tell "osd.$osd" config get osd_max_scrubs -f json \
    | jq -e '.osd_max_scrubs == "1"'
  kubectl --context galactic-lan -n rook-ceph exec deployment/rook-ceph-tools -c rook-ceph-tools -- \
    ceph tell "osd.$osd" dump_scrub_reservations -f json \
    | jq -e '.osd_max_scrubs == 1 and .remote_scrub_reservations.max_allowed == 1'
done
```

Require all three checks to return `true` for each of the six running OSDs before accepting activation. A stale or missing
value fails the command. The monitor config store alone is insufficient.

Compare scrub completion timestamps with `ceph pg dump pgs -f json`, OSD commit latency with `ceph osd perf`, and
affected application latency before and after an authorized rollout. More scrub concurrency adds HDD contention;
an active scrub alone does not prove that debt is shrinking. Lowering the limit lets existing scrubs finish; wait for their
reservations to drain before comparing steady-state windows. Compare WAL fsync deltas, synchronous replication waits,
and application deadline failures alongside scrub completion counts. Fewer concurrent scrubs alone do not prove that
database latency or trading has recovered. If the lower limit causes unacceptable scrub debt without an application
benefit, restore `osd_max_scrubs` to `"3"` through a reviewed GitOps change. If scrubs during recovery cause a regression,
revert `osd_scrub_during_recovery` to `"false"` through GitOps. Existing scrubs finish, while recovery blocks new periodic
scrubs. Keep scrub intervals and warnings enabled. See
[Ceph's scrub configuration](https://docs.ceph.com/en/tentacle/rados/configuration/osd-config-ref/#osd-max-scrubs).

## Phase 4: Repair An Exact RBD Filesystem

Use this only when Ceph is serving the image but kubelet reports ext4 errors or the volume will not mount. Substitute the
exact workload and PVC; never reuse an incident's `/dev/rbdN` number.

### Resolve ownership and image identity

```bash
PVC_NAMESPACE=observability
PVC_NAME='<exact-pvc>'

PV_NAME="$(
  kubectl --context "$KUBE_CONTEXT" -n "$PVC_NAMESPACE" get pvc "$PVC_NAME" \
    -o jsonpath='{.spec.volumeName}'
)"
RBD_POOL="$(
  kubectl --context "$KUBE_CONTEXT" get pv "$PV_NAME" \
    -o jsonpath='{.spec.csi.volumeAttributes.pool}'
)"
RBD_IMAGE="$(
  kubectl --context "$KUBE_CONTEXT" get pv "$PV_NAME" \
    -o jsonpath='{.spec.csi.volumeAttributes.imageName}'
)"

kubectl --context "$KUBE_CONTEXT" get pv "$PV_NAME" -o json | jq '{
  name: .metadata.name,
  handle: .spec.csi.volumeHandle,
  attributes: .spec.csi.volumeAttributes
}'
```

Resolve the owning controller from the pod and record its current replica count and Argo automation state before changing
either one.

### Snapshot before writable repair

```bash
CEPH_TOOLS="$(
  kubectl --context "$KUBE_CONTEXT" -n rook-ceph get pod -l app=rook-ceph-tools \
    -o jsonpath='{.items[0].metadata.name}'
)"
RBD_SNAPSHOT="pre-fsck-$(date -u +%Y%m%dT%H%M%SZ)"

kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec "$CEPH_TOOLS" -- \
  rbd snap create "$RBD_POOL/$RBD_IMAGE@$RBD_SNAPSHOT"
kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec "$CEPH_TOOLS" -- \
  rbd snap ls "$RBD_POOL/$RBD_IMAGE"
```

Do not delete the snapshot as part of the repair.

### Stop the owner and prove the device is idle

Scale only the exact owner down through the smallest reversible live override needed for the emergency. Wait for its pod,
VolumeAttachment, RBD watcher, mount, and open-file references to disappear:

```bash
kubectl --context "$KUBE_CONTEXT" get volumeattachments.storage.k8s.io -o json | jq \
  --arg pv "$PV_NAME" \
  '.items[] | select(.spec.source.persistentVolumeName == $pv) |
   {name: .metadata.name, node: .spec.nodeName, attached: .status.attached}'

kubectl --context "$KUBE_CONTEXT" -n rook-ceph exec "$CEPH_TOOLS" -- \
  rbd status "$RBD_POOL/$RBD_IMAGE"
```

If the image remains mapped on a node, identify the exact mapping with `rbd device list --format json`. From a bounded
privileged Ceph CSI maintenance pod pinned to that node, prove all of the following before repair:

```bash
findmnt -rn -S /dev/rbdN
fuser -vm /dev/rbdN
lsblk -o NAME,MAJ:MIN,SIZE,FSTYPE,MOUNTPOINTS /dev/rbdN
```

`findmnt` must return no mount and `fuser` must show no users. A missing VolumeAttachment alone is not sufficient proof.

### Repair and verify

Start with a read-only check:

```bash
e2fsck -fn /dev/rbdN
```

After the snapshot and idle-device gates pass, use `e2fsck -p` for safe automatic repairs. Use `e2fsck -fy` only when
the readback proves a repair that `-p` cannot complete and the exact image is still snapshotted and unused. Then verify:

```bash
e2fsck -fn /dev/rbdN
```

Unmount or unmap only the exact temporary mapping, delete the maintenance pod, restore the previous GitOps/controller
state, and verify the workload endpoint. Keep the snapshot until a separate rollback-window decision.

## Phase 5: Recover Host-Local IPAM Exhaustion

Typical evidence is `FailedCreatePodSandBox` with a host-local error indicating that no IP addresses are available.

### Prove the capacity mismatch

```bash
kubectl --context "$KUBE_CONTEXT" get node "$ALTRA_NODE" -o json | jq '{
  podCIDR: .spec.podCIDR,
  podCIDRs: .spec.podCIDRs,
  allocatablePods: .status.allocatable.pods
}'

talosctl --nodes "$ALTRA_ENDPOINT" ls -l /var/lib/cni/networks/cbr0
```

For the 2026-08-23 incident, the node advertised 500 pods while `10.244.5.0/24` exposed 252 usable host-local leases.

### Prove exact orphan candidates

Build a live-pod-IP list by querying every namespace explicitly:

```bash
LIVE_IPS_FILE="$(mktemp)"
for namespace in $(kubectl --context "$KUBE_CONTEXT" get namespaces -o jsonpath='{.items[*].metadata.name}')
do
  kubectl --context "$KUBE_CONTEXT" -n "$namespace" get pods \
    --field-selector "spec.nodeName=$ALTRA_NODE" -o json | jq -r '
      .items[] |
      select(.status.phase != "Succeeded" and .status.phase != "Failed") |
      .status.podIP // empty
    '
done | sort -u >"$LIVE_IPS_FILE"
```

Compare it with lease filenames, then inspect each candidate with `talosctl ls -l` and `talosctl read`. A candidate is
not removable unless all of these are true:

- its filename is inside the node's current PodCIDR;
- no nonterminal pod on that node owns the address;
- the file is old relative to current pod churn;
- its content does not identify a live container allocation;
- the exact candidate set is reviewed immediately before deletion.

Also inspect Kubernetes container state on the node before deleting candidates:

```bash
talosctl --nodes "$ALTRA_ENDPOINT" containers --kubernetes
```

### Delete only the reviewed files under the allocator lock

The following candidate list is the exact 2026-08-23 incident receipt. Never reuse it. Rebuild and re-prove the candidate
set for the current node state immediately before any deletion:

```bash
STALE_IPS=(10.244.5.218 10.244.5.225 10.244.5.231 10.244.5.232 10.244.5.236)
DEBUG_ARGS=(
  --args=/usr/bin/flock
  --args=-x
  --args=/proc/1/root/var/lib/cni/networks/cbr0/lock
  --args=/bin/rm
  --args=-f
)

for ip in "${STALE_IPS[@]}"
do
  DEBUG_ARGS+=(--args="/proc/1/root/var/lib/cni/networks/cbr0/$ip")
done

talosctl debug docker.io/library/alpine:3.22 \
  --nodes "$ALTRA_ENDPOINT" \
  "${DEBUG_ARGS[@]}"
```

Re-list the exact filenames and watch pending pods acquire addresses. Do not delete the lock, allocation directory, a
range of files, or every address not currently shown in one incomplete API read.

Remove the temporary local file when finished:

```bash
rm -f "$LIVE_IPS_FILE"
unset LIVE_IPS_FILE
```

The durable correction is GitOps/Talos capacity alignment: give the node an address range that supports the configured
pod limit, or reduce `maxPods`. Manual lease cleanup is an emergency recovery, not capacity management.

## Phase 6: Restore Applications And Prove Behavior

Restore foundations before dependents:

1. Ceph and CSI.
2. Registry.
3. Databases, Kafka, Temporal, Forgejo, and observability storage.
4. Jangar/Bumba and other Temporal consumers.
5. Torghut feed, runtime, websocket, options, and reconciliation workloads.
6. Remaining stateless applications and runners.

For every affected namespace, require all nonterminal pods to be running and all containers ready. Then verify application
behavior:

```bash
export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" operator cluster health

kubectl --context "$KUBE_CONTEXT" -n forgejo get pods -o wide
kubectl --context "$KUBE_CONTEXT" -n registry get pods -o wide
kubectl --context "$KUBE_CONTEXT" -n media get pods -l app.kubernetes.io/name=plex -o wide
kubectl --context "$KUBE_CONTEXT" -n observability get pods -o wide
kubectl --context "$KUBE_CONTEXT" -n torghut get pods -o wide
```

Also prove the real HTTP, gRPC, database, queue, and market-data paths used by each service. A pod being `Running` or an
Argo application being `Healthy` is not endpoint proof.

## Phase 7: Interpret Argo CD Correctly

```bash
kubectl --context "$KUBE_CONTEXT" -n argocd get applications.argoproj.io \
  -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision
```

- `Synced/Healthy`: verify the runtime endpoint anyway.
- `Synced/Degraded`: inspect the exact child condition. For Ceph, a real backfill or slow-operation warning must remain
  visible. For an aggregate media app, verify Plex directly.
- `OutOfSync/Healthy`: classify generated-resource drift before syncing. Do not use a broad forced sync as outage cleanup.
- A Git commit, image promotion, or Argo revision is delivery evidence, not sustained runtime evidence.

## Completion Receipt

Record all of the following in the incident report:

- current Kubernetes, Talos, and GitOps revisions;
- all node readiness and pressure conditions;
- expected physical disk identity and size readback;
- etcd member and leader state;
- Ceph monitor, OSD, PG, recovery, client-I/O, and warning state;
- RBD snapshot names and the exact repaired PVC/image identities;
- exact host-local IPAM files removed and the proof that no live pod owned them;
- application endpoint results and a sustained stability window for services that failed repeatedly;
- known Argo drift or health warnings intentionally left visible;
- reversible live overrides restored and retained rollback artifacts.

## Related Incident

- [2026-08-23 Turin NVMe, Ceph, and application recovery](../incidents/2026-08-23-turin-nvme-ceph-and-application-recovery.md)
