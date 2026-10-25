# Galactic hardware and network upgrade plan

Status: The Ceph cluster-network cutover and cross-node data checks passed on 2026-10-11 UTC. The `storage0` host
interfaces, Multus, Whereabouts, and cluster-only Multus configuration are applied. Public/client traffic remains on
Flannel. Altra's NIC cooling remains unresolved. The
[ordered cutover](../network/ceph-100g-cutover.md) records the operator's explicit exception to the cooling and clean-PG
gates, the temporary override, and its removal. Receipt evidence checked 2026-10-06.

## Parts received

The September network order is complete. Gmail confirms both two-item deliveries on September 30 and the switch's
UPS delivery on October 5. The prior Amazon order check established the models and matched the switch's tracking.

| Part                                        | Quantity | Delivery     | Destination                 |
| ------------------------------------------- | -------: | ------------ | --------------------------- |
| LinksTek CX516A dual-port 100GbE QSFP28 NIC |        2 | September 30 | One each in Turin and Altra |
| MikroTik XQ+DA0001, 1 m QSFP28 DAC          |        2 | September 30 | One cable per storage host  |
| MikroTik CRS504-4XQ-IN                      |        1 | October 5    | Storage switch              |

- [ ] Inspect the packages, brackets, card labels, and cable reach. Record the exact NIC SKU and firmware PSID.
      The listing says ConnectX-5 Ex, PCIe 4.0 ×16. Verify this physically; `MCX516A-CDAT` and `MCX516A-CCAT` differ.
- [ ] Check PCIe slot width, cooling, and clearance against the GPU and NVMe carrier before opening either host.

The earlier `NIC setup` conversation also proposed an RB5009 router and management LAN `10.10.0.0/24`.
That router is not among these five items; the focused Gmail search found no purchase confirmation.
Turin's CPU, RAM, GPU, and NVMe inventory belongs to its [device README](../../turin/README.md), not this new order.

## Target network

```text
Altra NIC port 1 -- DAC -- CRS504 QSFP28 port 1
Turin NIC port 1 -- DAC -- CRS504 QSFP28 port 2
```

Use one 100G link per host. Leave the second NIC ports and two remaining switch ports unused.

- Storage subnet `10.100.0.0/24`, subject to a route-conflict check. Reserve Altra `.11`, Turin `.12`, and
  `.64` through `.239` for future Ceph pod addresses. No default gateway or DHCP on this subnet.
- CRS504 does hardware L2 switching. Connect its separate Ethernet management port to the existing management LAN.
  Save a reproducible RouterOS configuration and pin the tested firmware before production use.
- Keep current management NICs, Node IPs, API access, and Tailscale working during the storage upgrade.
  The provider's `100.100.244.128/25` overlaps Tailscale address space; do not reuse it for the storage subnet.
- Keep workloads on shared Ceph. The first target moves OSD replication, recovery, and heartbeat traffic to 100G.
  Ceph's public/client network stays on Flannel. Ryzen has no purchased 100G NIC, so its client path remains a limit.

## Installation status

- [x] Configure the switch with the [saved RouterOS script](../network/README.md). RouterOS and RouterBOARD are
      `7.23.8`; the storage bridge uses hardware offload and MTU 1500. Management remains `ether1`, `192.168.88.1/24`.
- [x] Install both cards and recover both Talos nodes. Each reports ConnectX-5 Ex, `mlx5_core`, firmware `16.35.1012`,
      PSID `MT_0000000013`, and 100,000 Mb/s carrier. Existing disks and OSD identities remain in use.
- [x] Apply the reviewed [Omni template](../omni/cluster-template.yaml), after render, validation, and dry-run.
      MAC-selected ports feed real single-port `storage0` bonds: Altra `10.100.0.11/24`, Turin `10.100.0.12/24`.
      MTU is 1500; neither has DHCP or a default gateway. Management addresses remain reachable.
- [x] Install Multus and Whereabouts on all three nodes, including the IP-allocation reconciler and macvlan binary.
      Diagnostic pod transfers over the storage subnet passed bidirectional 1 MiB checksum checks.
