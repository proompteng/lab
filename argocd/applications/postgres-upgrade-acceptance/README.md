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
review the isolated 18.6 image change. Production major activation remains a
separate step. Recovery from this preparation is to retire the isolated clones;
their original backup handles remain retained.
