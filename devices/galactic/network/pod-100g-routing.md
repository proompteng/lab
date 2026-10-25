# Route Altra and Turin pod traffic over 100G

The [Omni template](../omni/cluster-template.yaml) owns this configuration. The two existing storage patches add
native routes between Altra and Turin. Ryzen has no connection to the CRS504 and continues to use Flannel over the LAN.

| Node                         | Node address      | PodCIDR         | Storage address |
| ---------------------------- | ----------------- | --------------- | --------------- |
| Altra, `talos-192-168-1-85`  | `100.100.244.142` | `10.244.4.0/23` | `10.100.0.11`   |
| Turin, `turin`               | `100.100.244.190` | `10.244.0.0/23` | `10.100.0.12`   |
| Ryzen, `talos-192-168-1-194` | `100.100.244.141` | `10.244.3.0/24` | None            |

Each storage bond routes the peer's two `/24` pod blocks through the peer's storage address. These prefixes take
precedence over Flannel's `/23` routes. Ordinary pod traffic, cross-node Service endpoints, and Ceph public traffic
between Altra and Turin use this path. Same-node traffic stays local. Ryzen traffic uses the existing LAN.

Both native pod routes specify the host's existing Flannel `/32` as their preferred source. Altra uses `10.244.4.0`;
Turin uses `10.244.0.0`. Unbound host clients must retain these addresses when the outbound interface changes to
`storage0`. Selecting `10.100.0.11` or `.12` for Ceph public requests caused fresh CSI mounts to stall during rollout.
The storage subnet also exists on each OSD's secondary interface. Keeping public client sources in the pod subnet
preserves the public reply path. This source setting does not rewrite forwarded application packets.

Policy rule `5000` matches the local PodCIDR as source and only the peer's node `/32` as destination. It selects table
`100`, whose sole route uses `storage0`. This carries replies to existing kernel Ceph clients that retain their old
node source address. Host-originated management, etcd, and Flannel VXLAN packets retain their LAN route. Pod IPs,
Service IPs, Ceph public endpoints, and MTUs do not change. Ceph's separate Multus cluster network remains in place.

The PodCIDRs are fixed inputs. Before node re-registration or address changes, update these routes, policy rules,
and the verifier together. A NIC failure can blackhole this pair's traffic until the routes are removed. The
underlying Flannel routes provide a recovery path after removal, not automatic failover.

## Apply the reviewed configuration

