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

The restore rehearsal mounts only a new 20Gi clone from ordinal zero. A default
deny ingress/egress NetworkPolicy isolates it from production, and no service
account token is mounted. The old engine opens the clone on loopback and hashes
Temporal namespace and schema records. The target engine then reads those same
records, rewrites SSTables and verifies every Temporal SSTable, including cell
contents. Both engines drain and stop before the next phase. No original PVC,
credential or cluster destination changes.

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
