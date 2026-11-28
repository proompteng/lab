# Cluster performance audit — Wave 18H

This is a Git-source audit of [the pre-change main commit](https://github.com/proompteng/lab/commit/fab5bb47691e8775b69809bcc1327735269f1223)
and its pinned chart and application defaults, not a live inventory or a benchmark. No live cluster reads or mutations
were needed. Turin (384 cores, 1 TiB RAM) and Altra (`talos-192-168-1-85`, 128 cores, 753 GiB RAM) are the two 100G
workload hosts. Those are hardware totals, not Kubernetes allocatable capacity.

## Bayn PostgreSQL

[`bayn-db`](../../argocd/applications/bayn/postgres-cluster.yaml) already has a dedicated WAL volume and tuned
checkpoint interval. Its planner cache estimate still reflected the former 2 GiB memory limit, even though each
instance now requests 2 GiB and can use 8 GiB. Both instances use local-path NVMe, not Ceph RBD. The defaults
below refer to [PostgreSQL 18](https://www.postgresql.org/docs/18/runtime-config-resource.html), not an observed
session configuration.

| PostgreSQL setting                                                   | Before                          | After                    | Reason                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `effective_cache_size`                                               | `1536MB`                        | `4GB`                    | Estimate shared and OS cache together, without assuming the whole cgroup limit is cache or allocating extra memory.                          |
| `work_mem`                                                           | Unset, `4MB` default            | `8MB`                    | Give each sort or hash more room before spilling. This is per operation and worker, not per instance.                                        |
| `random_page_cost`                                                   | Unset, `4.0` default            | `1.5`                    | Account for random NVMe reads without treating them as cheap as sequential reads (`seq_page_cost=1.0`).                                      |
| `max_wal_size`                                                       | `4GB`                           | `4GB`                    | Already above the upstream `1GB` default. Keep recovery and WAL disk headroom rather than increasing the target without checkpoint evidence. |
| `checkpoint_timeout` / `checkpoint_completion_target`                | `15min` / unset (`0.9` default) | `15min` / explicit `0.9` | Keep writes spread over the interval.                                                                                                        |
| `autovacuum_vacuum_scale_factor` / `autovacuum_analyze_scale_factor` | Unset (`0.2` / `0.1`)           | `0.1` / `0.05`           | Vacuum dead tuples and refresh planner statistics earlier on larger tables, without increasing worker count or vacuum I/O budgets.           |

`shared_buffers=512MB`, `wal_buffers=16MB`, LZ4 WAL, the default hash memory multiplier of 2, CPU request/limit
(`250m` / `2`) and memory request/limit (`2Gi` / `8Gi`) are unchanged. Parallel workers, multiple plan nodes and
concurrent connections multiply work memory; an individual hash operation can use 16 MiB at the new setting. Earlier
vacuum can add I/O during write bursts. Compare query plans, temp writes and vacuum activity with the same workload
before changing connection limits, memory again, or the [vacuum cost controls](https://www.postgresql.org/docs/18/runtime-config-vacuum.html).

Keep required synchronous `ANY 1`, both instances on separate hosts, CNPG PDBs, TLS, checksums, Barman backups
with 14-day retention, and all trade and application deadlines. PGDATA remains 500 GiB and WAL 32 GiB per
instance. These local-path sizes are not filesystem quotas, and PostgreSQL's
[`max_wal_size` is a soft checkpoint target](https://www.postgresql.org/docs/18/runtime-config-wal.html#GUC-MAX-WAL-SIZE):
archive or replication lag can retain more. Check actual filesystem headroom, not just the claim size.
`agents-db-next` is out of scope: its source defines a single instance and a 50 GiB Ceph RBD claim with a 4 GiB
memory limit. These settings are not a recommendation for it.

## ARC

The [ARC application](../../argocd/applications/arc/application.yaml) defines six scale sets. Chart 0.15.1 renders
the runner and scratch initializer with the same pinned digest and no explicit pull policy; Kubernetes defaults
digest-only images to `IfNotPresent`. Images, labels, node placement, taint tolerations and pool sizes do not change.

| Runner pool (AMD64 / ARM64) | Min–max per host | Scratch, unchanged               | Memory request / limit before → after | Node-local ephemeral request / limit before → after |
| --------------------------- | ---------------- | -------------------------------- | ------------------------------------- | --------------------------------------------------- |
| `arc-amd64` / `arc-arm64`   | 5–10 / 5–10      | 64 GiB generic ephemeral RBD PVC | 8 / 16 GiB → same                     | 10 / 100 GiB → same                                 |
| `*-tmpfs`                   | 0–10 / 0–8       | 16 GiB memory `emptyDir`         | 8 / 18 GiB → 16 / 24 GiB              | 10 / 100 GiB → 10 / 20 GiB                          |
| `*-tmpfs-large`             | 0–6 / 0–6        | 24 GiB memory `emptyDir`         | 8 / 28 GiB → 24 / 32 GiB              | 10 / 100 GiB → 10 / 20 GiB                          |

Each tmpfs runner now reserves memory equal to its scratch capacity. Scratch counts against memory, not local
ephemeral storage. At full scratch, the nominal margin for other memory grows from 2 or 4 GiB to 8 GiB. The main
writable paths (Nix, caches, temp, and work) already live on scratch; the 20 GiB local limit constrains layer writes
and logs without limiting tmpfs. Retain the higher local limit on the default Ceph queues, which remain the fallback
for larger builds. The image's read-only layers and container runtime metadata are not bounded by the writable-layer
limit. Monitor system disk pressure independently.

Runner CPU stays at a 4-core request and a 20-core limit; pod QoS remains Burstable. Each initializer retains a 1-core
request, 2-core limit, 2 GiB memory request and 8 GiB memory limit, with no separate ephemeral-storage resource
setting. Initializers write the seed to scratch, verify the filesystem, copy and free-space reserve, remove partial
staging on retry, and cannot register a runner on bootstrap failure. The seed budgets (4 GiB maximum on tmpfs and
45 GiB free space after copy on RBD) are unchanged. BuildKit is a job-local process and its cache lives on scratch;
ARC retires the ephemeral Pod after the job, which releases tmpfs and allows Kubernetes to collect generic ephemeral
PVCs. There is no new cleanup job, PVC resize, or active job termination.

| Configured max occupancy | ARC slots | ARC CPU requests / limits | ARC memory requests before → after | ARC memory limits before → after | Node-local ephemeral limits before → after |
| ------------------------ | --------: | ------------------------: | ---------------------------------: | -------------------------------: | -----------------------------------------: |
| Turin                    |        26 |           104 / 520 cores |                      208 → 384 GiB |                    508 → 592 GiB |                            2600 → 1320 GiB |
| Altra                    |        24 |            96 / 480 cores |                      192 → 352 GiB |                    472 → 544 GiB |                            2400 → 1280 GiB |

These are sums, not claims about simultaneous usage or usable disk space. The ARC requests alone reserve 260 GiB
local ephemeral space on Turin and 240 GiB on Altra. At the
[`AgentRun` default](../../argocd/applications/agents/values.yaml) of 2 CPU and 8 GiB memory requested per run, 16
additional runs on each host bring Altra to 128 requested cores before other workloads. Agent memory limits can add
512 GiB per host at that split. The spread is preferred, not a quota, and actual jobs can request different resources.
Some Pods can queue or throttle at full load; ARC or AgentRun maxima do not guarantee sustained throughput. Do not
raise CPU limits or pool maxima to compensate without measuring contention and reserving capacity for platform services.

## LGTM

The [observability kustomization](../../argocd/applications/observability/kustomization.yaml) renders Loki 3.7.10
(chart 21.4.3), Mimir 3.2.6 (6.2.2) and Tempo 3.1.1 (3.29.1). The limits below distinguish rendered values
from the defaults in those binaries.

| Component                              | Before → after                                                                                                                                    | Finding and retained settings                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loki push parsing                      | `max_recv_msg_size`: 100 → 8 MiB; `max_decompressed_size`: 5000 → 16 MiB                                                                          | The decoded-body default exceeded the distributor's 512 MiB memory limit before tenant rate admission. The gateway already limits incoming bodies to 4 MiB; normal Alloy batches default to 1 MiB.                                                                                                                                                           |
| Loki line admission                    | `max_line_size`: 0 (unlimited) → 2 MiB; `max_line_size_truncate`: false → explicit false                                                          | Reject oversized new input rather than corrupt structured records. The bound is above the [1 MiB AgentRun terminal event budget](../../services/agents/src/runner-status.ts). Verify other producers and rejects under peak load.                                                                                                                            |
| Loki burst and cardinality             | Unchanged                                                                                                                                         | Global tenant budget 4 MiB/s, burst 6 MiB per distributor; per-stream 3 MiB/s and 15 MiB burst; max 5,000 active streams per tenant; max 30 label names per series. Structured metadata remains disabled on the existing BoltDB Shipper schema.                                                                                                              |
| Loki PDBs / QoS                        | No budgets for distributor, querier and query frontend → `maxUnavailable: 1` each                                                                 | Each has two replicas. The ingester already has a budget of one. CPU and memory settings are unchanged and Pods remain Burstable. The budgets govern voluntary evictions only; they do not guarantee survival of OOM, host loss or a rollout.                                                                                                                |
| Mimir ingestion and cardinality        | Unchanged                                                                                                                                         | `anonymous`: 20,000 samples/s, 400,000-sample burst and 300,000 in-memory series across the cluster before replication. No separate per-metric series limit. Churn and replay still cost memory; keep the existing series-capacity and rejected-sample alerts.                                                                                               |
| Mimir ingester QoS                     | Per ingester request `100m` / `512Mi` → `500m` / `2Gi`; no CPU or memory limit before or after                                                    | Three Burstable ingesters get more scheduling headroom for TSDB head and replay without an artificial cgroup ceiling. The chart already renders a one-unavailable PDB for the ingester and distributor.                                                                                                                                                      |
| Tempo ingestion and cardinality        | Unchanged                                                                                                                                         | Native local rate and burst of 30,000,000 bytes/s and 30,000,000 bytes per distributor; two distributors. The live store enforces 10,000 active traces per tenant per instance; the trace size limit is 5,000,000 bytes. Keep the existing lag and backpressure behavior.                                                                                    |
| Tempo block builder and live store QoS | Both: `512Mi` / `1Gi` memory request/limit → `1Gi` / `2Gi`. Local ephemeral-storage request: none → `8Gi` per block builder, `4Gi` per live store | Burstable, three Pods each, same `200m` / `1` CPU and one-unavailable PDBs. The builder can consume up to 5 GB in a cycle and the live store budgets 250 MB of live traces before accounting for other heap and encoding work. Reserve node disk for their local `emptyDir` working directories; no new eviction cap before measuring replay and disk peaks. |
| Object and Kafka retention             | Unchanged                                                                                                                                         | Loki log expiry stays off and Mimir blocks have no age expiry. The Mimir ingest topic keeps 24 hours. Tempo keeps 48 hours of blocks (one hour for compacted blocks) and seven days in Kafka. Index and block compaction continue as before.                                                                                                                 |

Do not enable or shorten Loki or Mimir retention in this change: expiry can delete existing history and is not
reversed by a config revert. The ingress limits bound rates, not lifetime RGW disk usage. Observe RGW bucket
growth and pool free space, local node disk headroom, and Kafka lag using the existing
[Ceph and storage telemetry](ceph-performance-telemetry.md). If the growth slope threatens capacity,
review added capacity or an explicitly authorized retention policy separately. No storage class, PVC, bucket,
replication factor, or Kafka topic changes. Grafana and the gateways remain single points for their own paths;
there is no new single-replica PDB that would prevent maintenance.

Versioned references: [Loki distributor defaults](https://github.com/grafana/loki/blob/v3.7.10/pkg/distributor/distributor.go),
[Loki tenant limits](https://github.com/grafana/loki/blob/v3.7.10/pkg/validation/limits.go),
[Alloy batching](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.write/),
[Mimir limits](https://github.com/grafana/mimir/blob/mimir-3.2.6/pkg/util/validation/limits.go),
[Tempo limits](https://github.com/grafana/tempo/blob/v3.1.1/modules/overrides/config.go) and
[Tempo live store](https://github.com/grafana/tempo/blob/v3.1.1/modules/livestore/config.go).

## Rollout and acceptance

The PR does not deploy. Use these gates during an authorized rollout. Record a comparable baseline first: current
revisions, both hosts' allocatable CPU, memory and local disk, ARC queue times and evictions, database timings and
replication, Kafka lag, ingestion errors and RGW headroom. Prefer a low-load window and no concurrent node drains.
Run the gates in this order; the main-tracking and image-promotion applications have independent automated
reconciliation, so the order is for acceptance, not a cross-application sync guarantee. Do not force a rollout to
make up that ordering.

1. **Observability first.** Verify the exact merged revision of the main-tracking Argo Application, native config
   Jobs and existing sync waves. Confirm the three Loki PDB selectors match their Deployments. Record fresh logs
   through the compatibility gateway, including an intact AgentRun terminal event, and compare a retained log to
   its pre-change timestamp, labels and hash. Check canary results, push errors and discard reasons, not just
   readiness. In Mimir, verify fresh and retained samples, the unchanged tenant limits, all three ingesters and
   Kafka lag. In Tempo, confirm all block builders and live stores are ready, no increasing consumer lag, a new
   trace queryable by ID and a retained trace still readable. Confirm no new OOM, CPU throttling or node disk pressure.
2. **ARC second.** Use the [normal Kargo delivery path](../release-automation.md): successful main-only runner image
   publication, exact Freight and the Stage-generated `kargo/arc-runner` revision. Let accepted jobs finish normally.
   Confirm the six scale sets' bounds, node placement and new Pod resource values. Dispatch
   [ARC tmpfs acceptance](../../.github/workflows/arc-tmpfs-acceptance.yml) from the matching source revision. It
   checks cgroup memory, capacity, all scratch mounts and a real BuildKit output on all four labels. Then use a
   comparable mixed ARC/AgentRun build window to compare queue time, cgroup memory events, local scratch and disk
   use, CPU throttling, etcd WAL latency and Ceph slow operations. Verify completed Pods and their disposable
   scratch retire normally. Do not increase concurrency to force all maxima if requests no longer fit.
3. **Bayn last, outside trading.** Verify the reviewed `kargo/bayn` revision, current backup and free space before
   an authorized reconciliation. Do not run while the primary has no healthy synchronous standby. Retain the
   existing CNPG switchover policy; do not restart both Pods or relax quorum. Use the existing authenticated
   PostgreSQL path without printing connection details. On both instances read `name, setting, unit, pending_restart`
   in `pg_settings` for the settings above. Verify no pending restart, one streaming quorum standby,
   `synchronous_commit=on`, WAL archiving and an unchanged backup schedule. Compare
   `pg_stat_checkpointer`, `pg_stat_wal`, temp bytes, dead tuples and vacuum timing against the baseline; check exact
   financial reconciliation and approved application readback without activating a new trading policy.

Stop at the affected gate if valid producers are rejected, queries or jobs regress, Kafka lag grows without recovery,
memory/disk pressure rises, or PostgreSQL durability or reconciliation cannot be proved. Local rendering and
contract tests are not evidence of live throughput or release health.

## Rollback

Use a reviewed Git revert of the affected settings and the same delivery path, not a direct Kubernetes or SQL
configuration edit. If rolling back the whole wave, undo Bayn, ARC, then observability. Revert only the affected
component for an isolated regression.

- **Bayn:** Restore `effective_cache_size: 1536MB` and remove the explicit work memory, random-page, checkpoint
  completion and two autovacuum overrides. Promote the reviewed source through Bayn's Kargo Stage. Recheck both
  instances, required synchronous replication, WAL/backup continuity and financial reconciliation. Do not
  restore from backup just to change GUCs.
- **ARC:** Restore the two tmpfs memory requests/limits and local limits from the table and restore the acceptance
  matrix together. Use the ARC image and Kargo path, leave accepted jobs running, and confirm replacements and
  the workflow use the same resource values. Use existing Ceph labels for workloads that need more space. Do not
  delete runner PVCs or prune shared paths to clean up.
- **LGTM:** Revert the Loki request and line settings and its three added PDBs, Mimir ingester requests, and Tempo
  block-builder/live-store resources through the main-tracking Application. Keep all PVCs and objects, existing
  compaction and expiry policies, topic offsets, compatibility Services, and the native config gates. Recheck
  fresh and retained logs, metrics and traces before ending the incident. A revert does not recover input
  already rejected by a receiver.
