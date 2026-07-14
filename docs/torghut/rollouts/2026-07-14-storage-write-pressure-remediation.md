# Torghut and Ceph Write-Pressure Remediation Rollout

Last updated: **2026-07-14 13:50 UTC**

Status: **in progress**

Design: `docs/torghut/storage-write-pressure-remediation-design.md`

## Outcome

This document is the durable production evidence for the Torghut and shared-Ceph write-pressure remediation. It
separates changes that are merged and live from work that is still gated. Kafka controller-local storage and the
physical network upgrade remain external constraints defined by the accepted design.

## Delivered changes

| Slice                                                 | Pull request   | Production state                                                               |
| ----------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| Accepted design and source map                        | #12403         | Merged                                                                         |
| Delta-only options subscription reconciliation        | #12407         | Merged and live                                                                |
| Per-table Hyperliquid ClickHouse batching             | #12409, #12410 | Merged and live                                                                |
| Bounded live discovery                                | #12421, #12432 | Merged and live                                                                |
| Set-based options persistence                         | #12435, #12437 | Merged and live                                                                |
| Resumable archival reconciliation                     | #12438, #12439 | Merged; archive worker contained at zero replicas pending finalizer correction |
| Bounded archive finalization                          | #12441, #12449 | Source and image promoted; composite-key correction #12452 pending             |
| Released migration revision compatibility             | #12454         | PostgreSQL 17 proof complete; merge and image promotion pending                |
| Shared CNPG, Ceph, and RBD-client observability       | #12443         | Merged and live                                                                |
| Ceph scrub concurrency and count correction           | #12453         | Runtime containment live; GitOps merge pending                                 |
| Bilig PostgreSQL capacity and logical-WAL containment | #12447         | Merged and live                                                                |

## Live proof

### Hyperliquid direct-sink batching

The feed stayed ready throughout the observation. At 12:59 UTC `/readyz` returned HTTP 200 with `websocket=true`,
`kafka=true`, `clickhouse=true`, and all twelve markets present.

ClickHouse `system.part_log` shows the production transition at 07:00 UTC:

| Table/event             |             Before: 05:00-06:59 UTC | After: representative full hours | Result                            |
| ----------------------- | ----------------------------------: | -------------------------------: | --------------------------------- |
| BBO `NewPart`           | 2,089-2,296/hour; median 36-40 rows |  111-168/hour; median 1,000 rows | 92-95% fewer parts; size gate met |
| BBO `MergeParts`        |                    1,340-1,525/hour |                       24-36/hour | 97-98% fewer merges               |
| Candles `NewPart`       |         828-882/hour; median 2 rows |    43-63/hour; median 62-67 rows | 92-95% fewer parts                |
| Candles `MergeParts`    |                        828-882/hour |                       12-26/hour | 97-99% fewer merges               |
| Asset-context `NewPart` |         337-362/hour; median 2 rows |    43-56/hour; median 27-29 rows | 83-88% fewer parts                |

Sparse tables flush on the 30-second age limit when they cannot reach 100 rows. They are evaluated separately from the
size-triggered BBO gate.

### Options archival containment

Promotion #12449 installed image digest
`sha256:bac85c5b24ba543aee521f2a3505546c97027d8ff76fa678e31e6d0b368280f6` and ran the migration chain. The live
database now reports Alembic head `0064_strategy_capital_authority`; `ix_options_catalog_active_expiration_symbol` is
valid and ready.

The archive worker then exposed a separate finalization-plan defect. Candidate selection was bounded to 1,000 paired
expiration-date and symbol rows, but the transition statement joined them back to the four-million-row catalog by
symbol alone. Every populated shard hit the 30-second statement timeout and rolled back. The deployment was immediately
returned to zero replicas under an exact Argo CD deny window. Twelve shard watermarks remain restartable in
`finalizing`; no contract transition was committed and no data was lost.

Correction #12452 joins a typed, zipped candidate relation on both expiration date and symbol. A production
`EXPLAIN (COSTS OFF)` selected `ix_options_catalog_active_expiration_symbol` for the catalog lookup and the archive
membership primary key for the anti-join. The sync hold remains in place until that correction is merged, published,
and desired by Git.

### Shared storage telemetry

The observability rollout is scraping all 14 CNPG targets, six Ceph OSD latency series, and per-pod `/dev/rbd*` write
bytes and IOPS. At 12:55 UTC:

