# Torghut and Ceph Write-Pressure Remediation Rollout

Last updated: **2026-07-14 15:03 UTC**

Status: **in progress**

Design: `docs/torghut/storage-write-pressure-remediation-design.md`

## Outcome

This document is the durable production evidence for the Torghut and shared-Ceph write-pressure remediation. It
separates changes that are merged and live from work that is still gated. Kafka controller-local storage and the
physical network upgrade remain external constraints defined by the accepted design.

## Delivered changes

| Slice                                                 | Pull request    | Production state                                                               |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| Accepted design and source map                        | #12403          | Merged                                                                         |
| Delta-only options subscription reconciliation        | #12407          | Merged and live                                                                |
| Per-table Hyperliquid ClickHouse batching             | #12409, #12410  | Merged and live                                                                |
| Options TA ClickHouse batching                        | #12455          | Source review rerun pending; digest-pinned activation PR follows publication   |
| Kafka-backed Hyperliquid ClickHouse writer            | #12440          | CI green; current-head source review pending; staged at zero replicas          |
| Kafka/ClickHouse retained-record parity gate          | local 92cce1849 | Validated dependent slice; publish after #12440 lands                          |
| Bounded live discovery                                | #12421, #12432  | Merged and live                                                                |
| Set-based options persistence                         | #12435, #12437  | Merged and live                                                                |
| Resumable archival reconciliation                     | #12438, #12439  | Merged; archive worker contained at zero replicas pending finalizer correction |
| Bounded archive finalization                          | #12441, #12449  | Source and image promoted; composite-key correction #12452 pending             |
| Released migration revision compatibility             | #12454          | PostgreSQL 17 proof complete; merge and image promotion pending                |
| Shared CNPG, Ceph, and RBD-client observability       | #12443          | Merged and live                                                                |
| Ceph scrub concurrency and count correction           | #12453          | Runtime containment live; GitOps merge pending                                 |
| Bilig PostgreSQL capacity and logical-WAL containment | #12447          | Merged and live                                                                |
| Torghut PostgreSQL WAL-buffer containment             | #12457          | 16 MiB setting validated; current-head review and scrub-safe restart pending   |

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

### Options TA direct-sink diagnosis

The next dominant ClickHouse writer was traced to the Options Flink JDBC sinks rather than the Hyperliquid feed. In a
15-minute production sample, `options_contract_features`, `options_contract_bars_1s`, and `options_surface_features`
created 5,359 new parts at only 19-43 rows per part. The live Flink graph showed all three JDBC sinks at parallelism
four, the client flushed every 250 milliseconds, and shared code capped the requested batch at 100 rows.

PR #12455 adds a live-Options-specific 1,000-row ceiling and configurable sink parallelism while preserving the
100-row full-day replay guardrail. Its current head intentionally leaves the immutable deployment image and GitOps
values unchanged. After that source image is published, a separate digest-pinned activation PR will set one writer per
destination table and a bounded 30-second age flush under the existing 120-second ClickHouse freshness SLO. The live
rollout must reduce aggregate Options `NewPart` and `MergeParts` rates by at least 80% without freshness, checkpoint, or
Kafka-source regression.

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

At 14:02 UTC, three deep scrubs were still active on three different primary OSDs. This is expected with
`osd_max_scrubs=1`: the setting is per OSD, not a cluster-wide cap. Controller 2 completed 305 events at an average of
1.39 seconds, with the slowest `writeNoOpRecord` taking 8.07 seconds. The cap removed the prior same-OSD concurrency but
does not replace the accepted low-traffic scrub window.

At 14:46 UTC, one regular scrub in the RGW bucket-data pool overlapped roughly 12.8 MiB/s of RBD-pool writes and OSD
commit/apply latency peaks of 99-279 ms. Controller 2 completed 363 events at an average of 863 ms, and its slowest
`writeNoOpRecord` took 8.52 seconds. The scrub then finished and Ceph returned to 601 active+clean PGs, but controller
events continued reaching 2-4 seconds while the queue drained; the one-minute average fell to 297 ms by 14:49 UTC.
Kafka remained available and all 37 managed topics stayed ready. This is improvement after containment, not evidence
that controller durability is safe at default timeouts.

The 14:46 RBD breakdown identifies the application pressure precisely: the two Torghut ClickHouse replicas wrote
about 7.26 MiB/s at 440 IOPS, Torghut PostgreSQL wrote 1.23 MiB/s at 53 IOPS, and the Jangar primary and replica wrote
1.99 MiB/s at 135 IOPS. Kafka controller PVCs wrote only about 2 IOPS each, but those synchronous metadata writes share
the latency tail created by the much larger ClickHouse, PostgreSQL, Jangar, and scrub workload.

The cluster started three more scrub operations on distinct primary OSDs by 14:51 UTC, including one deep scrub.
Controller 2 then completed 332 events at a 1.58-second average and hit an 11.91-second `writeNoOpRecord`. This confirms
that `osd_max_scrubs=1` prevents same-OSD concurrency but cannot impose a cluster-wide maintenance limit. The PostgreSQL
restart and Kafka timeout cleanup must not run while scrubs are active; a measured scrub window remains mandatory.

