# Unify Bayn PostgreSQL and move Valkey to NVMe

The target is one `bayn` PostgreSQL database in `bayn-db`, two replicas on separate 100G hosts, and both active
Valkey data directories on physical NVMe. Preserve all financial records, arrival bytes, immutable guards,
absolute cache expirations, service identities, TLS, synchronous durability, backups and risk controls.

## Establish the boundary

Capture live database sizes, physical mount identities, free space, replication, current backups and safe broker
readback. Require zero open broker positions and unresolved mutations before stopping execution. Keep the pinned
PostgreSQL image, existing accounts and authentication. Current arrival histories must be compared by capture ID
and exact content before merging. An empty statistics estimate does not mean a table is empty.

Use a bounded, owned Argo AppProject deny window for `bayn` and `bayn-valkey`, with manual sync allowed, before
merging. Verify neither Application is already syncing. The window prevents automatic rollout while source data
is being moved; it does not change runtime trading authority. Retain the original project resource and remove only
the owned entry when done. Use the reviewed immutable image, Kargo Freight and generated Stage commit for the
application rollout. Do not bump images manually or deploy code from an unreviewed worktree.

## Reconstruct PostgreSQL on NVMe

Use CNPG physical replication and reconstruction, retaining original volumes until the data and replacement
replicas have been verified. The final reviewed manifest remains two instances on Turin and Altra. During this
authorized migration only, apply a temporary three-instance patch while automatic sync is held: permit all three
existing nodes in the host selector and add Ryzen's compute-local toleration. All three copies must retain required
hostname anti-affinity, synchronous `ANY 1` and NVMe data/WAL claims. The temporary third failure domain keeps two
verified durable copies available while an original instance is replaced. Restore final placement before release.

Wait for the new Ryzen instance to catch up, then promote it with the CNPG plugin. Check required synchronous
replication and data continuity. Destroy only the verified former Turin standby instance and its original claim
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
the fenced source and its backup until the unified database has passed actual consumers and a fresh backup.

Deliver the reviewed application through normal Kargo and Argo gates only after the data merge succeeds. Resume
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
expirations match. Use coordinated Valkey FAILOVER to promote it, verify service routing and replication, then
replace the former primary volume. Do not enable persistence, change ACLs, flush keys or extend expirations.

Run the existing full Argo acceptance hook and `dist/valkey-command.js --broker` from API and execution replicas.
Verify a publication-sized write, replica acknowledgement, reads, deletion and expiration. Remove only migration
canaries. Preserve all current application semantics and require both data directories to resolve to NVMe devices.

## Finish

Take and verify a fresh unified PostgreSQL backup and current WAL archiving. Compare source capture manifests and
financial readback, verify both replicas and actual application behavior, then retire the fenced archive cluster,
its old claims and only the replaced active Valkey Ceph volumes. Keep the original historical backup retention.
Remove the migration Job/ConfigMap, temporary third instance, owned deny window, diagnostic containers/forwards,
and retained retired local directories or Ceph images after verifying exact identities. Confirm normal GitOps and
operator reconciliation at the exact reviewed and promoted revisions. The task is complete only at this boundary.
