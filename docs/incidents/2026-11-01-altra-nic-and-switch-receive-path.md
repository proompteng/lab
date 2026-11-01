# Altra NIC and CRS504 receive-path investigation

## Finding and scope

Read-only switch inspection on 2026-11-01 UTC confirmed that Altra's PAUSE frames reach the CRS504 while
receive flow control is disabled. Altra continues to discard received packets at its NIC. The switch's
transmit-drop, receive-overflow, CRC and FEC counters did not increase between the two inspected snapshots.
Disabled backpressure is a concrete configuration mismatch with the NIC's requests. The subsequently
authorized single-setting trial enabled effective RX PAUSE handling but did not establish a loss or
client-latency benefit. It was rolled back. The workload changed during observation, limiting causal claims.

Altra also has an independent PCIe training problem. It originally negotiated Gen1, now negotiates Gen2,
and repeatedly fails to establish Gen3. Neither the Ethernet switch nor a 100 Gb/s carrier establishes the
CPU-to-NIC PCIe speed. The exact physical, thermal or firmware cause remains unresolved.

The initial switch inspection made no configuration changes, cleared no counters and restarted nothing.
The operator subsequently authorized the bounded RX-flow-control trial recorded below.
Earlier bounded PCIe tests changed the negotiated runtime link as recorded below. No NIC firmware,
platform firmware, fan profile, ring size, channel count, coalescing, Ceph scheduling or workload
concurrency change was applied. `osd_max_scrubs=3` remains the fixed constraint on all six OSDs.

## Evidence identity and access

- Cluster FSID: `5ade350d-92fe-49df-829e-37c1fbaf6c50`; context `galactic-tailscale`, namespace `rook-ceph`.
- Pre-upgrade samples used Ceph 20.2.4, Talos 1.14.0 and Linux `6.18.48-talos`; both NICs are ConnectX-5 Ex, PCI ID `15b3:1019`,
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

The retained bench script originally labeled the ports in reverse. The trial change corrects its host labels;
the live comments remain stale. Select ports by learned host MAC, and do not reimport the complete bench
configuration as a diagnostic operation. No cables or live comments were changed.

Both links negotiated 100 Gb/s, full duplex, with auto-negotiation complete and RS-FEC `fec91` active.
Both use MikroTik XQ+DA0001 1 m DACs with good EEPROM checksums. MTU is 1500, L2MTU is 1584, and port
bandwidth limits are unlimited. Before the trial, both configured and effective RX/TX flow control were off.

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

Gen2 did not eliminate receive loss. An earlier pre-test AER read was zero; later timed parent-port samples
show advancing corrected receiver errors, BadTLP indications and endpoint replay timeouts. Do not generalize
the earlier zero read or NIC endpoint counters to the entire PCIe path. NIC temperatures were 94–97 C during the earlier investigation, with
an undated recorded peak of 109 C. Heat remains a hypothesis. NVIDIA's warning and firmware-shutdown
thresholds are 105 C and 115 C respectively; exceeding a historical warning threshold does not prove causality.

## Authorized RX-flow-control trial

The operator authorized this experiment after receiving the warning that flow-control changes can interrupt
switch ports. The learned MAC mapping and both original RX/TX settings were rechecked before execution.
Only `qsfp28-2-1` RX flow control changed. No counters were cleared and the complete bench script was not imported.

```routeros
/interface ethernet set qsfp28-2-1 rx-flow-control=on
/interface ethernet monitor qsfp28-2-1 once
```

The enable command was submitted at `08:40:50.089 UTC` and returned by `08:40:51.071 UTC`.
The first monitor showed Altra's port temporarily at `no-link`, while Turin's port remained `link-ok`.
A subsequent read confirmed Altra at `100Gbps`, full duplex, `fec91`, effective RX flow control `yes`
and TX `no`. Both bridge ports retained actual `H` hardware offload. These observations bound recovery;
they do not measure the precise interruption duration or rule out a shorter interruption on Turin.

The comparison uses actual first/last counter samples, without extrapolating `increase()` counts:

| Measurement                                     |        Immediately before |                RX enabled |              Restored off |
| ----------------------------------------------- | ------------------------: | ------------------------: | ------------------------: |
| Altra NIC sample window, UTC                    | 08:35:42.655–08:40:12.655 | 08:41:42.655–08:46:12.655 | 08:47:12.655–08:51:42.655 |
| Altra physical RX discards, 270 s               |                    19,113 |                    29,586 |                    32,543 |
| Altra received PHY packets                      |                 6,490,210 |                14,145,590 |                14,353,987 |
| Altra received PHY bytes                        |             8,596,984,920 |            19,715,666,086 |            20,010,845,785 |
| Altra discards per million received PHY packets |                     2,945 |                     2,092 |                     2,267 |
| Altra receive out-of-buffer events              |                     1,218 |                     1,617 |                     4,285 |
| Altra transmitted PAUSE frames                  |                     3,475 |                     8,104 |                     8,035 |
| Turin physical RX discards                      |                        51 |                        15 |                       127 |
| Primary WAL mean fsync, operations              |             332.9 ms, 118 |             487.7 ms, 119 |             392.6 ms, 121 |
| Standby WAL mean fsync, operations              |             213.0 ms, 136 |              318.7 ms, 90 |              343.6 ms, 99 |
| Primary RBD mean write time                     |                  420.5 ms |                  471.5 ms |                  765.4 ms |
| Standby RBD mean write time                     |                  317.4 ms |                  461.1 ms |                  711.4 ms |
| Weighted OSD mean write time                    |                  300.0 ms |                  467.8 ms |                  638.1 ms |
| Summed OSD write input bytes                    |             8,680,439,463 |            17,752,598,408 |            17,613,380,881 |

Before/enabled NIC, RBD and OSD comparisons span 270 actual seconds, with exporter-specific boundaries.
Restored Altra NIC/RBD and both OSD windows also span 270 s. Restored Turin NIC/RBD spans
`08:47:36.174–08:51:36.174` (240 s, nine samples). WAL boundaries
are `08:35:32.188–08:40:27.188` and `08:41:32.188–08:46:27.188` for the primary (295 s each),
and `08:35:33.799–08:40:28.799` (295 s) and `08:41:33.799–08:46:23.799` (290 s) for the standby.
Restored WAL windows are `08:47:12.188–08:52:07.188` and `08:47:13.799–08:52:08.799` (295 s each).
WAL means sum synchronization-time deltas across WAL backend classes and divide by their operation-count
deltas. These are counter means, not transaction percentiles. RBD identity was reverified from the PVC/PV
image and native mapping: primary `bayn-db-2` on Turin `rbd3`, standby `bayn-db-1` on Altra `rbd24`.

Two earlier pre-change 270-second windows recorded 8,645 and 9,545 Altra discards, or 1,847 and 2,094
per million received PHY packets. The enabled window's normalized discard count falls within that baseline
variation. Received traffic and OSD write bytes more than doubled relative to the immediate baseline.
The experiment therefore neither isolates a flow-control latency penalty nor proves a throughput gain.
Persistent loss and the absence of demonstrated client improvement did not justify retaining the change.
The restored window also retained substantial loss and showed mixed latency changes: primary WAL improved,
while standby WAL, RBD and OSD means worsened. This reversal does not prove flow control is ineffective
or harmful; a stronger claim requires repeated comparisons with representative, comparable traffic.
Ceph-specific TCP retransmissions were not captured in this trial, so no retransmission improvement is claimed.

Switch transmit drops, receive overflow, FCS and alignment counts remained unchanged through the inspected
enabled snapshots. Altra's switch FEC totals increased across enable/renegotiation from 6,695/10/6,712 to
17,992/14/18,004 corrected/uncorrected/symbol errors. They then stayed unchanged between subsequent
snapshots while traffic advanced. This does not establish an ongoing FEC fault or attribute every increment
to link training. After rollback, Altra's totals read 39,217/15/39,224 and stayed unchanged across two
post-rollback snapshots with advancing traffic and zero switch drops/overflows. Turin's FEC totals
stayed at 571/99/251.

At `08:46:44.040–08:46:45.161 UTC`, the trial restored the original setting:

```routeros
/interface ethernet set qsfp28-2-1 rx-flow-control=off
/interface ethernet monitor qsfp28-2-1 once
```

Effective readback confirmed `link-ok`, `100Gbps`, `fec91`, RX `no`, TX `no`. All six OSDs remained up/in,
all 601 PGs remained active/clean, and monitor quorum stayed `i,o,p`. Bayn retained the same primary and
two ready instances. `fsync`, `full_page_writes` and `synchronous_commit` remained `on`, with
`ANY 1 ("bayn-db-1")`, a streaming quorum standby and zero unflushed bytes at the SQL check.
All six OSDs read back `osd_max_scrubs=3`. No placement, bulk concurrency or durability setting changed.

