# Torghut and Ceph Write-Pressure Remediation Rollout

Last updated: **2026-07-15 02:30 UTC**

Status: **software containment live; staged activation gated on a clean storage-stability observation**

Design: `docs/torghut/storage-write-pressure-remediation-design.md`

## Executive outcome

The application-side write amplification identified in the accepted design has been removed or contained:

- options subscription reconciliation is delta-only and live discovery is bounded;
- Hyperliquid and Options TA ClickHouse writes are batched per destination table;
- archival reconciliation uses bounded, restartable finalization and avoids unchanged catalog rewrites;
- the Kafka-backed ClickHouse writer and retained-record parity gate are merged, but the writer remains at zero replicas;
- PostgreSQL WAL buffers are 16 MiB with durability settings unchanged;
- Ceph scrub concurrency is one per OSD; and
- Kafka remains on the in-place Strimzi 1.1.0 / Kafka 4.3.0 cluster with metadata `4.3-IV0`.

The remaining storage alert is not an application timeout problem. Talos and Ceph record one real cache-flush I/O error
on the Altra storage host followed by an OSD.3 crash. The same log stream contains SCSI device-reset/recovery messages,
but current evidence does **not** prove failed hardware, a bad cable/backplane, an HBA reset, or raw storage saturation.
The archive worker and Kafka staging writer therefore remain off only until the understood stale incident state is
cleared and the executable clean-observation gate below passes.

There is no third Ceph storage host in this plan. The incoming network hardware remains a separate change window.

## Delivered slices

| Capability                                       | Pull requests                          | Live state                                              |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------- |
| Accepted production design                       | #12403                                 | Merged                                                  |
| Delta-only options subscription reconciliation   | #12407                                 | Merged and live                                         |
| Bounded live discovery                           | #12421, #12432                         | Merged and live                                         |
| Set-based options catalog persistence            | #12435, #12437                         | Merged and live                                         |
| Resumable archive and bounded finalization       | #12438, #12439, #12441, #12449, #12452 | Merged; deployment held at zero                         |
| Low-WAL archive finalization and overlap fencing | #12493, #12497, #12500, #12502         | Merged and live; schema-gated image promoted            |
| Hyperliquid per-table ClickHouse batching        | #12409, #12410                         | Merged and live                                         |
| Options TA ClickHouse batching                   | #12455, #12495, #12501                 | Merged and live                                         |
| Kafka-backed ClickHouse writer                   | #12440                                 | Source and staging resources merged; deployment at zero |
| Retained-record parity gate                      | #12472                                 | Merged; CronJob intentionally suspended                 |
| Shared storage observability                     | #12443                                 | Merged and live                                         |
| Ceph one-scrub-per-OSD limit                     | #12453                                 | Merged and live                                         |
| Torghut PostgreSQL WAL buffers                   | #12457                                 | Merged and live                                         |
| Suspended parity health handling                 | #12498                                 | Merged and live                                         |

## Live application proof

### Options reconciliation and PostgreSQL

The original discovery path generated approximately 53,397 physical subscription-state updates in 15.8 seconds and
36.34 MiB of WAL, or about 2.29 MiB/s. The replacement path:

- preserves the last completed hot/warm set during partial scans;
- mutates only materially changed assignments;
- performs explicit displacement instead of a blanket `tier = 'off'` update;
- bounds live discovery separately from the 730-day archive; and
- finalizes archive shards in restartable batches of no more than 1,000 rows.

The live Torghut PostgreSQL cluster is healthy with one ready instance. Readback shows:

| Setting                        | Live value             |
| ------------------------------ | ---------------------- |
| `wal_buffers`                  | 2,048 x 8 KiB = 16 MiB |
| `fsync`                        | `on`                   |
| `full_page_writes`             | `on`                   |
| `synchronous_commit`           | `on`                   |
| `max_wal_size`                 | 1 GiB                  |
| `checkpoint_timeout`           | 5 minutes              |
| `checkpoint_completion_target` | 0.9                    |
| `wal_compression`              | `off`                  |

With the archive worker off, a 30-second live sample at 23:55 UTC generated **0.0100 MiB/s** of WAL, below the accepted
0.25 MiB/s gate. Checkpoint-size and WAL-compression changes remain evidence-driven follow-up tuning; durability is not
weakened.

### Hyperliquid ClickHouse batching

The feed remained ready during rollout. Representative full-hour ClickHouse `system.part_log` samples showed:

