# Altra NIC and CRS504 receive-path investigation

## Finding and scope

Read-only switch inspection on 2026-11-01 UTC confirmed that Altra's PAUSE frames reach the CRS504 while
receive flow control is disabled. Altra continues to discard received packets at its NIC. The switch's
transmit-drop, receive-overflow, CRC and FEC counters did not increase between the two inspected snapshots.
Disabled backpressure is a concrete configuration mismatch with the NIC's requests. Its contribution to
packet loss and application latency has not been measured through a controlled change.

Altra also has an independent PCIe training problem. It originally negotiated Gen1, now negotiates Gen2,
and repeatedly fails to establish Gen3. Neither the Ethernet switch nor a 100 Gb/s carrier establishes the
CPU-to-NIC PCIe speed. The exact physical, thermal or firmware cause remains unresolved.

The switch inspection made no configuration changes, cleared no counters and restarted nothing.
Earlier bounded PCIe tests changed the negotiated runtime link as recorded below. No NIC firmware,
platform firmware, fan profile, ring size, channel count, coalescing, Ceph scheduling or workload
concurrency change was applied. `osd_max_scrubs=3` remains the fixed constraint on all six OSDs.

## Evidence identity and access

- Cluster FSID: `5ade350d-92fe-49df-829e-37c1fbaf6c50`; context `galactic-tailscale`, namespace `rook-ceph`.
- Ceph 20.2.4, Talos 1.14.0, Linux `6.18.48-talos`; both NICs are ConnectX-5 Ex, PCI ID `15b3:1019`,
  firmware `16.35.1012`, PSID `MT_0000000013`, using `mlx5_core`.
- Switch: CRS504-4XQ revision r3, RouterOS 7.23.8 long-term, RouterBOARD firmware 7.23.8.
  The sampled control-plane CPU load was 2%; both storage bridge ports had the actual `H` hardware-offload flag.
- Management was reached through Mac USB Ethernet `en10`, `192.168.88.2/24`, to switch `ether1`,
  `192.168.88.1`. Wi-Fi and the two storage DAC connections were preserved. WebFig was inspected after
  the operator signed in. Login secrets and device serial numbers are excluded from this record.
- The switch clock reported October 28 while the acquisition host reported November 1. Use acquisition
  timestamps, not the switch's unsynchronized wall clock, for correlation. The clock was not changed.
