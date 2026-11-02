# Final PostgreSQL 18.6 cutover

Upgrade Buzz, Jangar and Torghut through their normal main build, Kargo promotion
and Argo paths. Keep Buzz on the Debian trixie image and Jangar/Torghut on
bullseye. Change each image and Barman server name together, as required by the
[CloudNativePG major-upgrade procedure](https://cloudnative-pg.io/documentation/current/postgres_upgrades/).
The old archive prefixes remain available for pre-upgrade recovery.

| Cluster            | Instances | Original system ID  | PostgreSQL 18 archive server |
| ------------------ | --------- | ------------------- | ---------------------------- |
| buzz/buzz-db       | 3         | 7665590635531415571 | buzz-db-pg18                 |
| jangar/jangar-db   | 2         | 7615764848397791261 | jangar-db-pg18               |
| torghut/torghut-db | 2         | 7615765590556864543 | torghut-db-pg18              |

## Qualification and checkpoints

The same retained cold snapshots were restored independently into PostgreSQL
17.11 comparison copies and copies upgraded natively to 18.6. Full SHA256 row
multisets match across 79,233,549 rows, 18 databases and 1,173 relations. The
comparison also checks database/role/relation identities, effective grants,
functions, columns, constraints, indexes, sequences, large objects, publications
and logical slots. Function OIDs are recreated by PostgreSQL; their complete
logical signatures, definitions, owners and ACLs are compared.

PostgreSQL 18 prints some varchar-array CHECK expressions differently. All 71
changed definitions were reparsed on empty temporary LIKE tables by the native
18 engine, compared in full, then rolled back. Native `acldefault` and
`aclexplode` distinguish equivalent default ACL representations from lost grants.

Each production application adopts its already completed
`<cluster>-pg18-final-20260910` cold primary Backup. All three checkpoints were
completed on September 10 between 08:57 and 08:59 UTC. Require the same retained
Backup and snapshot UIDs, ReadyToUse content, source major 17, native pg_control
state `shut down`, no required end-of-backup record, and equal start/end WAL.
CNPG 1.30's `Backup.status.online` does not establish whether these are cold;
use the Backup specification and snapshot's native control metadata.

## Rollout and metadata preservation

CNPG shuts down each database cluster for the in-place major upgrade. Preserve
its Cluster UID and primary PVC, and allow the operator to rebuild its standbys.
PostgreSQL creates a new system ID and resets its timeline. Record those native
values before accepting any new WAL archive or executing the metadata repair.

The native rehearsals exposed three metadata changes that need correction:

- Buzz's `pgcrypto` extension owner changes from `buzz` to `postgres`.
- Jangar's `pg_trgm` extension owner changes from `jangar` to `postgres`.
- In `torghut_sim_default`, `torghut_app` loses its original SELECT and UPDATE
  grants on `public.torghut_meta_id_seq`.

Capture and verify those owners/grants on the serving PostgreSQL 17 databases
before activation. After native 18.6 is healthy, run
[scripts/cluster-upgrades/postgres-18-preserve-metadata.sql](../../scripts/cluster-upgrades/postgres-18-preserve-metadata.sql)
against only those three database names. Pass `expected_database` and
`expected_system_id` as psql variables, using the new native system ID verified
against the original Cluster UID. The SQL rejects an unexpected database,
version, system ID, extension owner, ownership dependency or sequence owner.
It is transactional and idempotent. Native rehearsal tests reproduce each
metadata difference, verify repair and rollback, and reject a wrong system ID.

[PostgreSQL's extension-ownership limitation](https://www.postgresql.org/message-id/24250.1566500938%40sss.pgh.pa.us)
requires restoring both the `pg_extension` owner and its `pg_shdepend` ownership
record. Extension member ownership and privileges remain intact. The sequence
repair grants exactly the two privileges present before the upgrade.

Upgrade installed pgcrypto to 1.4 and pgvector to 0.8.6 after comparing the
pre-update catalogs. Verify SHA256 and AES256 round trips, trigram comparisons,
and an actual HNSW index scan with exact nearest-neighbor/L2 results. Roll back
temporary vector fixtures. Analyze the upgraded databases in stages. Preserve
`torghut_notebook` membership in `pg_read_all_data` and its connection limit of 4.

Accept each production upgrade only after all configured instances report native
18.6, original roles/grants and application connections work, replication is
healthy, and a fresh native backup plus forced WAL archive succeeds under its
new server name. Keep both old and new archive prefixes and all retained cold
snapshots. Preserve Bayn's existing execution authority throughout.

## Recovery

If an upgrade fails, stop subsequent activations and retain the failed native
job, logs, snapshots and all original claims. Before the new server starts,
follow CNPG's documented failed-upgrade recovery. Once PostgreSQL 18 has written
to the converted files, recovery requires the retained PostgreSQL 17 backup and
its matching old archive into a separate cluster. Do not run a 17 image over the
converted data directory or force-delete PVCs, PVs or VolumeAttachments.