| Table/event             |                              Before |                           After | Result              |
| ----------------------- | ----------------------------------: | ------------------------------: | ------------------- |
| BBO `NewPart`           | 2,089-2,296/hour; median 36-40 rows | 111-168/hour; median 1,000 rows | 92-95% fewer parts  |
| BBO `MergeParts`        |                    1,340-1,525/hour |                      24-36/hour | 97-98% fewer merges |
| Candles `NewPart`       |         828-882/hour; median 2 rows |   43-63/hour; median 62-67 rows | 92-95% fewer parts  |
| Candles `MergeParts`    |                        828-882/hour |                      12-26/hour | 97-99% fewer merges |
| Asset context `NewPart` |         337-362/hour; median 2 rows |   43-56/hour; median 27-29 rows | 83-88% fewer parts  |

The high-rate BBO table reaches the 1,000-row size trigger. Sparse tables are age-triggered and are evaluated separately.

### Options TA ClickHouse batching

Before batching, a 15-minute sample across `options_contract_bars_1s`, `options_contract_features`, and
`options_surface_features` created 5,359 new parts at only 19-43 rows per part. The live sink now has:

- one writer per destination table;
- a 1,000-row size threshold;
- a 30-second maximum age; and
- Flink restart nonce 33.

The batching change first reconciled at commit `2551ef69cd01c2cd10244fc4e13d14a4be8b1973`; all four Torghut Argo
applications are now `Synced/Healthy` at descendant promotion `bf26c61adb399687353c8f972249d4f00904a2f4`. Flink
generation 43 is observed at generation 43, and job `0089f4f0d810bef590a70e77966fe475` is `STABLE`, `READY`,
and `RUNNING`.

The adjacent live path remained healthy: the Hyperliquid feed `/readyz` returned `ready=true`, `websocket=true`,
`kafka=true`, and `clickhouse=true`; Knative revision `torghut-01462` was ready.

The fixed 15-minute window from 23:54:04 through 00:09:04 UTC produced:

| Table                       | Replica 0 `NewPart` / median rows | Replica 1 `NewPart` / median rows | Combined `MergeParts` |
| --------------------------- | --------------------------------: | --------------------------------: | --------------------: |
| `options_contract_bars_1s`  |                           8 / 113 |                            4 / 60 |                     7 |
| `options_contract_features` |                           6 / 108 |                           6 / 115 |                     5 |
| `options_surface_features`  |                            7 / 44 |                            5 / 66 |                     3 |

That is 36 `NewPart` events across both replicas, **99.3% fewer** than the original 5,359-event 15-minute sample.
The intermediate five-second configuration produced 40 `NewPart` events in five minutes, or 8.0/minute; the final
30-second configuration produced 2.4/minute, a further **70% rate reduction**. This after-hours window is
age-triggered, so rows per part are intentionally below the 1,000-row size threshold.

Flink completed 16 of 16 checkpoints with zero failures; the latest acknowledged all 31 subtasks in 932 ms. The job
manager and both task managers were ready with zero restarts.

### Archive and Kafka staging containment

The database is at Alembic revision `0067_options_archive_status`. The shared init gate verifies the required archive
membership table, status table, active-catalog view, and ready composite index before any archive/catalog/enricher
process can start. The gate image is digest-identical to the application image.

The archive deployment is declaratively at **zero replicas**; there is no temporary Argo deny window and no live drift.
Catalog and enricher are ready on digest
`sha256:dad1156a0e92e551052997de77cd2da733aaf1bb06f3ff59e821d79fe9fc2dbb`.

The Kafka writer deployment is also at **zero replicas**. Nine `_kafka_staging` tables exist and contain zero rows.
The direct sink remains authoritative. Activation PR #12496 is intentionally draft and cannot merge until the storage
stability gate passes.

## Storage incident diagnosis

### Evidence

Ceph is `HEALTH_WARN` with six of six OSDs up and in and all placement groups clean or actively scrubbing. The warnings
are:

- OSD.5 BlueStore slow-operation indications; and
- a recent OSD.3 crash at `2026-07-14T20:18:05Z`.

The OSD.3 crash path is `KernelDevice::flush()` -> `bstore_kv_sync` -> `fdatasync`, ending in Linux error 5
(`EIO`). Talos recorded immediately beforehand:

```text
sd 0:0:0:0: [sda] CDB: Synchronize Cache(10)
I/O error, dev sda, sector 0 op WRITE
```

Talos also recorded power-on/device-reset events for `sda`, `sdb`, and `sdc` at 20:12 UTC, followed by additional
`sda` and `sdc` reset/recovery messages around the OSD.3 crash. Similar device messages occurred on July 12. Linux
SCSI error handling can emit these records while recovering an individual device command; they are evidence of a
recovery event, not proof that the controller or physical path failed.

The affected topology is:

