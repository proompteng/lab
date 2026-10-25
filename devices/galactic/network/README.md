# Prepare the CRS504 storage switch

Tested on 2026-10-10 with RouterOS `7.23.8` long-term and RouterBOARD firmware `7.23.8`.
Both versions and the configuration were verified after reboot. The script was imported twice without errors.

[crs504-bench.rsc](crs504-bench.rsc) configures the CRS504-4XQ-IN on a direct Mac Ethernet connection.
It preserves `192.168.88.1/24` on `ether1` and removes management from the storage bridge.

| Port                   | Intended connection | Configuration                |
| ---------------------- | ------------------- | ---------------------------- |
| `ether1`               | Mac USB Ethernet    | Management `192.168.88.1/24` |
| QSFP28 1, `qsfp28-1-1` | Altra NIC port 1    | 100G DAC, RS-FEC, MTU 1500   |
| QSFP28 2, `qsfp28-2-1` | Turin NIC port 1    | 100G DAC, RS-FEC, MTU 1500   |
| QSFP28 3 and 4         | Unused              | Disabled                     |

1. Connect the Mac to `ether1`. Set its Ethernet adapter to `192.168.88.2/24`, with no router.
2. Sign in at `http://192.168.88.1/`. Set the admin password yourself. Keep credentials out of Git.
3. Save `/export file=flash/before-bench` privately. Enable WebFig **Safe Mode**.
4. Upload the script through **Files**. Run `/file set [find where name="crs504-bench.rsc"] name="flash/crs504-bench.rsc"` so it survives reboot.
5. Run `/import file-name=flash/crs504-bench.rsc verbose=yes` in Terminal.
6. Verify `/ip address print detail` shows `actual-interface=ether1` and both storage bridge ports show `H`.
7. Verify management still responds from the Mac, then turn off **Safe Mode** to retain the changes.

The script requires one existing bridge and the factory management address. It can be reapplied to its own resulting state.
It disables IP forwarding and unused services, limits management services to the bench subnet, and restricts MAC WinBox
and discovery to `ether1`. Keep every lane of QSFP ports 1 and 2 enabled; whole 100G links use all four lanes.

Keep this direct connection until a separate management-LAN change is prepared. Moving `ether1` to the provider LAN
requires new addressing and service allowlists. Restore the Mac adapter to DHCP when bench work finishes.
No host IPs or Ceph networks change through this script. Follow the [hardware upgrade plan](../docs/hardware-network-upgrade-plan.md)
for host installation, link tests, and the Ceph migration gate.

## Install the tested firmware