- [ ] Complete hardware acceptance: Altra cooling, PCIe capacity under load, switch peer-port identities and FEC
      counters, then bidirectional 60-second `iperf3` tests. Altra has reported PCIe 2.5 GT/s ×16; Turin 16 GT/s ×16.
      A 100G carrier does not establish 100 Gb/s throughput. Test MTU 9000 separately after MTU 1500 acceptance.
      Use the [NIC temperature command](../network/README.md#read-nic-temperature) to read current and peak values
      from either host before and during these checks.
- [ ] Complete full-replication, scrub, GPU/NVMe, and application acceptance. Do not interpret node readiness as all
      these checks passing. Future node maintenance follows the [storage recovery procedure](../../../docs/runbooks/galactic-storage-and-workload-recovery.md).

## Move Ceph traffic only after the migration gate

Pre-cutover baseline: Rook `v1.20.7`, Ceph `20.2.4`, default pod network, with both OSD public and cluster addresses
on `10.244.*`. That is the historical baseline, not the desired configuration or a current runtime claim.

- [x] Prepare one reviewed migration procedure for cluster-only Multus, with macvlan on the new NIC and Whereabouts
      addresses from the reserved range. Leave the public selector unset. Verify Talos CNI paths, plugin installation,
      persistent interface naming, and OSD-to-OSD connectivity before selecting the network in Rook.
- [ ] Resolve the upstream support constraint before production. Rook's [v1.20 CRD reference](https://rook.io/docs/rook/v1.20/CRDs/Cluster/ceph-cluster-crd/#network-configuration)
      warns that deployed network changes other than encryption are unsupported. Its [network-provider guide](https://rook.io/docs/rook/v1.20/CRDs/Cluster/network-providers/)
      describes careful network changes. Do not treat that guide as approval for an in-place provider conversion.
      Establish an upstream-supported route and rehearse it with the same versions, including mixed old/new pod connectivity
      and recovery. If none exists, stop at tested hardware; a data-preserving replacement needs a separate capacity and restore plan.
- [x] Merge and validate the selected GitOps changes before an authorized cutover. Preserve pools, PVCs, CRUSH placement,
      OSD IDs, and disks. No CephCluster deletion, OSD purge, or disk zap belongs to this plan.
- [x] Prove every OSD advertises a `10.100.0.*` cluster address and its existing public path still works.
      All six returned up/in with `10.244.*` public addresses. Established OSD TCP connections use the storage subnet.
      Recovery and test I/O increased both hosts' storage-interface counters, with zero reported errors or drops.
- [x] Exercise CephFS/RBD write, fsync, and readback from every node. Each node wrote an 8 MiB CephFS file; all three
      verified all three files. An 8 MiB RBD write on Altra passed checksum checks after fresh mounts on Turin and Ryzen.
- [ ] Compare latency and throughput with the same baseline workload after cooling is fixed.

The network block in `argocd/applications/rook-ceph/cluster-values.yaml` is below. The existing `connections`
settings remain configured. Runtime acceptance requires the address, traffic, and data readback checks above.

```yaml
cephClusterSpec:
  network:
    provider: multus
    selectors:
      cluster: rook-ceph/ceph-cluster-100g
    addressRanges:
      cluster:
        - 10.100.0.0/24
```

## Follow-up and recovery

- [ ] Recheck Talos and Kubernetes through the [current release procedure](../releases/README.md).
      All three live nodes already report Talos `1.14.0` and Kubernetes `1.37.0`; do not combine another OS upgrade with NIC installation.
- [ ] Handle the optional RB5009 management-LAN move in a separate window after storage acceptance and router availability.
      Prepare reservations, BMC access, etcd/kubelet subnet selectors, API certificates/LB, Omni installer registry,
      MetalLB VIPs, Pi-hole DNS, and Tailscale routes together. Retire the old lab addressing after acceptance.
- [ ] Before each change, retain the previous Omni template and switch export privately. For a hardware/link failure,
      return the affected host to its original management path and verify disks, quorum, and Ceph before resuming writes.
      The Ceph migration procedure must prove its own recovery path; reverting one network field is not a recovery plan.

Remaining: finish the unchecked acceptance items. DNS from Turin's ordinary pod network timed out during installation;
Altra and Ryzen answered the same Service DNS query. Investigate that primary-network issue separately.
Check off a step only after its stated proof passes. Keep credentials, raw email, order numbers, and tracking IDs out of Git.

Hardware references: [CRS504](https://mikrotik.com/product/crs504_4xq_in),
[DAC](https://mikrotik.com/product/xq_da0001), [NIC variants](https://networking-docs.nvidia.com/connectx5enhw).