| SAS path           | Linux disk | Ceph OSD | Disk serial |
| ------------------ | ---------- | -------- | ----------- |
| phy 0:1 / port 0:0 | `sda`      | OSD.3    | `ZXA12R7C`  |
| phy 0:6 / port 0:1 | `sdb`      | OSD.4    | `ZXA0LKW9`  |
| phy 0:7 / port 0:2 | `sdc`      | OSD.5    | `ZXA0HS7E`  |

All three disks report SMART passed with zero reallocated, pending, offline-uncorrectable, and interface-CRC sectors.
The SAS3008 reports `ioc_reset_count=0`, state `running`, firmware `16.00.14.00`, BIOS `08.37.00.00`, and MPI `205.32`.
No `mpt3sas` controller fault/reset, PCIe AER event, disk medium error, or SMART media/CRC failure was found. Historical
metrics around the event showed roughly 2.05 MiB/s and 126 write operations/s on the affected node, with Ceph commit and
apply latency around 32-68 ms, so raw bandwidth/IOPS saturation is also not proven.

The defensible diagnosis is therefore one transient SCSI error-recovery event in which `Synchronize Cache(10)` returned
an I/O error and BlueStore correctly aborted OSD.3 rather than claiming durability. The initiating cause is unproven.
This is not fixed by increasing Kafka timeouts, but current evidence also does not justify a physical repair requirement.

### Controlled stability validation

No shutdown, cable replacement, backplane work, firmware change, or extended SMART test is required by the current
evidence. Before increasing write load:

1. Preserve the OSD.3 crash dump, Talos event lines, Ceph status, OSD tree, SMART data, HBA state, and historical
   storage/application metrics as the incident record.
2. Acknowledge only the already-investigated OSD.3 crash so `RECENT_CRASH` no longer masks new crashes. Do not silence
   or suppress future crash/slow-op alerts.
3. Require any remaining BlueStore slow-operation warning to clear through normal recovery; if it persists, inspect
   the current OSD.5 operation queue before changing configuration.
4. Record an observation start while the archive worker and Kafka staging writer remain at zero replicas.
5. After at least 30 minutes, run the executable read-only gate below. Any new SCSI reset/recovery, cache-flush EIO, OSD
   crash, Kafka fencing/timeout, unsafe placement group, durability regression, or runtime readiness failure restarts
   containment and investigation.
6. If the baseline passes, activate exactly one bounded writer at a time and retain the same stop conditions during
   staged load. The archive and Kafka-writer steps below are the controlled durable-write validation.

Clearing the understood stale crash record is incident bookkeeping, not proof of repair. Passing requires fresh
observation evidence and current healthy state.

### Executable storage-stability gate

Record a timestamp while both contained writers are still off, wait at least 30 minutes, and run:

```bash
bun run gate:torghut-storage-stability \
  --observation-start 2026-07-15T11:00:00Z \
  --output json
```

Replace the example timestamp with the actual clean-observation start. The command is read-only and samples PostgreSQL WAL
for 30 seconds. It exits non-zero unless all of the following are simultaneously true:

- the clean window is at least 30 minutes and retained Talos dmesg plus Kafka controller logs cover it;
- Talos contains no new SCSI device-reset/recovery, `mpt3sas` fault/reset, `Synchronize Cache`, or I/O-error signature;
- Ceph is `HEALTH_OK`, all six OSDs are up and in, every placement group is clean, and no crash is unacknowledged;
- all three expected SAS serials report current SMART overall health passed and zero
  reallocated/pending/offline-uncorrectable/interface-CRC counters;
- Kafka remains converged on Strimzi 1.1.0 / Kafka 4.3.0 / metadata `4.3-IV0`, with three ready controllers, three
  ready brokers, all topics ready, complete controller-log coverage, no KRaft request timeout or broker fencing, and no
  controller event above two seconds; its direct quorum readback must show voters 0/1/2, a current leader, follower lag
  no greater than 1,000 records or five seconds, and no under-replicated or offline partition;
- PostgreSQL remains ready with `fsync`, `full_page_writes`, and `synchronous_commit` on, `wal_buffers=16MB`, and WAL
  below 0.25 MiB/s;
- the Hyperliquid feed `/readyz` succeeds with ready, WebSocket, Kafka, and ClickHouse true; the scheduler `/readyz`
  succeeds with fresh trading/reconcile cycles and healthy leadership; and the latest Knative API revision is converged
  and directly ready;
- the required Argo applications are `Synced/Healthy`; and
- both the archive worker and Kafka ClickHouse writer are still declaratively and actually at zero replicas.

The command reports the temporary Kafka controller timeout overrides as a warning rather than a pass condition. They
remain containment until application activation is proven separately at default controller timeout behavior.