The tested package is [routeros-7.23.8-mipsbe.npk](https://download.mikrotik.com/routeros/7.23.8/routeros-7.23.8-mipsbe.npk).
Its SHA-256 is `69b044a3b6c9ee65232d3f3232e6a97ac0b5c012098c681b05174c34d5704ff3`.
The bench connection has no gateway, so use the manual package upload rather than an online update.

1. Retain a private configuration export. Download the official package and check it with `shasum -a 256 <file>`.
2. Upload the package to the switch's root through **Files**. Keep **Safe Mode** off before restarting.
3. Run `/system reboot`. Reconnect and verify `/system resource print` reports `version: 7.23.8`.
4. Run `/system routerboard print`. If `current-firmware` differs from `upgrade-firmware`, run `/system routerboard upgrade`, confirm, and reboot again.
5. Verify both firmware fields report `7.23.8`. Repeat the configuration checks below.

Follow the [MikroTik manual upgrade procedure](https://help.mikrotik.com/docs/spaces/ROS/pages/328142/Upgrading%2Band%2Binstallation)
when selecting a newer version. Update this pin only after testing it.

## Verify the saved configuration

Run these commands in the switch Terminal after reboot:

```routeros
/system resource print
/system routerboard print
/interface bridge print detail without-paging
/interface bridge port print without-paging
/interface ethernet print detail without-paging
/ip address print detail without-paging
/ip service print without-paging
/interface ethernet monitor qsfp28-1-1,qsfp28-2-1 once
/interface ethernet print stats without-paging where name~"qsfp28-[12]-1"
/export file=flash/crs504-config
```

Require one `storage` bridge at MTU 1500, exactly two bridge ports with `H`, and management on `ether1`.
Ports 1 and 2 use `100G-baseCR4` and `fec91`. Ports 3 and 4 are disabled. Confirm management access from the Mac.
Keep raw exports and credentials private; the script resolves the switch's own MAC address at import time.

On 2026-10-10, both firmware versions and all these settings survived reboot. Port 1 reported `100Gbps` with `fec91`;
port 2 had no carrier. The port comments record the intended host mapping, not a verified peer identity.
Port 1 recorded 332 corrected FEC errors, one uncorrected error, and two symbol errors after reboot.
These counters stayed unchanged across two samples with almost no traffic. Recheck them under host traffic before acceptance.
Complete the plan's host identification, error-counter and throughput tests before accepting the storage network.
The switch clock was unsynchronized on the bench. Configure NTP when management routing is available.

## Configure the storage interfaces

The [Omni cluster template](../omni/cluster-template.yaml) owns both storage addresses.
Each host's dedicated `30-<machine-uuid>-storage-network` patch selects its connected physical port by permanent MAC
as Talos alias `storage-port`, then creates a single-port active-backup bond named `storage0`.
This creates the same real Linux interface name on both hosts, as required by macvlan CNI. A Talos alias alone does
not rename the physical interface. One member provides a stable name, not link redundancy, and requires no LACP
configuration on the switch.

| Host  | Physical port MAC   | Current kernel name | Storage address  |
| ----- | ------------------- | ------------------- | ---------------- |
| Altra | `c0:01:22:34:8c:85` | `enp1s0f1np1`       | `10.100.0.11/24` |
| Turin | `c0:01:22:dc:2c:b7` | `ens1f1np1`         | `10.100.0.12/24` |

Both bonds use MTU 1500, connected-route metric 1024, and 100 ms carrier monitoring, with no DHCP or gateway.
Management addressing, Node IPs, and etcd subnet selection remain separate. Configuration references:
[LinkAliasConfig](https://docs.siderolabs.com/talos/v1.14/reference/configuration/network/linkaliasconfig) and
[BondConfig](https://docs.siderolabs.com/talos/v1.14/reference/configuration/network/bondconfig).

The installed card reports Mellanox ConnectX-5 Ex, PCI ID `15b3:1019`, driver `mlx5_core`,
and firmware `16.35.1012`, PSID `MT_0000000013`. After Altra's slot move, both hosts' connected ports are at
PCI `0000:01:00.1`; the other ports have no carrier. Readback on 2026-10-10 confirmed 100,000 Mb/s on both hosts.
Altra subsequently exceeded the 105 C NIC warning threshold. Carrier alone does not establish cooling or traffic
acceptance. Resolve cooling before sustained throughput tests. The [cutover procedure](ceph-100g-cutover.md) records
the operator's explicit exception for this installation; it is not a normal maintenance prerequisite waiver.

1. Export fresh live credentials privately, then render and validate the template using the [Omni workflow](../omni/README.md).
2. Inspect `omnictl cluster template sync --file <rendered-template> --dry-run --verbose`.
   The initial rollout updates only Altra's dedicated storage patch and creates Turin's. A repeat rollout must have no changes.
3. Sync the reviewed, merged template through Omni. This is a network configuration update, with no installer or reboot.
4. Verify the address and route through the existing management endpoint:

```bash
talosctl --context ryzen --endpoints 100.100.244.141 --nodes 100.100.244.142,100.100.244.190 get links storage0 -o yaml
talosctl --context ryzen --endpoints 100.100.244.141 --nodes 100.100.244.142,100.100.244.190 get addresses -o yaml
talosctl --context ryzen --endpoints 100.100.244.141 --nodes 100.100.244.142,100.100.244.190 get routes -o yaml
kubectl --context galactic-lan -n kube-system get nodes talos-192-168-1-85 turin -o wide
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph status
```

Require each storage address and the `10.100.0.0/24` route on its `storage0` bond,
no storage default route or DHCP lease, and both existing management endpoints still reachable.
Compare node readiness, etcd quorum, OSD identities, and PG availability with the pre-change sample.
These addresses alone do not move Ceph traffic. Install [Multus and Whereabouts](../../../argocd/applications/multus/README.md),
then complete bidirectional throughput testing, switch error-counter acceptance, and the
[Ceph migration gate](../docs/hardware-network-upgrade-plan.md#move-ceph-traffic-only-after-the-migration-gate).

To undo this interface setup, remove only its dedicated patch from the template, merge, render, and sync through Omni.
Verify that the storage address and route disappear and management remains reachable. Delete private exports and renders after use.

## Route application traffic over 100G

The [pod routing procedure](pod-100g-routing.md) moves Altra and Turin's pod and Ceph client traffic through
`storage0`. Ryzen keeps its existing Flannel path over the LAN. The Omni template owns the native routes and narrow
return-path rules. Run the committed topology check before syncing, then verify routes and actual I/O afterward.

For neighbor-table overflow and intermittent DNS, follow the [neighbor-cache recovery checks](neighbor-cache.md).
The committed verifier checks the live limits and new overflow events on every host.

## Read NIC temperature

Read the NIC's Linux `hwmon` sensor through the existing RBD CSI node pod. This requires cluster access and Python 3
in the `csi-rbdplugin` container, without a BMC login or a new diagnostic pod. Select Altra below, or set `node=turin`.
The command finds the current pod and follows the physical member of `storage0`, so pod names, PCI slots, and
`hwmon` numbers are not hard-coded.

```bash
node=talos-192-168-1-85
pod=$(kubectl --context galactic-lan -n rook-ceph get pods \
	-l app=rook-ceph.rbd.csi.ceph.com-nodeplugin \
	--field-selector "spec.nodeName=$node,status.phase=Running" \
	-o jsonpath='{.items[0].metadata.name}')
kubectl --context galactic-lan -n rook-ceph exec -i "${pod:?No running RBD CSI node pod on selected node}" \
	-c csi-rbdplugin -- python3 - "$node" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

members = Path("/sys/class/net/storage0/bonding/slaves").read_text().split()
if len(members) != 1:
    raise SystemExit("UNKNOWN: expected one physical member of storage0")
device = (Path("/sys/class/net") / members[0] / "device").resolve(strict=True)
sensors = list(device.glob("hwmon/hwmon*/temp1_input"))
if len(sensors) != 1:
    raise SystemExit("UNKNOWN: expected one NIC temperature sensor")
sensor = sensors[0].parent
values = {
    name: int((sensor / name).read_text().strip()) / 1000
    for name in ("temp1_input", "temp1_highest", "temp1_crit")
}
print(json.dumps({
    "node": sys.argv[1],
    "sampled_at_utc": datetime.now(timezone.utc).isoformat(),
    "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    "pci": device.name,
    "celsius": values,
}, indent=2))
PY
```

The sysfs files contain millidegrees Celsius; the command converts them to degrees Celsius. `temp1_input` is the
current NIC temperature, `temp1_highest` is the device's recorded peak, and `temp1_crit` is the driver-exposed limit.
Compare fresh samples and boot IDs. A peak is not the current reading. Missing files, a failed exec, or an unreadable
sensor mean **UNKNOWN**, not zero or evidence that the card cooled down.

The installed cards expose `temp1_crit` as 105 C. This differs from the firmware shutdown threshold:
[NVIDIA specifies](https://networking-docs.nvidia.com/connectx5enhw/monitoring) a 105 C warning, 115 C firmware
shutdown, and 130 C emergency hardware shutdown. Use the NIC sensor for card temperature; CPU or BMC chassis
temperature does not substitute for it.
