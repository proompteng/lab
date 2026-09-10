# Cassandra upgrade gates

The first production step selects Cassandra 3.11.19 only after generation
`31119-v6` completes its native backup and clone rehearsal. The existing
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
The Job sends `DeleteOptions` as a JSON request body with the pinned image's
curl client, the projected service account token and the cluster CA. Any API
conflict stops the rollout before another ordinal is drained. A real TLS request
test checks the body and a native pinned-image fixture verifies client behavior.
A rerun skips already upgraded, healthy nodes. No force deletion is permitted.

The completed v6 preparation Jobs keep their original, hashed script ConfigMap.
`retained-31119-v6-gate.sh` preserves that exact historical input; only the new
rollout Job consumes the maintained `cassandra-gate.sh`. Changing rollout code
must not mutate or recreate the completed backup and recovery Jobs.
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

## Elasticsearch native backup and recovery

Elasticsearch's shared filesystem repository uses a retained CephFS PVC mounted at
`/usr/share/elasticsearch/snapshots` on every master/data node. Adding `path.repo`
requires a rolling restart of the existing version before repository registration.
Preserve the existing StatefulSet, node identities, data PVCs, service addresses,
credentials and readiness gates. Finish Cassandra rollout acceptance before starting
this independent restart.

The versioned snapshot Job checks the original cluster UUID, three node IDs, source
version and green shard state. It verifies access from all nodes, performs a bounded
native repository analysis, and creates a snapshot with global state and all indices.
It refuses foreign repositories, incomplete snapshots, changed index identities or
failed shards. Receipt files live beside the repository, outside Elasticsearch's
managed repository directory. Failed one-shot Jobs require a reviewed new generation;
never force-replace them or overwrite an existing snapshot.

Before selecting the next Elasticsearch image, restore the native snapshot into an
isolated cluster with the repository mounted and registered read-only. Verify the
source engine, then the target engine, including index mappings, document contents,
feature state and persistent Temporal workflow visibility. A CSI volume snapshot is
not a substitute for Elasticsearch's native distributed snapshot. A successful snapshot
Job is preparation only; it does not establish restore or upgrade acceptance.

Only the production cluster may write to the native repository. Retain it through
later upgrades and recovery. Never start an older Elasticsearch binary on a data
volume already upgraded by a newer version. Keep release-specific version selections,
backup identifiers and acceptance receipts in the PR record; GitOps remains the
current version authority.

