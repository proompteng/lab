# PostgreSQL 18 rollout: App, Bilig, Coder and Forgejo

This change upgrades only `app/app-db`, `bilig/bilig-db`,
`coder/coder-cluster` and `forgejo/forgejo-db` from 17.11 to 18.6 using the
same Bullseye base. CloudNativePG 1.30 owns the offline native `pg_upgrade`.
Expect a brief database outage and client reconnection for each cluster.
The primary data PVC and credentials remain in place; CNPG rebuilds Coder's
standby using its normal major-upgrade procedure.

## Evidence before activation

PRs #14461 and #14463 produced retained cold volume snapshots and restored
all four original PostgreSQL system identifiers into isolated clones. Native
network probes verified those clones cannot reach any production database.
PR #14466 upgraded those clones with the exact target image. All 363,342 row
fingerprints, sequence values, large objects, existing constraints, indexes,
functions, roles and memberships were preserved across eight databases.
The 462 user relations retained their identities. PostgreSQL 18 added 1,693
catalog entries for existing NOT NULL columns; one explicit owner-default ACL
became NULL with exactly the same effective grants. A native pgoutput logical
slot retained its identity/configuration with an advanced confirmed LSN.
All installed extensions are current and native analyze-in-stages completed.

## Rollout and acceptance

1. Merge after exact-head CI and review. Kargo discovers the changed App,
   Bilig and Forgejo desired state and promotes it through their normal Stages;
   Coder follows its existing main GitOps source. Do not manually sync an image
   release or edit generated Kargo branches.
2. Each Application creates a new `*-pg18-final-20260909` cold primary Backup
   at sync wave -10. The existing Argo health customization for CNPG Backup
   remains Progressing until `status.phase=completed` and `stoppedAt` exists,
   and reports failed backups as Degraded. Thus the new target Cluster image
   at wave 0 is withheld until the fresh backup completes. Existing retained
   backups are not pruned. This activation assumes the existing healthy source
   cluster; use the source recovery phase before a restoration or fresh install.
3. Verify each new snapshot is Ready, belongs to the expected source Cluster
   and primary PVC, records `cnpg.io/onlineBackup=false`, and contains a clean
   shutdown PostgreSQL 17 control record. CNPG 1.30's Backup `status.online`
   incorrectly reflects the cluster default; the native snapshot annotations
   and control record establish the actual cold-backup method.
4. Require native PostgreSQL 18.6, every expected database/role, the original
   primary PVC and credential identity, no prepared transactions, valid indexes,
   and successful read/write transactions. Require both Coder instances healthy.
   Verify App database-backed requests, Bilig Zero's original active pgoutput
   slot and a real workbook query/mutation/reconnect, Coder database access, and
   Forgejo authenticated repository access before accepting the rollout.

## Recovery

Stop further upgrades on a failed native check. Preserve the original data,
all Backup/VolumeSnapshot objects, their contents, and the isolated rehearsal
clones. PostgreSQL major upgrades are not reversed by changing the image tag:
after PostgreSQL 18 writes, an older binary must never open those files.
Restore the retained original 17.11 cold snapshot to a separate compatible
cluster/PVC, verify its native identity and data, and make any recovery cutover
through reviewed GitOps with the same credential account. A restore returns to
the snapshot's recorded checkpoint; account for any subsequent acknowledged
writes before a recovery cutover. The final cold snapshots are taken directly
before each production upgrade to minimize that recovery interval.