- Ceph was `HEALTH_OK` with all six OSDs up and in.
- Client traffic was about 39 MiB/s read and 8.2 MiB/s write.
- Four PGs were scrubbing: three deep scrubs and one regular scrub. At 13:30 UTC, six PGs were deep-scrubbing.
- `osd_max_scrubs=3` came from the Ceph default, not an out-of-band config-database override.
- OSD commit latency was 39-110 ms at the sampled instant.
- The largest RBD writers were the Jangar primary and replica, followed by both Torghut ClickHouse replicas.

At 13:31 UTC, OSD 5 was primary for three simultaneous scrub operations while Kafka controller durable events reached
4.3 seconds. At 13:47 UTC, OSDs 2 and 5 were each running two deep scrubs and controller events were still reaching
3.9 seconds. Emergency containment set the runtime `osd_max_scrubs` value from its default of three to one for the
`osd` section; effective readback is now one on OSDs 0-5. Existing scrubs are allowed to finish. PR #12453 makes that
limit authoritative in GitOps and corrects the recording rule that counted every deep-scrubbing PG twice. This direct
config-database change is the only current Ceph drift and must disappear after Argo reconciles the PR.

Kafka remained `Ready` with version 4.3.0, metadata `4.3-IV0`, three controller pods, three broker pods, and no
not-ready KafkaTopic resources. That status does not establish controller durability: controller 2 continued logging
2-7.5 second `writeNoOpRecord`, broker-heartbeat, and stale-broker-fencing events, while controllers 0 and 1 repeatedly
timed out two-second Raft fetches to controller 2. Kafka timeout overrides therefore remain required containment and
must not be removed yet.

### PostgreSQL baseline

Torghut PostgreSQL has a 50 GiB PVC with 29 GiB available and a 19 GiB database. Current settings remain the PostgreSQL
defaults: `wal_buffers=4MB`, `max_wal_size=1GB`, `checkpoint_timeout=5min`, and `wal_compression=off`.

The `TorghutPostgresWalBuffersFull` warning is currently pending. In the latest 15-minute sample PostgreSQL generated
about 13.9 MiB of WAL, only 0.015 MiB/s and well below the 0.25 MiB/s gate, but still reported about 1,976
WAL-buffer-full events. Since the statistics reset on 2026-07-03, 62.2% of checkpoints have been requested rather than
timed (`2,681` requested versus `1,628` timed). This supports a later bounded increase in WAL buffers and checkpoint
headroom after the archive load is proven; it is not a reason to weaken `fsync`, `full_page_writes`, or
`synchronous_commit`.

### Jangar backup containment

The 2026-07-14 11:00 UTC base backup was terminated after it amplified shared Ceph writes and Kafka controller stalls.
The preceding daily backup completed successfully on 2026-07-13. Both Jangar database PVCs are now 300 GiB and bound;
no backup is currently running. GitOps policy #12444 is still pending and must be live before another scheduled backup
is accepted as proof.

## Remaining gates

1. Merge and publish composite-key archive correction #12452, remove the exact temporary Argo sync hold, and prove
   restartable batches of no more than 1,000 rows without statement timeouts or WAL regression.
   Merge and promote migration-graph compatibility #12454 so databases parked on the released strategy-capital 0063
   revision can reach the sole 0065 head.
2. Merge and publish the Kafka-backed writer with replicas at zero, then activate it against staging tables.
3. Capture Kafka retained-record manifests and prove each retained offset exists exactly once in staging under the
   delete-only and compacted-topic contracts before cutover.
4. Merge the Jangar backup-pressure policy and prove a throttled backup does not destabilize Kafka or Ceph.
5. Merge #12453, verify one-scrub-per-OSD convergence and scrub-debt health, then continue collecting the accepted
   baseline before selecting a scrub-hour window or changing PostgreSQL.
6. Remove the two Kafka timeout overrides only after controller events, quorum, ISR, and client traffic remain stable at
   default timeout behavior.

## Rollback boundaries

- Stop the archive worker without changing the last completed live-universe state if bounded finalization regresses.
- Stop the Kafka writer before cutover; its uncommitted offsets remain replayable.
- Re-enable the direct sink only at a recorded offset boundary after cutover.
- Revert PostgreSQL and Ceph settings individually through GitOps.
- Restoring Kafka timeout overrides is temporary containment, not a completed remediation.