The `08:52:51 UTC` cluster check retained 15 deep and three shallow scrubs, 23 overdue deep scrubs
and the existing retained daemon-crash warning. No PG scrub-completion timestamp advanced between the
`08:42:56` and final PG snapshots. This bounded interval does not establish a stalled scrub or a throughput
change. A native trial read still showed Altra PCIe Gen2 ×16 at 97 C, versus Turin Gen4 ×16 at 88 C.

## Post-upgrade verification

The [Talos 1.14.5 rollout](../../devices/galactic/releases/talos-v1.14.5-acceptance.md) completed on all three
nodes. This read-only check on November 1 confirmed Linux `6.18.58-talos` and unchanged NIC firmware
`16.35.1012`. It used the existing Mimir tenant and CSI node Pods, without reconnecting switch management,
clearing counters, retraining links or changing settings. Native hardware probes ran as UID 473 with zero
effective capabilities. Twenty Mimir hardware values fell within their corresponding native before/after bounds.
The comparison windows had advancing counters, no counter resets and no scrape gaps of 90 seconds or more.

These are actual first/last counter deltas from nominal 15-minute queries. Times below are UTC. Altra windows
span 870 seconds each; the latest Turin window spans 840 seconds. Discards per million use received PHY packets
as their denominator. Out-of-buffer events remain a separate measure.

| Altra sample window       | Discards per million received packets | Physical discards | Mean RX traffic | Out-of-buffer events/s |
| ------------------------- | ------------------------------------: | ----------------: | --------------: | ---------------------: |
| Before, 08:25:42–08:40:12 |                                 2,398 |            40,559 |      194.8 Mb/s |                   2.54 |
| Before, 09:30:12–09:44:42 |                                 2,252 |            89,162 |      497.4 Mb/s |                  15.90 |
| After, 14:15:12–14:29:42  |                                 1,074 |            14,095 |      141.8 Mb/s |                   1.28 |
| After, 16:45:12–16:59:42  |                                   660 |             7,740 |      126.7 Mb/s |                   1.16 |
| After, 19:52:12–20:06:42  |                                   991 |            12,060 |      128.2 Mb/s |                   1.52 |

The latest Turin window recorded 68 discards, or 4.29 per million received packets, at 194.7 Mb/s.
Altra's normalized loss was lower in all three selected post-upgrade windows, but remained substantial.
Traffic, bursts, database roles and other workload activity changed, so this observation does not isolate a
kernel-fix effect or establish repaired receive behavior.

Native samples from 20:05:44 to 20:07:39 confirmed continued loss and PCIe errors. Altra added 3,428 physical
discards over 3,268,200 received packets in 115.33 seconds, or 1,049 discards per million. Its root port
`0000:00:01.0` added 1,081,037 corrected `RxErr`, 2,378 `BadTLP`, five `BadDLLP` and one timeout. The NIC endpoint
added 42 corrected timeouts. Fatal and nonfatal AER counters did not increase. PCIe corrected errors and
Ethernet discards have different units and must not be added or treated as a corruption count.

Altra still negotiated Gen2 ×16, with its inspected root port advertising Gen3; the NIC advertises Gen4.
Turin still negotiated Gen4 ×16, and its NIC endpoint AER counters remained zero. Turin's upstream port did
not expose the same AER files, so endpoint zeros do not prove its entire PCIe path error-free. Sampled NIC
temperatures were 97 C on Altra and 89 C on Turin. The upgrade did not repair Altra's PCIe training/error problem.

The latest operation-weighted OSD mean write latency was 279 ms on Altra and 297 ms on Turin. These are
counter means, not p95/p99 or database transaction latency. Altra's `sda` averaged a queue depth of 48 and
90% busy time in the same window. All 601 PGs were clean, six OSDs were up/in and three monitors were in quorum.
Ceph still warned about two OSDs with BlueStore slow operations, 19 overdue deep scrubs and one recent crash.
All six effective `osd_max_scrubs` values remained 3, with `high_client_ops`, recovery concurrency and backfill
concurrency unchanged.

Bayn's primary was now `bayn-db-1` on Altra, with `bayn-db-2` a Turin standby. Its WAL fsync counters and the
verified current RBD devices did not advance during the latest window, so no current WAL/RBD latency mean
can be calculated. Native SQL corroborated the WAL counters; `fsync` and `synchronous_commit` remained on,
with `wal_buffers=16MB`. This does not prove a database-latency improvement. Both Bayn Valkey exporters were
up without scrape errors, and the replica's master link was up. Those availability metrics do not measure
command or persistence latency.

