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

Before using a backup, require its actual status to report `completed`, a stop
time, PostgreSQL major 17 and `online: false`. Verify every resulting
VolumeSnapshot is ready, its source claim UID matches the recorded primary and
its retained content exists. A request with `online: false` alone is not proof
of a cold snapshot. Stop if any native backup evidence differs.

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
