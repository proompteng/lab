# Unify Bayn PostgreSQL and move Valkey to NVMe

The target is one `bayn` PostgreSQL database in `bayn-db`, two replicas on separate 100G hosts, and both active
Valkey data directories on physical NVMe. Preserve all financial records, arrival bytes, immutable guards,
absolute cache expirations, service identities, TLS, synchronous durability, backups and risk controls.

## Establish the boundary

Capture live database sizes, physical mount identities, free space, replication, current backups and safe broker
readback. Require zero open broker positions and unresolved mutations before stopping execution. Keep the pinned
PostgreSQL image, existing accounts and authentication. Current arrival histories must be compared by capture ID
and exact content before merging. An empty statistics estimate does not mean a table is empty.

Use bounded, owned Argo AppProject deny windows for `bayn` and `bayn-valkey` before merging. Verify neither
Application is already syncing. Block both automatic and manual Bayn application sync while source data is moving:
Kargo can request a manual sync through `argocd-update`. Valkey may separately allow a scoped manual sync of its
reviewed storage change before replacing its claims. Permit the full Bayn rollout only after the merge and final
replica placement are verified. These windows do not change runtime trading authority. Retain the original project resource and remove only
the owned entry when done. Use the reviewed immutable image, Kargo Freight and generated Stage commit for the
application rollout. Do not bump images manually or deploy code from an unreviewed worktree.

## Reconstruct PostgreSQL on NVMe

Use CNPG physical replication and reconstruction, retaining original volumes until the data and replacement
replicas have been verified. The final reviewed manifest remains two instances on Turin and Altra. During this
authorized migration only, apply a temporary three-instance patch while automatic sync is held: permit all three
existing nodes in the host selector and add Ryzen's compute-local toleration. All three copies must retain required
hostname anti-affinity, synchronous `ANY 1` and NVMe data/WAL claims. The temporary third failure domain keeps two
verified durable copies available while an original instance is replaced. Restore final placement before release.

Wait for the new Ryzen instance to catch up and for CNPG to finish any Pod refresh caused by the temporary placement
change. Require three ready instances, phase `Cluster in healthy state`, and matching current/target primary before
promoting Ryzen with the CNPG plugin. Wait for the same stable conditions after promotion. Capture a primary WAL
LSN and require both standbys to replay through it before replacing either one; instantaneous zero lag can race with
ongoing WAL generation. Check required synchronous replication and data continuity. Destroy only the verified former Turin standby instance and its original claim
identities using CNPG's native reconstruction procedure. Retain its original backing volumes until verification.
Verify the replacement claims have new UIDs and class `local-path`, the mounts are physical NVMe and replication
has caught up. Promote Turin, then reconstruct the original Altra standby in the same way. Never destroy the
current primary, two instances together, or an instance whose backup is running. Verify the native identities
before returning to two instances: members 1 and 2 belong on Turin/Altra, member 3 must be a caught-up standby,
and the primary must not be the highest-numbered member that CNPG will remove.

## Merge immutable arrivals

Pause the exact Bayn controller/broker-observation invocations through Restate's administrative pause API, retaining
their invocation IDs and journals for resumption. Gracefully stop every current and retained execution worker that
owns a capture thread. Verify all source writer connections are gone. Fence the source database with
`ALTER DATABASE bayn_native_arrival SET default_transaction_read_only=on` and verify new connections are read-only.
Do not fabricate end markers for captures whose shutdown was incomplete.

Render `services/bayn/operations/unify-native-arrivals` from the reviewed commit and run its bounded Job. It streams
binary COPY over verified TLS without keeping another full dump on disk. The recorder's normal checksum and
ordered-prefix triggers stay enabled. Each capture is verified against its source epoch identity, complete ordered
header-hash manifest and end marker. SQL checksums bind the copied compressed bytes to each retained header.
A retry reconciles the already copied prefix and resumes; it never overwrites differing immutable evidence. Keep
the fenced source and its backup until the unified database has passed actual consumers and backup recovery verification.

Verification reads must succeed before their output is compared. A failed read, including a partial inventory,
aborts the Job without declaring evidence equal or corrupted; preserve the source and copied prefix for a later
verified resume. If the writable Service refuses connections, inspect every primary Pod container, including the
Barman sidecar, and its EndpointSlice readiness. A running PostgreSQL container alone does not establish service
availability or successful WAL archiving. Preserve the reviewed archiver concurrency and resource budget; do not
bypass backup health, readiness, source fencing or immutable checks to keep a copy running.

### Let post-copy maintenance settle before activation

A completed copy is not a settled write path. Insert-triggered autovacuum can still scan and freeze the arrival
table's TOAST storage, generating substantial full-page WAL after the copy workers exit. A slow synchronous
standby then holds commits in `SyncRep`; subsequent broker-publication and controller-status writes can queue on
their transaction locks and exhaust their existing deadlines even when broker HTTP reads succeed. CNPG readiness
and one low-lag sample do not establish application availability.