The seven-day window gate cannot yet be evaluated from Mimir: the raw Ceph series and new recording rules first became
available with today's observability rollout at 13:00 UTC. Historical Mimir queries for unrelated metrics still work,
so this is a new-series baseline rather than general retention loss. No scrub-hour window will be guessed from an
assumed clock. Collection continues through at least 2026-07-21; Ceph remains `HEALTH_OK` with no scrub debt warning.

Kafka remained `Ready` with version 4.3.0, metadata `4.3-IV0`, three controller pods, three broker pods, and no
not-ready KafkaTopic resources. That status does not establish controller durability: controller 2 continued logging
2-7.5 second `writeNoOpRecord`, broker-heartbeat, and stale-broker-fencing events, while controllers 0 and 1 repeatedly
timed out two-second Raft fetches to controller 2. Kafka timeout overrides therefore remain required containment and
must not be removed yet.

### PostgreSQL baseline

Torghut PostgreSQL has a 50 GiB PVC with 29 GiB available and a 19 GiB database. Current settings remain the PostgreSQL
defaults: `wal_buffers=4MB`, `max_wal_size=1GB`, `checkpoint_timeout=5min`, and `wal_compression=off`.

The `TorghutPostgresWalBuffersFull` warning is firing. In the latest 15-minute sample PostgreSQL generated only about
0.019 MiB/s of WAL, well below the 0.25 MiB/s gate, but still reported about 2,450 WAL-buffer-full events. Since the
statistics reset on 2026-07-03, 62.2% of checkpoints have been requested rather than timed (`2,681` requested versus
`1,636` timed), although the latest hour had zero requested checkpoints. PR #12457 sets `wal_buffers` to 16 MiB while
preserving `fsync`, `full_page_writes`, and `synchronous_commit`. Because `wal_buffers` is a postmaster setting and
Torghut has one CNPG instance, the change carries a brief expected database interruption. CI is green, but the
current-head automatic review has not arrived. The latest preflight found Ceph `HEALTH_OK` with one active deep scrub,
so merge and restart remain gated. Checkpoint and WAL-size changes still wait for the post-application baseline.

The separate `TorghutWSRestartsOrOOM` alert at 13:59 UTC was caused by the liveness controller intentionally restarting
the forwarder after market-data channels remained starved for two minutes. Kafka and Alpaca-session gates stayed true,
the new process restored all channels, readiness returned true, and the 10-minute restart-window alert resolved without
changing a timeout or suppressing the alert.

### Torghut decision-stall incident

`TorghutQuantDecisionsStalledDuringMarketHours` fired at 14:51 UTC after the last persisted decision at 14:30 UTC. The
scheduler remained ready, its accepted TA source was current, and all ten configured symbols had fresh signal rows. The
new scheduler process evaluated 126 signals but safely rejected 85 for missing executable quotes and 41 for spreads
above the existing quality ceiling.

The executable-quote fallback was configured for Alpaca `sip`, while the account is not entitled to recent SIP data.
Every fallback attempt returned HTTP 403 with the provider's subscription error. A read-only production probe against
the same credentials returned fresh HTTP 200 IEX quotes for NVDA, CRDO, SNDK, and WDC, matching the IEX feed already
used by the websocket forwarder. PR #12461 changes only the live service and scheduler fallback feed to `iex`; quote
age, spread, session, and provider-backoff gates remain unchanged. Resolution requires the GitOps rollout followed by
real decision traffic, not an alert silence.

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
3. Publish the validated parity gate from local commit `92cce1849` after #12440 lands. It reads live topic cleanup
   policy, captures fixed per-partition high watermarks, requires contiguous lineage for delete-only topics, enumerates
   the retained record set for compacted topics, and fails unless every required staging offset exists exactly once.
4. Merge the Jangar backup-pressure policy and prove a throttled backup does not destabilize Kafka or Ceph.
5. Merge #12455, publish its TA image, activate it through a digest-pinned GitOps PR, and prove at least 80% fewer
   Options ClickHouse parts before promoting the prepared 16 MiB PostgreSQL WAL-buffer change through its controlled
   single-instance restart.
6. Merge #12453, verify one-scrub-per-OSD convergence and scrub-debt health, then collect the accepted Ceph baseline
   through at least 2026-07-21 before selecting a scrub-hour window.
7. Remove the two Kafka timeout overrides only after controller events, quorum, ISR, and client traffic remain stable at
   default timeout behavior.

## Rollback boundaries

- Stop the archive worker without changing the last completed live-universe state if bounded finalization regresses.
- Stop the Kafka writer before cutover; its uncommitted offsets remain replayable.
- Re-enable the direct sink only at a recorded offset boundary after cutover.
- Revert PostgreSQL and Ceph settings individually through GitOps.
- Restoring Kafka timeout overrides is temporary containment, not a completed remediation.