Sources: [Elastic shared filesystem repositories](https://www.elastic.co/guide/en/elasticsearch/reference/8.5/snapshots-filesystem-repository.html),
[repository analysis](https://www.elastic.co/guide/en/elasticsearch/reference/8.5/repo-analysis-api.html),
[Temporal Visibility compatibility](https://docs.temporal.io/self-hosted-guide/visibility).


The first Elasticsearch repository analysis failed before snapshot creation:
a node read zero bytes immediately after another node completed a blob write.
Generation `81921-v2` uses a dedicated retained CephFS claim with `wsync` and
`noshare`. Ceph documents `wsync` as waiting for MDS replies before completing
namespace operations; `noshare` gives this mount its own client instance. This
isolates the repository setting from every existing filesystem consumer. The
original empty repository claim remains retained. The Job verifies its actual
mount options before running the unchanged strict three-node analysis. The
mount configuration is accepted only when that analysis and native restore pass.

Source: [Ceph mount options](https://docs.ceph.com/en/umbrella/man/8/mount.ceph/).
The failed first Job is retired through GitOps; its failure evidence is preserved
in the upgrade record. Serving data claims, identities, authentication and the
Elasticsearch image remain unchanged during the replacement repository mount.


Generation `4112-v1` prepares the Cassandra 3.11.19 to 4.1.12 transition with a
fresh native snapshot, retained CSI clones and isolated old/target engine checks.
Its Jobs and script ConfigMap have separate identities, preserving the completed
3.11.19 recovery and rollout records. Production stays on the accepted 3.11.19
image until this generation passes and a separate activation is reviewed.

Cassandra 4.1 and 5.0 disable native SSTable verification without an explicit
`--force` opt-in. The rehearsal enables that verifier only on its disposable,
isolated clone, with extended cell verification and without repair-status mutation
or disk-failure-policy flags. This does not force-delete or verify serving Pods.
The completed v6 rehearsal retains its exact original script ConfigMap.


The synchronous CephFS repository also failed the native three-node analysis:
a completed 1 MiB write was followed by a zero-byte ranged read on another node.
Neither filesystem generation contains an accepted native snapshot. Generation
`81921-v3` therefore uses a dedicated Rook ObjectBucketClaim on the existing
retained `rook-ceph-bucket` class and the existing internal RGW endpoint. The
operator creates credentials scoped to this new bucket; existing application
accounts and secrets are unchanged. Helm maps the generated secret keys into the
Elasticsearch keystore without placing their values in Git or Job logs.

Rollout order is bucket provisioning, same-version serial Elasticsearch restart
to load the S3 client, unchanged strict three-node repository verification and
analysis, then a native all-index/global-state snapshot. The Job verifies the
original cluster, node and index identities, requires every shard to succeed,
and makes the completed repository read-only before issuing its receipt in the
retained Job log. Its credentials are not mounted in the snapshot Job. The next
acceptance step copies that frozen repository and restores it on isolated native
8.5.1 and 8.19.21 engines before any production version change. Serving data
claims, replica count and image version remain unchanged. Old filesystem claims
are retained; their failed Jobs are retired through GitOps.

Recovery before the version change is to revert this S3 client configuration;
the original data and retained snapshot bucket are unaffected. An analysis or
snapshot failure blocks activation and requires diagnosis, never a weaker gate.

Sources: [Elastic 8.5 S3 repository](https://www.elastic.co/guide/en/elasticsearch/reference/8.5/repository-s3.html),
[Rook bucket claims](https://rook.io/docs/rook/latest/Storage-Configuration/Object-Storage-RGW/ceph-object-bucket-claim/).


The `4112-v1` backup completed, but its restore parser rejected Cassandra
3.11.19's native manifest paths such as
`.cm_lastheartbeat_idx/me-199-big-Data.db`. No engine was started. The maintained
parser now selects the source-version manifest contract: the legacy 3.11.5
index-manifest behavior remains separate, while 3.11.19 and later require an
exact list of all base and relative index SSTables. Both paths still reject
traversal, symlinks, orphan components, missing components and checksum failures
before producing a receipt. Generation `4112-v2` takes fresh snapshots and uses
new isolated restore volumes. The completed old Jobs retain their exact script
ConfigMaps; the failed v1 rehearsal is retired through GitOps. No serving image
changes in this preparation.


Rook shortens long generated bucket prefixes to leave room for its UUID suffix.
The bound claim is `08964464-26f3-4faa-a512-25b5571cb38e`; generation `81921-v4`
checks its exact observed bucket name `temporal-elasticsearch-sna-e20960d4-5f87-4682-98f4-254ab958b39e`
instead of assuming the requested prefix survives unchanged. A changed or recreated
bucket fails closed and requires an updated reviewed binding.

The chart keystore initializer receives the same existing bootstrap password Secret
reference as Elasticsearch. It adds `bootstrap.password` before copying the complete
keystore to its volume. Otherwise the native entrypoint tries to add the missing key
by replacing the mounted subPath file, which fails with `Device or resource busy`.
This correction rolls the Pods on the same 8.5.1 image and original data claims.
The S3 account, endpoint, bucket and application credential remain the same.


Generation `81921-v5` waits up to five minutes for the original three-node source
to become green and finish loading the reviewed S3 client configuration before
any repository write. Argo's selective apply can skip an unchanged StatefulSet
while its Pods are still rolling; sync completion alone is not this prerequisite.
Version, cluster identity, node identity and a conflicting S3 endpoint still fail
immediately. The final post-snapshot source check remains strict. The same Job
request deadline, native repository analysis and frozen-snapshot checks apply.
The failed v4 Job stopped at the initial two-node health check before registering
the S3 repository or taking a snapshot; its failure was captured before retirement.


Generation `4112-v2` passed the native 3.11.19 source recovery and extended
SSTable verification, then its 4.1.12 engine exited during startup. A separate
native 3.11.19 to 4.1.12 fixture reproduced `Cannot change the number of tokens
from 256 to 16`; setting `CASSANDRA_NUM_TOKENS=256` preserved the complete token
set and host identity. The maintained rehearsal now pins that existing vnode
count, checks all 256 tokens before and after the upgrade, and emits the full
engine log on failure. Its proof directory uses a retained 1 GiB PVC so native
receipts survive Pod cleanup. Generation `4112-v3` uses fresh snapshots and new
data/proof volumes; the partially converted v2 volume is never opened by an
older engine. Existing completed Jobs retain their original script ConfigMaps.
The serving Cassandra image and template remain unchanged in this preparation;
the later production activation must also preserve `CASSANDRA_NUM_TOKENS=256`.


## Elasticsearch 8.19.21 activation

The exact 8.5.1 native S3 snapshot `before-81921-v5` restored successfully with
all eight indices/global state in an isolated 8.5.1 engine, then upgraded in
place to the pinned 8.19.21 image. All 832 accessible original documents,
including 759 Temporal visibility documents, retained their source hashes.
Every restored index retained its identity and field definitions. The reserved
GeoIP index retained every immutable Lucene file checksum; its mapping metadata
advanced to the exact upstream 8.19.21 descriptor (`version=8.12.0`, managed
mapping version 1). Native deprecation logging added compatible ECS fields and
one diagnostic document. Both engines reached green and stopped cleanly. The
fixture had no network access or production credentials and used a read-only,
checksum-verified copy of the frozen S3 repository.

Activation takes a fresh `before-81921-v6` native snapshot before applying the
new image. Its separate repository `temporal-s3-native-81921-v6` uses the sibling
prefix `temporal-81921-v6` in the same verified bucket/client. The previously
rehearsed `temporal-s3-native` repository remains frozen and untouched. The new
snapshot Job runs at sync wave -5, before the StatefulSet at wave 0; any missing
source node, wrong identity, native analysis issue or incomplete snapshot blocks
the image rollout. It freezes the new repository after all-index/global-state
snapshot acceptance. The serving StatefulSet retains its rolling-update policy,
all three original PVCs, existing credentials and S3 configuration; the same
pinned target image is used by its keystore init and serving container.

After normal GitOps rollout, require all three original node IDs and PVC UIDs,
the original cluster UUID, version 8.19.21 on every node, green health with no
unassigned or moving shards, preserved Temporal visibility index identity and
documents, and native Temporal history/query plus a completed fresh workflow.
Keep all retained native snapshots. Elasticsearch data files are not safely
downgraded after new-version writes; recovery uses a validated retained native
snapshot in a separate compatible cluster before a reviewed cutover, accounting
for writes after the recorded snapshot checkpoint.