- [PR #15542](https://github.com/proompteng/lab/pull/15542), merge
  `64a848f4b91e73070f836f5a36b4ae2bf04f79e1`, deployed the NIC telemetry through the existing host Alloy
  collector. Argo synced that revision; the live ConfigMap matched merged source and all three Alloy pods rolled out.

## Verified physical mapping

Host `storage0` and physical-port MAC addresses were read directly through existing CSI node pods and
matched against `/interface bridge host print detail without-paging`.

| Host  | Physical interface | Host MAC            | Learned switch port | Live switch comment   |
| ----- | ------------------ | ------------------- | ------------------- | --------------------- |
| Altra | `enp1s0f1np1`      | `C0:01:22:34:8C:85` | `qsfp28-2-1`        | `Turin port 1`, stale |
| Turin | `ens1f1np1`        | `C0:01:22:DC:2C:B7` | `qsfp28-1-1`        | `Altra port 1`, stale |

The retained bench script also labels the ports in reverse. Do not select a port from those comments or
reimport that configuration as a diagnostic operation. The network README and hardware plan now record
the observed mapping. No cables or live comments were changed during this inspection.

Both links negotiated 100 Gb/s, full duplex, with auto-negotiation complete and RS-FEC `fec91` active.
Both use MikroTik XQ+DA0001 1 m DACs with good EEPROM checksums. MTU is 1500, L2MTU is 1584, and port
bandwidth limits are unlimited. Both configured and effective RX/TX flow control were off.

## Switch counter comparison

The first complete terminal snapshot was read by `08:11:18.554 UTC`. The second command was submitted at
`08:14:00.619 UTC`; its first UI read completed at `08:14:01.489 UTC`. The first command executed before
its complete UI read, so these timestamps do not establish an exact sampling duration. The table contains
literal counter differences, not rates. It does not assume the NIC and switch sample boundaries coincide.

| Counter              |                Altra, switch port 2 | Turin, switch port 1 |
| -------------------- | ----------------------------------: | -------------------: |
| RX PAUSE             | 37,753,404 → 37,754,679, **+1,275** |    184 → 188, **+4** |
| RX packets           |                          +2,149,404 |           +2,924,125 |
| TX packets           |                          +2,924,212 |           +2,148,220 |
| TX PAUSE             |                               0 → 0 |                0 → 0 |
| TX dropped packets   |                               0 → 0 |                0 → 0 |
| RX overflow          |                               0 → 0 |                0 → 0 |
| RX FCS errors        |                               0 → 0 |                0 → 0 |
| RX alignment errors  |                               0 → 0 |              20 → 20 |
| RS-FEC corrected     |                       6,695 → 6,695 |            571 → 571 |
| RS-FEC uncorrected   |                             10 → 10 |              99 → 99 |
| RS-FEC symbol errors |                       6,712 → 6,712 |            251 → 251 |

The nonzero FEC and alignment totals are historical. This comparison does not establish an active cable
fault or permanently fault-free hardware. Zero switch transmit drops does not imply zero host receive loss.
The snapshot did not establish buffer occupancy peaks or capture sub-scrape traffic bursts.

RouterOS documents `rx-flow-control=on` as processing received PAUSE frames and suspending transmission
when required. The effective `no` state on Altra's port, together with advancing switch RX PAUSE counts,
confirms that requests reach a link partner with PAUSE handling disabled. It does not establish that
turning it on will eliminate all NIC discards, improve scrub throughput, or repair PCIe training.

## Fresh host telemetry

The existing non-root Alloy 1.19.2 collector now reads 18 aggregate hardware counters per storage NIC
every 30 seconds, retaining 38 series including driver metadata. GET-only native probes succeeded as
UID 473 with zero effective capabilities. Deployment acceptance verified all 36 hardware values against
native before/after bounds, fresh Mimir samples, advancing packet counters and three successful ethtool collectors.
See the [telemetry contract](../runbooks/ceph-performance-telemetry.md#storage-nic-hardware-counters).

mlx5 generic netdev drops can include stale cached PHY discards. A hardware-statistics query refreshes
that cache, producing a misleading initial jump in the generic graph. Use refreshed hardware deltas after
baseline establishment. `rx_out_of_buffer` counts events; do not add it to physical discards or PAUSE frames.

The first retained comparison used ten samples per host over 270 seconds, ending around `07:49 UTC`:

| Measurement                        |      Altra |      Turin |
| ---------------------------------- | ---------: | ---------: |
| Physical RX discards               |     11,306 |          0 |
| Receive-queue out-of-buffer events |        284 |        687 |
| TX PAUSE frames                    |      2,414 |          4 |
| Mean received traffic              | 213.6 Mb/s | 145.2 Mb/s |
| PCIe readback                      |   Gen2 ×16 |   Gen4 ×16 |
| NIC temperature readback           |       97 C |       90 C |

Altra's physical discards increased in all nine 30-second intervals, without a counter reset. CRC/symbol,
queue error and recovery counters did not increase on either host. Low mean traffic does not characterize
bursts or prove that PCIe bandwidth is the sole cause.

A later ten-sample comparison, overlapping the switch inspection, confirmed continued loss:

| Measurement                        | Altra, `08:09:42.655–08:14:12.655 UTC` | Turin, `08:09:36.174–08:14:06.174 UTC` |
| ---------------------------------- | -------------------------------------: | -------------------------------------: |
| Physical RX discards               |                                  8,087 |                                      0 |
| Receive-queue out-of-buffer events |                                  1,349 |                                    972 |
| TX PAUSE frames                    |                                  1,705 |                                      4 |
| Received PHY packets               |                              4,093,387 |                              3,050,378 |
| Received PHY bytes                 |                          5,008,786,833 |                          3,546,282,451 |
| RX CRC errors                      |                                      0 |                                      0 |

These windows overlap but are not identical to the switch snapshots. Do not require exact equality between
their PAUSE counts or derive a synthetic packet-loss total from different counters.

## PCIe tests and retained state

Ampere and ADLINK specify PCIe Gen4 support for this CPU/platform, and both NICs advertise Gen4 ×16.
Altra's inspected root port `0000:00:01.0` nevertheless advertises only Gen3 ×16 and originally targeted
Gen3 while negotiating Gen1. Turin's root port advertises Gen5 and negotiates the NIC's Gen4 ×16.

| Bounded test on November 1 UTC                           | Observed result                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `06:29:40`, retrain at existing Gen3 target              | Brief Gen3 status while training, then Gen1 after about 30 ms                               |
| `06:40:03`, align both NIC common-clock bits and retrain | Same failure; original clock settings restored                                              |
| `06:44:00`, temporarily target Gen2                      | Established Gen2 ×16 after about 10 ms                                                      |
| `06:47:03`, attempt Gen3 from Gen2                       | Brief Gen3 training, then fallback to Gen2 after about 26 ms                                |
| Test cleanup and `07:02:09` final readback               | Original root target restored to Gen3 without another retrain; negotiated link remains Gen2 |

No persistent Gen2 cap was installed. Persistence across reboot is untested. The root control remained
`0xc40`, and NIC common-clock controls were restored to `0x0`. The failed common-clock experiment does
not support that setting difference as the cause. The tests established failure to train above Gen2 on
this path, without isolating the defective component. Other Altra high-speed endpoints already negotiated Gen3.

Gen2 did not eliminate receive loss. Sampled standard AER counters were zero, which does not exclude a
link-training or electrical problem. NIC temperatures were 94–97 C during the earlier investigation, with
an undated recorded peak of 109 C. Heat remains a hypothesis. NVIDIA's warning and firmware-shutdown
thresholds are 105 C and 115 C respectively; exceeding a historical warning threshold does not prove causality.

## Remaining work and authority

The operator chose to keep the current hardware/runtime state. This inspection and documentation do not
authorize a switch configuration change, firmware flash, cold boot, fan change or workload disruption.

A scoped switch RX-flow-control experiment on the **verified Altra port 2** is now better motivated than
an unqualified firmware flash. Prepare its impact and recovery before seeking a maintenance decision.
MikroTik warns that flow-control changes can reset the switch chip on some models and interrupt ports;
do not promise a nondisruptive toggle without model/version evidence. Compare physical discards, PAUSE,
Ceph retransmissions, RBD/WAL latency and scrub progress under comparable traffic. No benefit is measured yet.

Separately, PCIe diagnosis needs pre-OS versus post-driver speed observations, controlled cooling/contact/slot
checks and vendor-supported firmware investigation. Installed ADLINK firmware is 2.04.100.11; vendor 2.10.100.02
requires a transitional procedure and its reviewed notes did not identify a specific fix for this failure.
The independent oracle also identified newer NIC and Talos/kernel maintenance candidates, without establishing
that either fixes this incident. Requalify versions, PSID, custom installer/extensions and recovery before use.

Altra maintenance affects approximately 290 active pods, database primaries and twelve matching PDBs with
zero allowed disruptions in the sampled inventory. Ceph's read-only stop assessment for its three OSDs
allowed the stop but predicted 318 degraded PGs. No drain, forced eviction, database switchover or power action occurred.

The earlier independent review measured material PostgreSQL WAL/RBD latency and HDD queueing on both hosts.
It did not quantify the NIC's contribution. Its Valkey hot-path sample showed no process disk-I/O increment;
client queuing and replication acknowledgement remained separate hypotheses. NIC repair is not proof of
application recovery. Keep shared placement, bulk concurrency, durability and max scrubs 3 unchanged.

## Reproduce the read-only observations

Use the existing management connection and an authenticated switch terminal. Submit each command separately
and wait for its prompt before submitting the next. Preserve counters and use acquisition timestamps.

```routeros
/system resource print
/system routerboard print
/system clock print
/interface bridge host print detail without-paging
/interface bridge port print detail without-paging
/interface ethernet print detail without-paging where name~"qsfp28-[12]-1"
/interface ethernet monitor qsfp28-1-1,qsfp28-2-1 once
/interface ethernet print stats-detail without-paging where name~"qsfp28-[12]-1"
```

Repeat the final statistics command after a bounded interval. Check link continuity and counter resets before
calculating deltas. Collect overlapping hardware samples from Mimir under `job="node-storage"` and retain
actual first/last sample timestamps. Use `node_ethtool_transmitted_pause_ctrl_phy` on a host against RX PAUSE
on its verified switch port. Credentials, browser session data and private switch exports do not belong in Git.

## References

- [Ampere Altra Gen4 specification](https://amperecomputing.com/products/processors)
- [ADLINK platform Gen4 lanes](https://docs.ipi.wiki/com-hpc/aadk/ModuleIntroduction.html)
- [ADLINK firmware downloads](https://www.ipi.wiki/pages/ampere-altra-developer-platform-download)
- [NVIDIA ConnectX-5 temperature monitoring](https://networking-docs.nvidia.com/connectx5enhw/monitoring)
- [Linux 6.18 mlx5 counter definitions](https://docs.kernel.org/6.18/networking/device_drivers/ethernet/mellanox/mlx5/counters.html)
- [RouterOS Ethernet counters and flow-control semantics](https://help.mikrotik.com/docs/spaces/ROS/pages/8323191/Ethernet)
- [RouterOS switch-chip reset considerations](https://manual.mikrotik.com/docs/bridging-and-switching/)
