# Turin /22 PodCIDR upgrade

**Status: plan only.** This change does not alter Galactic's live or desired configuration. Rehearse both directions
on the installed Talos, Kubernetes, and Flannel versions, then obtain approval for a Turin-only maintenance window.
The [previous /23 migration](galactic-turin-podcidr-23-migration-plan.md) rehearsed the same Node replacement mechanism
on older versions; it did not prove this cutover.

## Exact allocation plan

Keep the cluster Pod network at `10.244.0.0/16`. The starting values below come from the
[100G route contract](../../devices/galactic/network/pod-100g-routing.md) and
[Omni template](../../devices/galactic/omni/cluster-template.yaml), not a fresh live readback.

| Node                          | Starting PodCIDR | Block occupied under a /22 allocator after cutover | Expected final PodCIDR | maxPods (start → maintenance → final) |
| ----------------------------- | ---------------- | -------------------------------------------------- | ---------------------- | ------------------------------------- |
| Turin (`turin`)               | `10.244.0.0/23`  | `10.244.8.0/22`                                    | `10.244.8.0/22`        | 500 → 250 → 1000                      |
| Altra (`talos-192-168-1-85`)  | `10.244.4.0/23`  | `10.244.4.0/22`                                    | `10.244.4.0/23`        | 500, unchanged                        |
| Ryzen (`talos-192-168-1-194`) | `10.244.3.0/24`  | `10.244.0.0/22`                                    | `10.244.3.0/24`        | 500, unchanged                        |

A `/22` has 1,024 addresses, 1,022 after excluding the network and broadcast addresses, and up to **1,021 pod
IPs** after the Flannel bridge gateway at `10.244.8.1` is reserved. `maxPods: 1000` counts all pods on Turin,
including system and host-network pods. It does not guarantee 1,000 application pods or 150–300 concurrent AgentRuns.
Ryzen's existing cap exceeds its CNI address capacity; this plan does not change it.

In Kubernetes's [RangeAllocator](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/controller/nodeipam/ipam/range_allocator.go),
a fresh leader loads the existing assignments. Its [CIDR bitmap](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/controller/nodeipam/ipam/cidrset/cidr_set.go)
marks every allocator block that intersects an assignment and does not track a separate owner per bit. Turin's old
`/23` and Ryzen's `/24` are disjoint, but both intersect `10.244.0.0/22`. **Delete Turin's old Node while all controller
managers still use `/23`.** Switching to `/22` first and then deleting Turin can release Ryzen's occupied block.
With only Altra and Ryzen present and no intervening registration, a fresh `/22` allocator skips their two blocks
and selects `10.244.8.0/22` for Turin. This is an expected result, not a reservation. Any difference stops cutover.

The allocator flag is cluster-wide. Leave it at `/22` after success so new registrations receive `/22` blocks; existing
Node assignments do not resize. Future Node replacements must recheck allocations and their route/policy consumers
before scheduling. Do not patch an assigned Node's immutable `spec.podCIDR` or `spec.podCIDRs`.

## Preflight and preparation

1. Use the verified [Galactic access path](galactic-kubernetes-access.md) through Ryzen. Verify the Omni account and
   cluster `galactic`, Turin machine `8bf7ec00-171c-11f1-8000-7cc255f16774`, and the LAN Talos addresses in the
   [cluster inventory](../../devices/galactic/README.md). Do not infer IPs from Node names. Record the exact baseline:

   ```bash
   set -o pipefail
   umask 077
   operation="turin-podcidr22-$(date -u +%Y%m%d-%H%M%S)"
   op_dir="$(mktemp -d)"
   turin_ip=100.100.244.190

   kubectl --context galactic-lan -n default auth whoami
   kubectl --context galactic-lan -n default get --raw='/readyz?verbose'
   kubectl --context galactic-lan -n default get nodes \
     -o 'custom-columns=NAME:.metadata.name,UID:.metadata.uid,CIDRS:.spec.podCIDRs,BOOT:.status.nodeInfo.bootID,CAP:.status.capacity.pods,ALLOCATABLE:.status.allocatable.pods'
   talosctl --nodes 100.100.244.141 etcd members
   talosctl --nodes 100.100.244.141,100.100.244.142,100.100.244.190 etcd status
   talosctl --nodes 100.100.244.141 etcd snapshot "$op_dir/etcd-before.db"
   python3 devices/galactic/network/verify-pod-routing.py --preflight
   ```

   Require the exact starting rows, three healthy etcd members, and a healthy API through Ryzen. Verify snapshot
   integrity, an encrypted Omni backup, and application-volume recovery separately. Record Turin's boot ID, etcd
   member ID, system disk and local volume identities, Ceph OSD IDs, and required Node labels. Keep private artifacts
   mode `0600` in the private directory. Never print raw templates, machine configs, or backup contents.