Before releasing the owned rollout hold, inspect the primary's current vacuum progress, including TOAST relations:

```sql
SELECT p.pid, p.phase, p.relid::regclass AS vacuum_relation,
       COALESCE(parent.oid, relation.oid)::regclass AS owning_relation,
       p.heap_blks_total, p.heap_blks_scanned, p.heap_blks_vacuumed
FROM pg_stat_progress_vacuum AS p
JOIN pg_class AS relation ON relation.oid = p.relid
LEFT JOIN pg_class AS parent ON parent.reltoastrelid = relation.oid
WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database());
```

Let observed bulk-copy maintenance finish naturally and retain its completion evidence. An empty progress view
alone does not prove that pending maintenance has run. Correlate its WAL/full-page-image totals with the existing
`cnpg_bayn_replication_max_flush_lag_seconds`, `cnpg_bayn_replication_max_unflushed_bytes` and
`cnpg_bayn_waits_backends` series. Require the required synchronous standby to remain connected and streaming,
replay through a captured primary WAL LSN, and show sustained replication and commit timings within the retained
pre-migration baseline before activation. Inspect several successive samples and the interval between them,
not only the final sample. Missing measurements or unresolved sustained `SyncRep`/transaction-lock waits leave
this gate unverified. This is an operator verification gate, not an automatic application check.

Do not cancel or disable vacuum, relax synchronous durability or extend application deadlines to pass this gate.
If the workload cannot settle, keep the source, backup and owned hold intact and diagnose the WAL/storage path
with the migration owner. Do not interfere with an ongoing isolated recovery test.

Deliver the reviewed application through normal Kargo and Argo gates only after the data merge and this gate pass. Resume
retained invocations on a compatible deployment and complete the native activation handoff. Verify both PostgreSQL
replicas, durable new arrivals, historical reads/exports, broker materializations, exact reconciliation and accounting.
Compare operation timings with the retained baseline and describe workload differences rather than claiming a
causal speedup from readiness. Preserve original deadlines and record maintenance failures honestly.

## Replace Valkey volumes

Identify the current primary from live replication, not the pod ordinal. RDB and AOF are disabled; old disk files
cannot prove current in-memory contents. Keep one live verified copy throughout. Apply the reviewed storage class
through the owning Application. If its StatefulSet template is immutable, orphan and recreate only that owned
StatefulSet from the reviewed template, preserving its Pods and identity. Replace the replica claim first, leaving
its source volume retained. Verify the new NVMe replica has caught up and its non-expired keys/values/absolute
expirations match. Before replacing a replica, pause the exact controller and broker-observation invocations and
complete a manual BGSAVE on both members. Verify each snapshot succeeded without changing the disabled automatic
persistence policy. Repeat the snapshot on each replacement after replication catches up.

The operator's manual monitor reads the preferred primary from ConfigMap `rf-ha-repl-bayn-valkey`, key `master`,
formatted as `<pod-ip>:6379`. A native FAILOVER alone is reverted by the operator. Verify the ConfigMap's UID,
resource version and current primary address, then update that preference to the caught-up replacement and use
coordinated Valkey FAILOVER. Require the ConfigMap, native replication roles and read/write Service endpoint to
agree before replacing the former primary volume. Restore the original primary ordinal through the same preference
update and coordinated failover after both replacements are healthy. Force application clients to reconnect if they
retain connections to the former role, then resume the retained invocations. Do not change ACLs, flush keys, extend
expirations or enable automatic persistence.

Run the existing full Argo acceptance hook and `dist/valkey-command.js --broker` from API and execution replicas.
Verify a publication-sized write, replica acknowledgement, reads, deletion and expiration. Remove only migration
canaries. Preserve all current application semantics and require both data directories to resolve to NVMe devices.

## Finish

Create a named restore point after the merge and verify its WAL and timeline history are archived. Restore a
completed base backup plus the archived WAL chain to that point in an isolated CNPG cluster. Compare the recovered
capture manifests and financial readback with the unified source, then remove the recovery cluster and its claims.
This verifies that backups recover the newly merged data even when the base backup predates the merge; retain the
normal full-backup schedule and retention policy. Verify both production replicas and actual application behavior,
then retire the fenced archive cluster,
its old claims and only the replaced active Valkey Ceph volumes. Keep the original historical backup retention.
Remove the migration Job/ConfigMap, temporary third instance, owned deny window, diagnostic containers/forwards,
and retained retired local directories or Ceph images after verifying exact identities. Confirm normal GitOps and
operator reconciliation at the exact reviewed and promoted revisions. The task is complete only at this boundary.
