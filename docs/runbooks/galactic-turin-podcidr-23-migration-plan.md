# Turin and Altra /23 PodCIDR maintenance

Status on 2026-09-06 UTC: production preparation is deployed; neither production Node has been replaced.
Migrate Turin completely, then Altra. Leave Ryzen's Node and kubelet limit unchanged.

## Desired state and current evidence

| Node                         | Existing PodCIDR | Containing /23  | Prepared maxPods |
| ---------------------------- | ---------------- | --------------- | ---------------- |
| Turin, `turin`               | `10.244.0.0/24`  | `10.244.0.0/23` | 250              |
| Altra, `talos-192-168-1-85`  | `10.244.5.0/24`  | `10.244.4.0/23` | 250              |
| Ryzen, `talos-192-168-1-194` | `10.244.3.0/24`  | `10.244.2.0/23` | 500              |

The final target is a distinct `/23` and `maxPods: 500` on Turin and Altra. A `/23` contains 512 total addresses.
Flannel and host-local reserve addresses, so 512 is not the number available to application pods. A 500-pod limit
leaves address headroom but does not establish CPU, memory, disk, or workload capacity for every 500-pod mix.

Preparation merged in [PR #14358](https://github.com/proompteng/lab/pull/14358), commit
`dbde3319853dadc807d2c2cf558fbf8a1c8ca493`, and was applied through the secret-safe Omni template workflow.
All three running controller managers use `--node-cidr-mask-size=23`. Existing Node UIDs and `/24` allocations were
retained. Both targets advertise 250 pods; all machines are Ready. The flag affects newly registered Nodes only.

CephFS placement merged in [PR #14355](https://github.com/proompteng/lab/pull/14355). Active `cephfs-a` is on Altra;
standby-replay `cephfs-b` is on Turin. A dedicated RWX probe observed successful writes, fsyncs, renames, and readbacks
through the MDS rollout. Its maximum observed stall was about 31 seconds. This does not prove uninterrupted latency
or availability for every application. Fresh direct etcd and verified encrypted full Omni backups are held privately
on the operator machine and NUC. Neither backup substitutes for application-volume recovery.

## Availability and maintenance authority

The operator explicitly accepted service downtime on 2026-09-07 UTC, including Flamingo on Turin and Saigak on Altra.
Live inventory found single-instance services, single-instance CNPG clusters,
local volumes, restrictive PDBs, and ARM-only applications on the cluster's only ARM node. Examples include Plex,
Open WebUI, Redis, Forgejo, and ARM-only apps. They cannot all be treated as movable replicas.

Use workload-specific temporary maintenance controls and record their exact restoration before draining. Keep PVCs
and local data, preserve etcd quorum, and recover one Ceph storage host completely before maintaining the other.
Do not lower Ceph pool safety settings or call a successful drain proof of application continuity.

## Rehearsed lifecycle

The disposable NUC rehearsal used Talos `v1.13.9`, Kubernetes `v1.36.4`, and production Flannel `v0.28.5` with
VXLAN port 4789 and MTU 1400. Its starting allocations matched production: `0/24`, `3/24`, `5/24` within `10.244/16`.
The two target analogues acquired `10.244.0.0/23` and `10.244.4.0/23`, with new Node UIDs and maintenance taints at
registration. Host data and the control-plane etcd member ID survived. Both target caps were raised to 500 without
reboot. The Altra analogue ran 280 Ready pods with unique IPs across both halves of its `/23`; DNS, Service routing,
and a cross-node 288 KiB HTTP readback passed under that load.

All rehearsal machines were AMD64 Docker containers. This proves the address lifecycle and the tested helper,
not physical ARM64 storage, GPUs, Kata, or production application continuity. Those require live acceptance.
The control-plane analogue briefly restarted its local API server after re-registration because old and new static
pod lifecycles overlapped on port 6443. It recovered automatically. Production traffic must use surviving API servers;
target-local API continuity is not an assumption of this procedure.

The selected lifecycle retains the machine, disks, Talos state, and etcd membership. It replaces only the Kubernetes
Node registration and the drained node's obsolete CNI state. Do not remove the machine from Omni or reset Talos.
[Omni v1.10.4 removal](https://github.com/siderolabs/omni/blob/v1.10.4/internal/backend/runtime/omni/controllers/omni/machineconfig/status.go)
requests wipes of both STATE and EPHEMERAL. That conflicts with preserving this cluster's local storage.

Talos `v1.13.9` does not support `talosctl service kubelet stop`. Its supported
[`skipNodeRegistration`](https://docs.siderolabs.com/talos/v1.13/reference/configuration/v1alpha1/config)
mode runs static pods without registering a Node. The
[kubelet configuration source](https://github.com/siderolabs/talos/blob/v1.13.9/internal/app/machined/pkg/controllers/k8s/kubelet_spec.go)
uses standalone authentication defaults in this mode. Set `extraConfig.enableServer: false` in the same patch,
then restore registration and `enableServer: true` together. Keep the maintenance taint in both patches.

## Tools and ownership

Use the merged versions of:

- [podcidr_preflight.py](../../devices/galactic/omni/podcidr_preflight.py) for read-only address and Ceph gates.
- [podcidr_patch.py](../../devices/galactic/omni/podcidr_patch.py) to render target-specific temporary Omni patches
  from a cordoned, drained node's current snapshots. It does not apply them.
- [podcidr_cleanup.py](../../devices/galactic/omni/podcidr_cleanup.py) inside the maintenance static pod. It checks
  hostname, boot ID, standalone kubelet and disabled API, exact daemon UIDs, absent pod-network owners, the old subnet,
  and bridge ownership. It archives only old host-local leases and Flannel subnet state, then removes only `cni0` and
  `flannel.1`. It never changes disks, etcd, Node objects, or Talos configuration.

The cleanup writes a mode-0600 result under `/var/lib/podcidr23-ops/<operation>/result.json`.
Physical Talos does not provide `/etc/hostname`: the helper reads the kernel hostname inside PID 1's UTS
namespace and restores its original namespace afterward. This check and the boot ID must match before any runtime
or CNI mutation. A completed operation is
idempotent. A partial operation requires explicit `--retry-failed` after diagnosing its report; changing the plan under
an existing operation is rejected. The renderer emits `retry-omni.yaml` for that exact original plan and ConfigPatch ID.
After diagnosing a failed report, apply this artifact explicitly with `omnictl apply --file
"$migration_dir/patches/retry-omni.yaml"`; do not recapture a different plan or hand-edit the command. Normal standalone
and registration artifacts never enable retries. Archives remain on the host for recovery. Do not delete broad CNI directories.

Failed-command reports retain the command, exit code or timeout, and the last 8192 characters of stdout and stderr
with truncation indicators. These diagnostics stay in the private host result file. Static-pod logs contain only the
operation, node, old CIDR, and phase. Read the result through Talos into the private operation directory before retrying.

The static pod uses host networking and PID visibility with a pinned Python image. It installs `iproute2` and
`cri-tools` into its disposable container. Confirm those packages and the image can be retrieved before maintenance.
It runs with the host DNS policy, independent of cluster DNS, and holds after writing its result.

Durable configuration belongs in the [Omni template](../../devices/galactic/omni/README.md). Temporary operational
patches use the reviewed `90-podcidr23-<node>` ConfigPatch, labeled for exactly one existing cluster machine. Apply
and remove them with Omni CLI. They retain machine membership. Do not concurrently sync another maintenance template
or mutate the same target from another operator. Never modify the join credentials or print rendered configuration.

Talos strategic merge appends unstructured arrays such as `registerWithTaints`. Reapplying the raw Talos patch to an
already patched machine duplicates the taint and prevents Node registration. Production must update the same Omni
ConfigPatch ID so Omni regenerates the full configuration from its base. Do not repeatedly apply the raw
`standalone-patch.json` or `register-patch.json` with `talosctl patch`. Verify exactly one maintenance registration
taint in the complete resulting configuration. This distinction was caught and verified in the disposable rehearsal.
See the [Talos patch semantics](https://docs.siderolabs.com/talos/v1.13/configure-your-talos-cluster/system-configuration/patching).

## Before each production drain

1. Refresh nodes, pods, controllers, PDBs, PVCs, VolumeAttachments, disk serials, OSD IDs, node labels, and local-volume
   mount identities. Record restoration commands through each owner. Keep machine UUIDs, `/var/lib/rook`, local PVs,
   and existing application data. An unchanged OSD count alone does not establish retained OSD identity.
2. Complete the availability decision above and its workload preparation. Switch replicated CNPG primaries through
   the supported procedure before eviction. Handle singletons and strict PDBs through their approved maintenance
   configuration, with exact restoration; do not disable eviction protections globally.
3. Require three healthy etcd members and use a surviving API endpoint for operator and service traffic. Preserve a
   current snapshot and verified backup. Record the target's etcd member and boot IDs. Recheck after re-registration.
4. Require Ceph HEALTH_OK, three monitors in quorum, six OSDs up/in with their original identities, clean PGs without
   recovery/backfill, and active/standby MDS on different hosts. All pools have two replicas across only Turin and
   Altra. Only one storage host may be maintained. Never begin Altra while Turin's storage is recovering.
5. Run `python3 devices/galactic/omni/podcidr_preflight.py --node <node>`. This is only the address/storage gate.
   Revalidate distinct containing `/23` blocks and prevent unrelated Node registrations during allocator maintenance.
6. Start representative request and storage probes on a surviving node. Capture successful read/write behavior before
   maintenance. Keep the CephFS probe on Altra for Turin's phase, then move it to restored Turin before Altra's phase.
7. Confirm no existing custom static pods or registerWithTaints settings conflict with the temporary patch. Confirm
   the target's ordinary services have stopped accepting new work or have failed over. Cordon and drain using eviction
   and the workload-specific procedure. `--ignore-daemonsets` leaves daemon pods for the guarded cleanup; it is not
   permission to leave ordinary pods. Preserve emptyDir data unless its owner's maintenance procedure permits loss.

## Replace one Node registration

Run from the repository root. Use a private operation directory and an operation name that has not been used before.
The following example selects Turin; Altra uses `talos-192-168-1-85` and Talos address `100.100.244.142`.

```bash
umask 077
migration_node=turin
migration_address=100.100.244.190
migration_operation=turin-podcidr23-20260906
migration_dir=/tmp/galactic-podcidr23-turin
mkdir -m 700 "$migration_dir"

kubectl --context galactic-lan -n default get node "$migration_node" -o json > "$migration_dir/node.json"
kubectl --context galactic-lan -n default get pods -A \
  --field-selector "spec.nodeName=$migration_node" -o json > "$migration_dir/pods.json"
python3 devices/galactic/omni/podcidr_patch.py \
  --node-json "$migration_dir/node.json" --pods-json "$migration_dir/pods.json" \
  --operation "$migration_operation" --output-dir "$migration_dir/patches"

omnictl apply --dry-run --file "$migration_dir/patches/standalone-omni.yaml" \
  > "$migration_dir/standalone-dry-run.log" 2>&1
```

Review the target UUID, captured boot ID and daemon UIDs, and generated patch. Validate the complete resulting Talos
configuration through the same installed-version checks used for the rehearsal. Confirm unique `machine.files` paths
and no reboot requirement. The dry-run and generated files contain operational data; keep them private.

Apply the standalone patch with `omnictl apply --file "$migration_dir/patches/standalone-omni.yaml"`. Wait for the
Talos result using the already verified production Talos config and endpoint:

```bash
talosctl --nodes "$migration_address" read \
  "/var/lib/podcidr23-ops/$migration_operation/result.json" > "$migration_dir/result.json"
```

Require `phase: complete` for this exact plan digest, node, and old CIDR. The target's kubelet API must be disabled
while standalone; static etcd and control-plane pods remain. If the report is absent, failed, or stale, stop at this
boundary and diagnose it. Do not delete a Node while any pod-network owner is running.

After successful cleanup, compare every current daemon Pod UID against `daemon-pods.json` and delete only those
old API objects. Compare the target's current Node UID against `node.json`, then delete only that Node object with
`kubectl --context galactic-lan -n default delete node "$migration_node"`. No concurrent operator may replace these
objects between the comparison and deletion. Keep the physical machine in Omni and etcd.

Apply `register-omni.yaml` through `omnictl apply`. This restores registration and the secure kubelet API together,
while retaining the maintenance taint and 250 cap. Require a new Node UID, a non-overlapping `/23`, Ready status,
original host boot ID, retained etcd membership, and the maintenance taint before permitting normal scheduling.
The exact `/23` is an allocator result, not a reservation; inspect it instead of assuming the table's parent block.

## Restore and accept the node

1. While ordinary scheduling is held, use narrowly scoped diagnostic pods to prove addresses within the new `/23`,
   DNS, Service routing, cross-node TCP/HTTP, large payloads at MTU 1400, and absence of old-subnet sandbox failures.
   Confirm old CNI owners and leases are gone. Verify retained local-volume markers and disk identities.
2. After this network gate, remove the temporary Omni ConfigPatch and release the maintenance taint/cordon through
   the recorded restoration procedure. The durable template still caps the node at 250. This permits its storage
   daemons and ordinary workloads to return. Verify the restored configuration has registration enabled and the
   kubelet API enabled, and that the maintenance static pod has disappeared.
3. Restore the stopped services through their owners. Require original OSD identities, HEALTH_OK, all PGs clean and
   no recovery/backfill; restored MDS placement; three healthy etcd members; working PVC mounts and retained writes.
   Check all restored deployment/statefulset replicas, PDBs, volume attachments, and owned node labels. No unexplained
   Pending, terminating, sandbox, or crash-loop failures are acceptable.
4. Merge a change raising only this target's durable `maxPods` to 500, render with the existing credentials, validate,
   dry-run, apply through Omni, and verify the live cap. Keep the other target at 250 until its own migration.
5. Demonstrate more than 254 simultaneous unique pod IPs on the target with bounded diagnostic pods and sufficient
   resource headroom. Count actual Ready pod IPs, verify both `/24` halves are usable, exercise cross-node traffic,
   and remove only the diagnostic workload. A 500 capacity field alone is insufficient.
6. Exercise Flamingo on Turin or Saigak on Altra with a real inference request and validate the result. Check the
   applicable Kata runtimes with real sandbox workloads and their host/runtime evidence. Run actual AMD64 or ARM64
   CI work on the corresponding node and retain the job, node, architecture, and result.
7. Run `podcidr_preflight.py --node <node> --migrated`. Verify application behavior throughout a sustained observation
   window and compare errors/latency against the pre-maintenance baseline. Finish every recovery item for Turin
   before starting Altra. Repeat the same sequence for Altra.

## Recovery

Before deleting the old Node, restoring the register patch restarts the existing registration at its old CIDR.
If cleanup has removed the bridge and leases, Flannel must recreate them before scheduling resumes. Diagnose partial
cleanup through its result and archive; never restore leases while their previous or new owners are running.

After a replacement Node receives a healthy `/23`, the preferred fallback is to retain that allocation at 250 pods
while repairing the failed acceptance condition. Keep one storage host and two control planes serving throughout.
Do not remove or reset another machine to force progress.

Returning an assigned Node to `/24` requires another drained re-registration. A controller mask rollback cannot edit
an existing Node's immutable CIDR. The `/24` allocator may select a different block, including one sharing a containing
`/23` with Ryzen. Revalidate all allocation relationships before restoring a `/23` controller mask. Never guess that
an old range is still reserved or force a conflicting Node CIDR.

## Cleanup and evidence

Record merge SHAs, applied Omni resource versions, before/after Node UIDs and CIDRs, config caps, etcd and OSD identities,
helper results, retained-data checks, application/GPU/Kata checks, and CI jobs. Keep credentials and backup contents
out of Git. Remove only this operation's temporary ConfigPatches, diagnostic pods/PVCs, and disposable rehearsal
cluster after copying its non-secret evidence. Restore any rehearsal-only kubeconfig context changes and host module
changes. Retain verified recovery archives under the existing backup policy.

Run the tool checks with:

```bash
python3 -m unittest discover -s devices/galactic/omni -p 'test_podcidr_*.py' -v
ruff check devices/galactic/omni/podcidr_*.py devices/galactic/omni/test_podcidr_*.py
ruff format --check devices/galactic/omni/podcidr_*.py devices/galactic/omni/test_podcidr_*.py
```