1. Check the [NIC sensors](README.md#read-nic-temperature), carrier, and Ceph health. Require 100,000 Mb/s on both
   ports and no new errors. Normal maintenance requires adequate cooling and full replication. The operator's
   [existing thermal exception](ceph-100g-cutover.md) does not establish safe cooling or benchmark acceptance.
2. Run the topology gate from the repository root. A failure blocks the sync.

   ```bash
   python3 devices/galactic/network/verify-pod-routing.py --preflight
   ```

3. Merge the configuration and use that exact commit. Follow the [private Omni render workflow](../omni/README.md).
   Validate both complete resulting Talos configurations for `metal` mode and dry-run a `no-reboot` apply.
   Inspect the Omni sync dry run. It must update only the two `30-<machine-uuid>-storage-network` patches.
   It must not change Ryzen, installers, extensions, node addresses, or Flannel's advertised endpoints.
4. Sync the merged template through Omni. No reboot, drain, OSD rollout, or new application attachment is required.
5. Run the route verifier. Exit `0` requires all 60 host and forwarded-pod lookups to use the expected interfaces,
   gateways, and unbound host source addresses. It also requires the storage addresses to belong only to the bonds,
   with no IPv4 address left on a bond member. Exit `1` means a failed check. Exit `2` means evidence is unavailable.

   ```bash
   python3 devices/galactic/network/verify-pod-routing.py
   ```

6. Exercise ordinary pod connections in both directions on every node pair and DNS through the Kubernetes Service.
   Use the temporary probes below. Also exercise a cross-node application Service and existing RBD and CephFS mounts
   with write, fsync, and checksum readback. Confirm TCP packets for both directions use `storage0` on Altra and Turin.
   Route lookups and increasing aggregate counters alone do not prove the application or kernel-client path.
7. Recheck node readiness, monitor quorum, all six OSD IDs up/in, PG availability, link errors, and NIC sensors.
   Remove all probes and private exports. Repeat the Omni dry run and require no changes.

## Check ordinary pod connectivity

These temporary pods use the deployed CSI image's Python interpreter. They have no host networking, volumes, or
service-account token. Each Service selects one node's probe. Run with access to `galactic-lan`.

```bash
for node in talos-192-168-1-85 turin talos-192-168-1-194; do
	kubectl --context galactic-lan -n rook-ceph run "pod-routing-probe-$node" \
		--image=quay.io/cephcsi/cephcsi:v3.17.1 \
		--labels="lab-network-probe=pod-routing,lab-network-probe-node=$node" \
		--restart=Never \
		--overrides="{\"spec\":{\"nodeName\":\"$node\",\"automountServiceAccountToken\":false}}" \
		--command -- python3 -m http.server 8080 --directory /tmp
done
kubectl --context galactic-lan -n rook-ceph wait pod -l lab-network-probe=pod-routing --for=condition=Ready --timeout=120s
for node in talos-192-168-1-85 turin talos-192-168-1-194; do
	kubectl --context galactic-lan -n rook-ceph expose pod "pod-routing-probe-$node" \
		--port=8080 --target-port=8080 --selector="lab-network-probe-node=$node" --labels=lab-network-probe=pod-routing
done
targets=$(kubectl --context galactic-lan -n rook-ceph get pods -l lab-network-probe=pod-routing -o jsonpath='{.items[*].status.podIP}')
for node in talos-192-168-1-85 turin talos-192-168-1-194; do
	kubectl --context galactic-lan -n rook-ceph exec -i "pod-routing-probe-$node" -- python3 - "$targets" <<'PY'
import socket
import sys
import urllib.request

print("DNS", socket.getaddrinfo("kubernetes.default.svc.cluster.local", 443)[0][4][0])
for address in sys.argv[1].split():
    with urllib.request.urlopen(f"http://{address}:8080/", timeout=10) as response:
        assert response.status == 200
        print("HTTP", address, response.status)
for node in ("talos-192-168-1-85", "turin", "talos-192-168-1-194"):
    with urllib.request.urlopen(f"http://pod-routing-probe-{node}.rook-ceph.svc.cluster.local.:8080/", timeout=10) as response:
        assert response.status == 200
        print("Service", node, response.status)
PY
done
kubectl --context galactic-lan -n rook-ceph delete pod,service -l lab-network-probe=pod-routing
```

If a check fails, retain the failure evidence, then delete the probes before investigating. Missing telemetry is
unknown. These small requests establish connectivity, not 100G throughput or storage latency improvement.

## Recover a stale address on a bond member

A live conversion from a physical interface to `storage0` can leave the old address and connected route in the
kernel even though Talos's `AddressSpecs` assigns the address only to the bond. The duplicate connected route can
send replies through the enslaved physical interface. Host clients using a remote Service endpoint are affected:
kube-proxy masquerades those connections to the storage address, while direct pod connections can still work.

Compare `talosctl -n <node-address> get addressspecs -o yaml` with `ip -j address show dev storage0` and
`ip -j address show master storage0` from that node's existing Flannel pod. Check both host and forwarded-pod routes
to the peer's storage address. Require the physical interface to be a member of `storage0`, the same address to be
present on the bond, and no desired `AddressSpec` for that address on the member before removing a stale address.
Do not remove the bond address or change the management interface.

For the verified Altra incident on 2026-10-12 UTC, the bounded repair was:

```sh
kubectl --context galactic-lan -n kube-system exec <altra-flannel-pod> -c kube-flannel -- \
  ip address del 10.100.0.11/24 dev enp1s0f1np1
```

No persistent configuration changed: Omni already assigns `10.100.0.11/24` solely to `storage0`. Require the peer
storage route to select `storage0`, the full route verifier to pass, and host-network requests to a remote Service
endpoint to succeed by both literal Service IP and DNS name. Then verify fresh `node-storage` samples for every
node, remote-write recovery, and Ceph quorum/data health. The incident changed Turin's Mimir Service requests from
connection timeouts to HTTP 200 while preserving the 100G pod routes. The verifier now rejects the stale member
address and checks the previously uncovered masqueraded-Service reply routes.

## Recover stalled CSI operations

If an earlier route selected a storage source and left a CSI operation stuck, correct the preferred source and require
a successful verifier exit first. Before restarting a CephFS plugin, identify every PVC consumer on the affected node. For Altra:

```bash
kubectl --context galactic-lan -n rook-ceph get pods --all-namespaces \
	--field-selector spec.nodeName=talos-192-168-1-85 -o json \
	| jq -r '.items[] | .metadata as $pod | .spec.volumes[]? | select(.persistentVolumeClaim) | [$pod.namespace, $pod.name, .persistentVolumeClaim.claimName] | @tsv'
```

Resolve each claim's PV and mounter, and inspect the actual filesystem type in its workload as described in the
[CephFS runbook](../../../docs/runbooks/cephfs-fuse-on-talos.md#validation). Include `rook-cephfs-fuse` claims and any
PV or mounted filesystem using FUSE. Deleting the plugin kills its `ceph-fuse` processes; existing FUSE mounts then
fail with `Transport endpoint is not connected`. If FUSE consumers exist, arrange their maintenance window and
recovery before deleting the plugin. Recover the affected node-local FUSE mounts and recreate every affected
workload afterward; require I/O on each existing claim, not just a new mount canary. Do not delete data-bearing PVCs.

After that preflight, restart only the affected node's CSI plugin to release its old connections and
volume-operation lock. For Altra's CephFS driver:

```bash
kubectl --context galactic-lan -n rook-ceph delete pod \
	-l app=rook-ceph.cephfs.csi.ceph.com-nodeplugin --field-selector spec.nodeName=talos-192-168-1-85
```

For RBD, select `app=rook-ceph.rbd.csi.ceph.com-nodeplugin` instead. Require the replacement on that node to become
Ready and a fresh volume mount to pass I/O. Existing kernel mounts remain mounted. This needs no node reboot.

## Recover the LAN path

Through the existing management endpoint, remove only the three added `routes` entries and the `RoutingRuleConfig`
document from each storage patch in Git. Merge, render, validate, inspect, and sync through Omni. Retain the bonds,
addresses, Multus, and Ceph cluster-network configuration. Do not remove the entire storage patch.

Require peer pod routes to resolve through `flannel.1` and pod-to-peer-host routes through the LAN again. Repeat the
connectivity and storage checks. Removing these routes does not return Ceph replication to the LAN; that has its
own [recovery procedure](ceph-100g-cutover.md#recovery).

## Cutover acceptance, 2026-10-11 UTC

The configurations from [#14931](https://github.com/proompteng/lab/pull/14931) and
[#14933](https://github.com/proompteng/lab/pull/14933) were applied through Omni. All 52 lookups passed. A repeat sync
dry run reported zero changes. Both host boot IDs stayed unchanged. Packet captures confirmed bidirectional native
pod traffic and existing Ceph client traffic on both `storage0` interfaces, with no added link errors or drops.

Fresh CephFS mounts on all three nodes passed 8 MiB writes, fsyncs, and checksums of every node's file. RBD passed
an 8 MiB write and fsync on Altra, then checksum readback on fresh Turin and Ryzen mounts. Restarting Altra's CephFS
plugin cleared the operation stalled by the earlier source-address error. Three nodes were Ready, three monitors
held quorum, and all six OSDs were up/in with 601 active PGs.

The final pod, DNS, and Service matrix passed on all three nodes. Intermittent Turin client DNS failures also
occurred before and after the route change and remain unresolved. Scrub debt, the previous RGW crash warning,
cooling stability, and peak-bandwidth acceptance remain separate work.

Schema references are Talos v1.14 [BondConfig](https://docs.siderolabs.com/talos/v1.14/reference/configuration/network/bondconfig)
and the pinned [RoutingRuleConfig implementation](https://github.com/siderolabs/talos/blob/v1.14.0/pkg/machinery/config/types/network/routing_rule.go).