The newest extended SMART tests are `Interrupted (host reset)` and old. They remain diagnostic context only: they do not
prove a physical fault, and waiting 40.25-41.25 hours for replacement self-tests is not an activation prerequisite when
current overall health and critical media/interface counters are clean.

The superseded repair-gate collection completed at `2026-07-15 01:38 UTC`, using `2026-07-14T20:12:00Z` as the start
of the incident window. It correctly returned `FAIL` because that window intentionally contained the incident itself;
that result did not prove a continuing fault or a physical root cause. Both contained deployments had desired, actual,
ready, available, and terminating replica counts of zero, with no matching pods. The bounded result reported:

- five SCSI device-reset/recovery records and two durable cache-flush I/O failures in Talos;
- Ceph `HEALTH_WARN` with `BLUESTORE_SLOW_OP_ALERT`, `RECENT_CRASH`, and the unacknowledged OSD.3 crash;
- 670 KRaft request-timeout records, seven actual broker-fencing records, and 3,765 controller events above two seconds;
- the direct quorum voter, leader, follower-lag, under-replication, and offline-partition checks passed, demonstrating why
  pod readiness and a single healthy quorum read are insufficient without the full-window log checks;
- PostgreSQL WAL at 0.0059 MiB/s over 30.3 seconds, within budget;
- the Hyperliquid feed, scheduler, and current Knative API revision passed their direct readiness checks; and
- Rook-Ceph `Degraded` in Argo CD.

No archive, writer, Ceph-warning acknowledgement, Kafka-timeout removal, or other mutation was attempted in that
collection. A new clean window begins only after the corrected gate is merged and the understood stale crash record is
archived.

## Remaining activation gates

### Archive worker

After the storage-stability gate passes:

1. start one archive replica;
2. prove the advisory lock prevents overlap;
3. verify each transaction processes no more than 1,000 composite-key rows;
4. require no statement timeout, lock timeout, or unchanged-row rewrite;
5. require PostgreSQL WAL below 0.25 MiB/s and no Ceph/Kafka regression; and
6. stop and return to zero replicas immediately if any gate fails.

### Kafka-backed ClickHouse writer

After archive proof:

1. merge the current-head activation PR against `_kafka_staging` tables only;
2. catch up from the retained Kafka record set with offset-after-ClickHouse-ack semantics;
3. require writer readiness, `caughtUp=true`, bounded lag, and no uncommitted-range duplication;
4. run the suspended parity gate at fixed partition high watermarks;
5. require every retained delete-only offset exactly once and the compacted-topic record-set contract to pass; and
6. record a cutover boundary before disabling the direct sink.

### Kafka timeout cleanup

The live Kafka resource still contains the temporary 60-second controller election and 180-second controller fetch
timeouts. Kafka itself is `Ready` on 4.3.0 / `4.3-IV0`, all three controller and three broker pods are ready, and no
managed topic is not ready. That availability is containment, not latency proof: at 00:01 UTC controller 2 reported a
60-second average controller-event duration of 1,664 ms and a slowest `writeNoOpRecord` of 11,952 ms while controllers
0 and 1 repeatedly timed out Raft fetches to controller 2. Remove both overrides only after the clean storage baseline
and staged application activation remain stable at default timeout behavior with:

- three stable KRaft voters and a stable leader;
- full ISR and zero offline partitions;
- no broker fencing or sustained follower lag;
- healthy Torghut producers and consumers; and
- no controller durable event above the accepted baseline.

No further timeout increase is an accepted remediation.

## Alerts and rollback boundaries

At 00:09 UTC Alertmanager contained only `CephClusterHealthWarning`. The false critical Argo alert for the intentionally
suspended parity CronJob expired after #12498 reconciled. The Ceph warning remains unsilenced until its understood stale
crash record is archived and any current BlueStore slow operation clears; future occurrences remain alerting.

- Archive rollback: scale the declarative deployment back to zero; preserve its committed shard cursor.
- Kafka writer rollback before cutover: stop the writer; uncommitted offsets remain replayable.
- Direct-sink cutover rollback: re-enable only at the recorded partition boundary.
- PostgreSQL/Ceph tuning rollback: revert one parameter at a time through GitOps.
- Kafka timeout rollback: temporary containment only; reopening the storage incident is mandatory.

## Explicit external boundaries

- Kafka controller-local storage remains unsupported with the current static KRaft quorum and immutable Strimzi
  controller node pool. No manual metadata copy or replacement cluster is part of this rollout.
- The incoming network upgrade is implemented in its own change window with the old path retained for rollback.
- A third Ceph storage host is not planned. The resulting two-host durability ceiling is accepted; any future action
  that actually requires taking one storage host offline needs a separate maintenance-outage plan.
