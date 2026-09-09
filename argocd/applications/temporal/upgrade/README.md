# Cassandra upgrade gates

Production remains on Cassandra 3.11.5 while the preparation runs. The existing
RF3 keyspace and repaired ring remain serving. The retained RF3 snapshots survive
the removal of completed repair Jobs and RBAC.

The versioned snapshot Job first verifies original StatefulSet/PVC identities,
three original host IDs, normal ring state, schema agreement and RF3. It flushes
and snapshots every node with Cassandra's native snapshot command. Argo creates
three retained VolumeSnapshots only after that Job succeeds. A read-only Job
verifies their generation, source claims and creation times before the clone is
created. A failed snapshot attempt requires a new reviewed generation; Argo must
not replace active or failed one-shot Jobs.

The restore rehearsal mounts the CSI clone read-only in a restore init container.
It restores only the requested native snapshot's base and index SSTables into a
separate empty 20Gi data PVC. Every listed component must exist, each Data.db CRC32
must match its native digest, copied files are flushed, and cluster identity/schema
and all 18 Temporal tables must be present. Live table files and commit logs outside
that named snapshot are excluded. The snapshot Job also flushes the source filesystem
before CSI snapshots are created.

A default deny NetworkPolicy isolates the rehearsal from production. Neither engine
mounts the source snapshot or a service account token. The old engine opens only the
restored data on loopback and hashes Temporal namespace/schema records. The target
engine then reads those same records, rewrites SSTables and verifies every Temporal
SSTable, including cell contents. Both engines drain and stop before the next phase.
No original PVC, credential or cluster destination changes.

After the rehearsal passes, a separate reviewed activation selects the pinned
3.11.19 image and adds a narrowly scoped rolling Job. It drains and replaces one
ordinal at a time using Kubernetes UID and resourceVersion deletion preconditions,
waits for the original three UN host IDs, and verifies the original PVC bindings.
A rerun skips already upgraded, healthy nodes. No force deletion is permitted.
Schema agreement is checked after all nodes reach the target: Cassandra 5 adds
schema properties and legitimately advertises different hashes during a rolling
upgrade. SSTable conversion completes before the next major release is selected.

The full path is 3.11.5 → 3.11.19 → 4.1.12 → 5.0.9. Each step requires a new
snapshot generation, native restore rehearsal and persistent Temporal workflow
acceptance. Cassandra 5 must retain compatible table compaction strategies; the
current Temporal tables use LeveledCompactionStrategy or SizeTieredCompactionStrategy.

Recovery requires stopping the upgrade before another node is changed and
restoring the retained snapshot clones into an isolated rehearsal first. Do not
point an older binary at files rewritten by a newer major release. Retain both
the prior engine images and the snapshot/PVC identities in the acceptance record.
The Temporal Application reconciles this reviewed infrastructure desired state
from main. Its ordinary application workloads and schema remain unchanged during
preparation; no direct production image apply is used.

Sources: [Apache 4.1 release notes](https://github.com/apache/cassandra/blob/cassandra-4.1.12/NEWS.txt),
[Apache 5.0 release notes](https://github.com/apache/cassandra/blob/cassandra-5.0.9/NEWS.txt),
[Kubernetes conditional deletion](https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-deletion).

Kustomize must set `namespace: temporal` before resolving generated ConfigMap
names. Argo destination namespace injection happens afterward and cannot repair
those references. CI renders this application and checks every Cassandra Job's
ConfigMap reference against its rendered namespace and name. Preparation `31119-v1`
never started because its script ConfigMap reference did not resolve; generation
`31119-v2` replaces that unused Job and performs the complete backup sequence.

Generation `31119-v2` stopped before either database engine opened the clone:
kubectl selected its image default endpoint, and the API endpoint was an invalid
network isolation probe because Kubernetes permits local-node traffic. Its CSI
snapshots and clone remain explicitly retained but are not accepted native backups.

Generation `31119-v3` configures kubectl explicitly from its projected service
account token file and CA. The rehearsal has its own verification init container,
so a selective Argo retry cannot skip the backup gate. Only that init container
mounts the token; neither Cassandra engine does. Its NetworkPolicy permits only
the existing Kubernetes API addresses and ports for metadata verification. The
init container also proves all three production CQL endpoints respond with their
original host IDs. Before opening data, each engine waits for policy convergence
and requires three consecutive denied probes to those actual data endpoints.
An unexpected reachable endpoint, stale snapshot, failed native backup or changed
identity prevents the engine from starting. The API is not used as an isolation
proxy. Production listeners remain separate from the loopback-only clone engine.

Generation `31119-v3` completed native snapshots and verified the restored data
with Cassandra 3.11.5, including extended SSTable verification and a clean drain.
The 3.11.19 container stopped before opening the database because this official
image provides `python2` without a `python` alias. Generation `31119-v4` selects
that bundled interpreter explicitly and reports a missing interpreter before
starting an engine. Its fresh backup and isolated clone run the same native data,
identity and network checks. The v3 snapshots and clone remain retained; the
failed target run does not satisfy production rollout acceptance.

Generation `31119-v4` exposed a restore error: the rehearsal booted the CSI clone's
live directory, where a post-snapshot `tasks` SSTable failed its checksum. That file
was absent from the native snapshot manifest, and its original production copy
passed CRC32 verification. The original RF3 ring and persistent Temporal workflow
remained healthy. Generation `31119-v5` restores the actual native snapshot into a
separate data volume and verifies its checksums before either engine starts.
The failed v4 clone remains retained; its failure is not hidden or accepted.

Generation `31119-v5` stopped before copying data or starting either engine because
its identifier validator rejected the legacy `system.IndexInfo` table. Generation
`31119-v6` preserves case-sensitive Cassandra table names while retaining the strict
UUID suffix, path, manifest and component checks. A regression restores `IndexInfo`
with its original capitalization. The v5 snapshots and unused data PVC remain retained.

The real v5 snapshot also exposed Cassandra 3.11.5's secondary-index manifest
behavior: `ColumnFamilyStore.snapshotWithoutFlush` writes each index's filenames
to its parent table's `manifest.json`. The two `cluster_membership` index directories
therefore have manifest filenames different from the base table. V6 restores all
base and secondary-index SSTables inside the exact immutable snapshot directory.
The manifest must match one complete base/index group; every SSTable still requires
its full TOC, native checksum, regular components and safe paths. Unmatched manifests,
orphaned components, nested directories and symlinks fail before copying begins.
Files outside the native snapshot remain excluded. This preserves secondary indexes
without inventing a manifest or silently discarding base-table data.

Source: [Apache Cassandra 3.11.5 snapshot implementation](https://github.com/apache/cassandra/blob/cassandra-3.11.5/src/java/org/apache/cassandra/db/ColumnFamilyStore.java).