The remaining network investigation is the NIC/riser/slot/root-port path. Lower sampled receive loss does not
justify declaring the incident fixed, changing scrub concurrency or attributing client latency to one component.

## Independent post-upgrade review

A fresh [Oracle consultation](https://chatgpt.com/c/6ae7b768-e7f8-83e8-9346-6bed72bd3346) reviewed raw paired
measurements and reported reading all five requested files at commit
`d62b2e5dbc675371d618cfa59f8444d0ac1b0a63`. The request contained measurements, fixed constraints and competing
explanations without a preferred diagnosis or action ranking. Preflight showed GPT-6, Pro at 5 of 5, and a Pro
composer. The completed response's regeneration menu explicitly identified `6 Pro`. The review did not inspect
the live hosts, switch or BMC and did not execute an intervention.

Its first recommendation is to identify the exact carrier revision, connector, riser if present, and controller
behind parent `0000:00:01.0`. DMI's `ES2` value does not establish the physical A1/A2 carrier revision.
[ADLINK requires physical board identification before firmware selection](https://docs.ipi.wiki/com-hpc/aadk/firmware_A1vsA2.html).
Once the path's supported speed and bifurcation are established, the preferred discriminator is an Altra-only
test of the existing NIC through a verified compatible alternative path, if one is free. Keep firmware and
runtime tuning unchanged for that test, and keep Turin online. If there is no safe alternative path, obtain
board-specific vendor guidance or a qualified comparison device.

Independent checks confirmed that [installed ADLINK 2.04.100.11](https://github.com/ADLINK/edk2_aadp/releases/tag/v2.04.100.11)
already documents setting a Gen3 default instead of an unset speed after bifurcation changes, for active
controllers. That change cannot be presented as a new benefit of a later flash. It may explain a configured
Gen3 ceiling, but does not establish why this link negotiates Gen2 with advancing errors. NVIDIA's documented
lane-skew and masked-AER fixes similarly predate the installed NIC firmware. The 16.35.8008 security-maintenance
benefit remains separate from a proven PCIe repair.

The Oracle could not retrieve and inspect either candidate firmware archive. Its board/image applicability
assessment is therefore incomplete; it did not validate either flash as the first repair action. A new-version
number or DMI label does not close that gap.

Success for a future path test requires the expected negotiated speed and width after warm-up, stable outside
training, with no new relevant AER errors over representative busy windows. Measure physical discards and
out-of-buffer events separately, and assess client/storage latency separately. These are proposed experiment
criteria, not vendor guarantees or observed repair results. Evidence of a clean expected-speed link before
host-driver initialization that reproducibly degrades only when the driver starts would reverse the review's
hardware-path-first direction. No physical move, flash, retrain, cooling change or new privilege was applied.

## Remaining work and authority

The operator chose to preserve the hardware/runtime state, then explicitly authorized the single-port
RX-flow-control trial after receiving the switch-chip reset warning. That authorization does not cover
a firmware flash, cold boot, fan change, workload migration or concurrency reduction.

MikroTik warns that flow-control changes can reset the switch chip on some models and interrupt ports.
The trial therefore includes effective-link readback, Ceph and database continuity, switch drop counters,
and hardware-loss and latency comparisons. PCIe maintenance remains a separate decision.

Separately, PCIe diagnosis needs pre-OS versus post-driver speed observations, controlled cooling/contact/slot
checks and vendor-supported firmware investigation. Installed ADLINK firmware is 2.04.100.11; vendor 2.10.100.02
requires a transitional procedure and its reviewed notes did not identify a specific fix for this failure.
The independent oracle also identified newer NIC and Talos/kernel maintenance candidates, without establishing
that either fixes this incident. Talos 1.14.5 is now installed with the observations above; NIC firmware maintenance
still requires qualification of the exact PSID and recovery procedure.

Altra maintenance affects approximately 290 active pods, database primaries and twelve matching PDBs with
zero allowed disruptions in the sampled inventory. Ceph's read-only stop assessment for its three OSDs
allowed the stop but predicted 318 degraded PGs. No drain, forced eviction, database switchover or power action
occurred during the switch trial or this post-upgrade metrics check. The separately authorized Talos maintenance
is recorded in the rollout link above.

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
