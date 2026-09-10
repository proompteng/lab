# PostgreSQL 18 recovery acceptance

This application owns upgrade recovery artifacts, separately from the Kargo-owned
serving applications. The preparation generation `18-6-v1` requests fresh cold
primary snapshots for `app-db`, `bilig-db`, `coder-cluster`, and `forgejo-db`.
The Backup waves run sequentially. A cold snapshot briefly stops writes to its
primary; no serving image, database claim, service or credential is changed.

The original namespaces retain their snapshots. The dedicated acceptance
namespace starts with ingress and egress denied. Later reviewed phases import
retained snapshot references into this namespace and restore isolated source
clusters before rehearsing CloudNativePG's native PostgreSQL 17.11 to 18.6
upgrade. Do not restore a clone into a namespace with an allow-all policy.

Before using a backup, require completion, a stop time and PostgreSQL major 17.
CloudNativePG 1.30.0 executes the Backup's `online: false` override but writes the
Cluster's default into `Backup.status.online` during finalization. The four
recorded snapshots therefore report `status.online: true` despite being cold.
Require the stronger native evidence instead: each VolumeSnapshot must have
`cnpg.io/onlineBackup: "false"`, a captured `pg_controldata` state of `shut down`,
no required end-of-backup record, and the same start/end/checkpoint WAL. Verify
ready CSI content, original primary and snapshot identities. The source database
logs also record the clean shutdown spanning snapshot creation and its restart.
The source and imported contents use `deletionPolicy: Retain`. Stop if any of
these data or identity checks fail; never accept the request flag alone.

The incorrect status assignment is in [the exact 1.30.0 reconciler](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/pkg/reconciler/backup/volumesnapshot/reconciler.go#L277).
It is corrected on the upstream release branch, but no 1.30.1 release exists at
this preparation. No operator or database status is rewritten by this application.

Keep the source and imported snapshots through production acceptance. Native
restore and upgrade checks must preserve every user database, role, table,
index and sequence, the Bilig logical slot, and required extensions. Only a
separate reviewed serving-image change can activate PostgreSQL 18.6. Barman
backups for Buzz, Jangar and Torghut need their own native restore checks and
new archive server names during major activation; this phase does not change
them.

ApplicationSet owns namespace creation and metadata. This source contains no
Namespace objects, serving Clusters or application credentials. Recovery Pods
and their temporary volumes are removed only after their completed results are
recorded; the original backups remain retained for recovery.


The first recovery phase imports the exact four native CSI snapshot handles into
this namespace and starts one PostgreSQL 17.11 source clone for each. The original
snapshot contents become Retain; no source data claim, serving Cluster, image,
service or credential is modified. The only permitted network paths are DNS,
Kubernetes API control traffic and the CNPG operator's instance-management port.
No application database ingress, production database egress or replica peers are
allowed. Source clones use fresh controller-owned credentials, never production
Secrets. Original snapshot metadata and identities are retained for comparison.

Wait for native recovery, verify the original system identifier and every user
database/schema/table, role, sequence, logical slot and required extension, then
apply the reviewed isolated 18.6 image change. Production major activation remains a
separate step. Recovery from this preparation is to retire the isolated clones;
their original backup handles remain retained.


The four native 17.11 restores passed before the isolated 18.6 activation: all
four original system identifiers, eight databases, 462 relations and 363,342
rows were captured. Row multisets use SHA-256 fingerprints; catalog comparisons
cover tables, columns, constraints, indexes, functions, policies, publications,
roles, memberships, sequence state and large objects. The source inventory hash
is `129ae6aad6445f7a95519dbb4f3130caca4a51801dc2fc2a662639060394be18`.

All sixteen clone-to-production database connection probes were blocked after
positive controls confirmed the four serving endpoints were reachable. The same
network policy and original restored clone PVCs remain through the native
CloudNativePG 17.11 to 18.6 upgrade. The target preserves the Bullseye OS lineage.

Snapshot recovery created standalone clones with no replication slots. It does
not establish production logical-slot continuity. The isolated Bilig clone now
has one `pgoutput` fixture slot, `upgrade_rehearsal_logical`, to exercise native
major-upgrade slot migration. Verify that slot after the upgrade. The serving
`bilig_v2_0_1781844464437` slot remains active and must independently preserve its
identity and resume replication during production acceptance.

After native major upgrade success, compare the captured catalog and data before
applying any generated `update_extensions.sql`, then validate the extension
updates and refresh optimizer statistics. Keep the original snapshots Retain.
If the isolated upgrade fails, revert the clone image to 17.11 and inspect the
native failure; never advance a serving image on an unproven rehearsal.


## Recreating the rehearsal from retained snapshots

Reconcile `argocd/applications/postgres-upgrade-acceptance/phases/recover-17`
first. This is the complete declarative source-recovery application, including
network restrictions, retained snapshot imports and four 17.11 Clusters. Select
that path in the ApplicationSet through Git, then wait for native recovery and
record the source comparison before selecting the root application path for 18.6.
The retained `base` source continues to declare PostgreSQL 17.11.

The root phase has a read-only PreSync gate. A missing Cluster stops reconciliation
with an instruction to use `phases/recover-17`, before any 18.6 Cluster is applied.
The gate requires all four healthy native 17.11 source images and original system
identifiers, or healthy already-upgraded 18.6 instances on repeat reconciliation.
An image request alone cannot pass while native PGDATA is still on another major.
Its token can only get these four Clusters; it cannot modify them or read Secrets.

Do not apply the 17 phase to an already-upgraded live clone as a downgrade. Use it
only for fresh recovery or the documented native failed-upgrade rollback. Keep
retained snapshots when retiring or rebuilding the isolated rehearsal.


The second source-backup generation creates cold primary snapshots for Buzz,
Jangar and Torghut as `*-db-pg18-20260910`, sequentially at waves -16 through
-14. Their PostgreSQL 17.11 images and Barman archives remain unchanged. Before
merging this stage, require each live source Cluster to expose the reviewed
`rook-ceph-block` snapshot configuration and to be healthy on 17.11. Native
Backup health blocks subsequent waves until snapshot completion. The next
reviewed change imports the retained CSI snapshots and creates isolated 17.11
clones; it must not downgrade the four already-qualified 18.6 clones.


The `18-6-v2` restore stage imports the completed cold primary snapshots from
Buzz, Jangar and Torghut into three separate PostgreSQL 17.11 clones. Original
and imported CSI snapshot contents use Retain. Source Cluster, volume, snapshot
and database-system identities are checked before generating the manifests.
Cold-backup evidence comes from the Backup specification and snapshot's native
pg_control metadata: clean shutdown, no required end-of-backup record and the
same start/end WAL. CNPG 1.30's Backup status.online field is not that evidence.

The three clones retain their source OS/image and storage size. They have no
production archive configuration and can reach only DNS and the Kubernetes API;
operator ingress is restricted to port 8000. The existing four 18.6 clones are
unchanged. Require native 17.11 recovery, positive isolation controls and full
data/catalog inventories before the separate reviewed 18.6 rehearsal stage.