2. Freeze concurrent Node lifecycle, Omni syncs, and unrelated rollouts for the window. Pause new AgentRuns and CI
   placements through their owners and let in-flight work finish. Inventory singletons, PDBs, node-pinned services,
   local PVs, mounts, and volume attachments; agree on availability, restore actions, and an abort time. Require
   surviving storage and workload probes and the [storage prerequisites](galactic-turin-podcidr-23-migration-plan.md#before-each-production-drain).
3. Prepare reviewed config changes for each phase and their reversal. Before drain, use the
   [secret-safe Omni render, validate, dry-run, and sync workflow](../../devices/galactic/omni/README.md) to lower
   **only Turin** to 250 pods, after active workload count has been reduced below that cap. Keep the allocator at
   `23`. Require both capacity and allocatable to read `250` on the same Node UID, then run:

   ```bash
   python3 devices/galactic/omni/podcidr_preflight.py --node turin --allocator-prefix 23
   ```

   Exit `1` is a failed gate; `2` is unavailable evidence. A peer-cap warning does not excuse any new failure.
   Prove three monitors in quorum, all six original OSDs up/in, clean PGs, and separate active/standby CephFS MDS hosts.

4. While the old Node and network are still healthy, stage the
   [Flannel/LAN fallback](../../devices/galactic/network/pod-100g-routing.md#recover-the-lan-path). Remove only the
   native peer Pod routes, table-100 peer Node route and rule `5000` from each storage patch through reviewed Omni
   configuration. Leave bonds, addresses, Ceph replication and MTU unchanged. Prove the LAN path with bidirectional
   Pod and Service traffic and RBD/CephFS I/O before relying on it.
5. Review other consumers of the old subnet. The CNPG status NetworkPolicies and their tests for
   [Buzz](../../argocd/applications/buzz/networkpolicy.yaml) and [Bayn](../../argocd/applications/bayn/networkpolicy.yaml)
   pin Turin's VTEP/gateway pair `10.244.0.0/31`. With the owners' approval, stage `10.244.8.0/31` alongside it for
   this window and remove the old entry after acceptance. Do not widen it to the whole `/22`. Confirm the cluster CIDR
   and the Flannel backend/MTU are unchanged. Rehearse both allocator switches, cleanup, route/NetworkPolicy changes,
   and rollback against matching versions and these three starting CIDRs before the production drain.

## Drain and cut over

1. Cordon and drain only Turin with the Eviction API. If a PDB, unmanaged pod, local data, or pending termination
   blocks the drain, stop and use that workload's approved procedure. Do not force the drain or discard local data
   by default. After drain, take fresh snapshots and render the target-only patch:

   ```bash
   kubectl --context galactic-lan -n default cordon turin
   kubectl --context galactic-lan -n default drain turin --ignore-daemonsets --timeout=15m
   kubectl --context galactic-lan -n default get node turin -o json > "$op_dir/node.json"
   kubectl --context galactic-lan -n default get pods -A \
     --field-selector spec.nodeName=turin -o json > "$op_dir/pods.json"
   python3 devices/galactic/omni/podcidr_patch.py --node-json "$op_dir/node.json" \
     --pods-json "$op_dir/pods.json" --operation "$operation" --output-dir "$op_dir/patches"
   omnictl apply --dry-run --file "$op_dir/patches/standalone-omni.yaml" > "$op_dir/standalone-dry-run.log" 2>&1
   ```

   Review only the generated ConfigPatch `90-podcidr23-turin`. The renderer requires a Ready, cordoned target at
   250 pods with no ordinary pods, and does not assign the next CIDR. Confirm image/package availability for the
   static pod. Validate complete resulting Talos configurations for `metal` and verify no reboot is needed with
   server-side `talosctl apply-config --mode=no-reboot --dry-run`. Do not apply the raw Talos patch.

2. Apply the standalone artifact with `omnictl apply --file "$op_dir/patches/standalone-omni.yaml"`. Verify the kubelet
   is standalone with its API disabled, the control plane/etcd still serve, and the guarded cleanup completed:

   ```bash
   talosctl --nodes "$turin_ip" read "/var/lib/podcidr23-ops/$operation/result.json" > "$op_dir/result.json"
   ```

   Require `phase: complete`, node `turin`, old CIDR `10.244.0.0/23`, and a `planDigest` matching the exact
   `plan.json` (SHA-256 of Python's `json.dumps(plan, sort_keys=True).encode()`). The cleanup retains
   only the old CNI state in its private archive and refuses to remove an owned bridge. For any failed or missing
   result, stop; use the [diagnostic and same-plan retry procedure](galactic-turin-podcidr-23-migration-plan.md#tools-and-ownership).

3. Use the controller-manager check below to capture the live process IDs and confirm all three still use `/23`.
   Compare current API daemon UIDs to `daemon-pods.json` and delete only the matching old daemon objects. Compare
   Turin's Node UID to `node.json`, then delete only that Kubernetes Node:

   ```bash
   kubectl --context galactic-lan -n default delete node turin --timeout=60s
   kubectl --context galactic-lan -n default get nodes
   ```

   Require Turin absent and the same two peer UIDs and CIDRs. Do not remove Turin from Omni, reset Talos, reboot,
   change etcd membership, or touch either peer's Node registration.

4. Apply the reviewed allocator change to the **existing** cluster ConfigPatch ID `20-galactic-podcidr-23`. In
   `cluster-template.yaml` its inline `cluster.controllerManager.extraArgs.node-cidr-mask-size-ipv4` changes
   from `"23"` to `"22"`. Save the live `/23` ConfigPatch privately and prepare `allocator-22.yaml` as a single
   ConfigPatch with the same namespace, type, ID and cluster labels and the reviewed inline patch as `spec.data`:

   ```bash
   omnictl get configpatches.omni.sidero.dev 20-galactic-podcidr-23 -o yaml > "$op_dir/allocator-23.yaml"
   ```

   Validate the complete configs for all three hosts. Dry-run `omnictl apply --dry-run --file "$op_dir/allocator-22.yaml"`
   with output kept private and require only this ConfigPatch's change. Apply it with
   `omnictl apply --file "$op_dir/allocator-22.yaml"`.
   **Do not sync a full template while the standalone patch is active**: Omni
   [prunes omitted ConfigPatches](https://github.com/siderolabs/omni/blob/v1.11.0/client/pkg/template/template.go),
   which could re-enable registration before allocator convergence.

5. Still with Turin absent, verify the running controller-manager processes on **all three** hosts through the
   Talos API, not a stale Kubernetes mirror pod. Check that each has a new PID and that the controller-manager
   Lease identifies one of those converged instances. Print only the required fields:

   ```bash
   for address in 100.100.244.141 100.100.244.142 100.100.244.190; do
     talosctl --nodes "$address" processes | awk '
       /(^|[ \/])kube-controller-manager[[:space:]]/ {
         printf "%s pid=%s", $1, $2
         for (i = 3; i <= NF; i++)
           if ($i ~ /^--(node-cidr-mask-size(-ipv4)?|cluster-cidr|allocate-node-cidrs|cidr-allocator-type)(=|$)/)
             printf " %s", $i
         print ""
       }'
   done
   kubectl --context galactic-lan -n kube-system get lease kube-controller-manager \
     -o 'jsonpath={.spec.holderIdentity}{" "}{.spec.renewTime}{"\n"}'
   ```

   Require exactly one running manager per node, each with `--node-cidr-mask-size-ipv4=22` and no unsuffixed mask flag.
   The cluster CIDR remains `10.244.0.0/16`, and allocation remains enabled with `RangeAllocator` (the default
   if unspecified). Require API readiness, etcd quorum, and no controller errors. If any instance still runs
   with `/23` or evidence is incomplete, do not register Turin.

6. Dry-run and apply `"$op_dir/patches/register-omni.yaml"` through `omnictl apply`, updating the same ID to
   re-enable registration and the authenticated kubelet API together. The temporary 250 cap and
   `maintenance.proompteng.ai/podcidr=true:NoSchedule` taint must remain. Repeat the baseline Node inventory and
   require Ready status, a new Turin Node UID, the original boot ID, unchanged peers and exactly the final CIDRs
   in the table. Do not infer the assignment from the flag. If it differs or overlaps, keep scheduling blocked
   and use rollback; do not rewrite it in place.

## Verify and raise capacity

1. Keep ordinary scheduling blocked while proving Flannel and the CNI. Read Turin's `/run/flannel/subnet.env` via
   Talos: expect `FLANNEL_SUBNET=10.244.8.1/22` and `FLANNEL_MTU=1400`. Verify `cni0` has the new gateway,
   Flannel's VTEP has `10.244.8.0/32`, and no old-subnet routes or leases are left on Turin. Use narrowly
   scoped probes to check unique Pod IPs, DNS, Service routing and cross-node traffic on all three nodes, including
   288 KiB payloads at the existing MTU. Restore required labels before checking placement.
2. Restore [native 100G routing](../../devices/galactic/network/pod-100g-routing.md) from reviewed changes after
   the exact assignment and new VTEP source are visible. Update the fixed topology in
   [the verifier and its tests](../../devices/galactic/network/verify-pod-routing.py) together with the routes:

   | Host  | Route destination(s)                                                 | Gateway       | Preferred source |
   | ----- | -------------------------------------------------------------------- | ------------- | ---------------- |
   | Altra | `10.244.8.0/24`, `10.244.9.0/24`, `10.244.10.0/24`, `10.244.11.0/24` | `10.100.0.12` | `10.244.4.0`     |
   | Turin | `10.244.4.0/24`, `10.244.5.0/24`                                     | `10.100.0.11` | `10.244.8.0`     |

   Restore both table-100 peer Node `/32` routes and rules with the original gateways. Turin's rule `5000` now
   matches `src 10.244.8.0/22`, `dst 100.100.244.142/32`; Altra's rule is unchanged. Leave Ryzen on Flannel.
   Run the updated route verifier's `--preflight` before applying these changes and the full route check after.
   Cover all four Turin `/24`s and confirm real bidirectional traffic uses `storage0`. Use a scoped
   `omnictl apply` dry-run and apply of just the two reviewed storage patches while the register patch is active.

3. After network acceptance, run `omnictl delete configpatches.omni.sidero.dev 90-podcidr23-turin` and release the
   taint/cordon in the [recorded restoration order](galactic-turin-podcidr-23-migration-plan.md#restore-and-accept-the-node).
   Confirm the static pod disappeared and registration/API remain enabled. Keep the durable cap at 250 and new
   agent intake paused while storage and workloads recover. Verify three healthy original etcd members,
   HEALTH_OK Ceph with the six original OSDs, clean PGs and separated MDS, retained local data, existing and new
   RBD/CephFS I/O, restored replicas/attachments, and no sandbox errors. Verify CNPG status through the changed
   path and the node's existing GPU, Kata, and CI workloads. Run the address/storage gate at the maintenance cap:

   ```bash
   python3 devices/galactic/omni/podcidr_preflight.py --node turin --allocator-prefix 22
   ```

4. Only now merge the Turin-only `maxPods: 1000` setting and apply the reviewed Omni template. Read back both
   Node capacity and allocatable `pods=1000`, confirm the updated template no longer needs an operational patch,
   and run:

   ```bash
   python3 devices/galactic/omni/podcidr_preflight.py --node turin --migrated --allocator-prefix 22
   ```

5. Within the agreed resource budget, demonstrate more than 509 simultaneous Ready non-host-network pods on Turin
   with unique IPs in the new block and working cross-node traffic. Then restore agent intake in stages and exercise
   actual [AgentRuns](../agents/agentrun-creation-guide.md) at 150 and then 300 concurrent runs. Record successful
   completions and artifacts, queue/scheduling latency, live pod counts/IPs, CPU, memory, storage and network errors.
   Stop increasing load on pressure, sandbox/IPAM errors, or regressions; an advertised cap or a synthetic pod
   count alone is not agent-capacity proof. Remove only operation-owned probes and the old CNPG allowlist entry after
   acceptance. Retain non-secret evidence and private recovery archives; delete exported credentials and configs.

## Rollback

- **Before the old Node is deleted:** keep the `/23` allocator and the original Node. Apply the matching
  `register-omni.yaml` to exit standalone with the maintenance taint and 250 cap. If cleanup removed CNI state,
  prove Flannel recreated the old subnet, leases and routes before scheduling. Never copy archived leases back
  over active state.
- **Old Node deleted, Turin still absent:** hold Turin standalone. If the mask was changed, apply the saved
  `/23` ConfigPatch through the same scoped Omni dry-run/apply and verify all controller managers and the leader
  are converged on `/23` before registration. A fresh allocator with only the two unchanged peers should choose
  `10.244.0.0/23`; an allocator that never restarted need not choose it. Confirm the actual CIDR before restoring
  old routes or releasing the scheduling hold.
- **Replacement has a non-overlapping /22:** if networking is healthy, keeping it at 250 while
  repairing acceptance is safer than another drain. Reduce intake and return Turin to 250 through Omni if it was
  raised. To restore `/23`, re-enable the verified LAN fallback, stage the old CNPG allowlist entry, then repeat
  the drain and guarded cleanup with a **new** operation ID, current boot/daemon snapshots and the observed
  `/22` as `oldCIDR`. Delete only the drained Turin Node while still at `/22`. Restore and verify the allocator
  at `/23` with Turin absent, then re-register. Changing the mask alone cannot shrink a Node's assignment.

In every case, restore the old 100G routes, verifier and CIDR allowlists only after reading back the exact original
allocation. If the allocator assigns an unexpected CIDR, keep scheduling blocked and reconcile before retrying.
Do not delete under a mask that makes two live Nodes share an allocator block. Stop for reviewed recovery if the
observed state does not match a rollback case or quorum/cleanup evidence is lost. Do not guess at routes,
force-reassign a CIDR, re-register a peer, or reset a machine. Repeat the network, storage, retained-data and
workload checks at 250 before restoring `500` and running the `--migrated --allocator-prefix 23` gate.
