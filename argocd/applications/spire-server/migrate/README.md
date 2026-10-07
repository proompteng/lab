# SPIRE SQLite to PostgreSQL

This one-time utility uses SPIRE 1.15.3's own SQL plugin to initialize the PostgreSQL schema. It imports every table
from an offline SQLite snapshot, checks table and column compatibility, verifies every row, and resets PostgreSQL
sequences before committing a single transaction. Binary bundle/authority data, registration IDs, selectors, and
attested agent records are copied. PostgreSQL timestamps have microsecond precision; finer SQLite timestamps are
rounded to that precision. Signing keys remain on each SPIRE server's retained PVC and are not handled by this tool.

The destination must be a new database with no public tables. This intentionally refuses reruns against a live or
previously initialized database. A failed import rolls back the data transaction but can leave an empty initialized
schema; recover using another verified empty database rather than truncating a live database. Keep the offline
snapshot and signing-key backup for recovery. Never run while any server writes either datastore.

## Build and test

Use the repository Go toolchain and disable the root workspace for this independent module:

```sh
cd argocd/applications/spire-server/migrate
GOWORK=off go build -ldflags='-X github.com/spiffe/spire/pkg/common/version.gittag=1.15.3' -o /tmp/spire-migrate .
GOWORK=off go test -ldflags='-X github.com/spiffe/spire/pkg/common/version.gittag=1.15.3' ./...
```

For the integration test, supply `SPIRE_MIGRATION_TEST_DSN` for a disposable PostgreSQL instance whose user can
create databases. The test creates and deletes its own database, initializes real SPIRE SQLite tables, verifies
binary trust data, timestamps, attested agents, registrations, selectors, and sequence counters, and rejects an
attempt to overwrite the populated target. CI runs this against PostgreSQL 18.6.

## Cutover order

1. Merge and reconcile the database preparation changes while SPIRE still uses SQLite with one server. Require
   three ready `spire-db` instances on distinct nodes, synchronous replication, and a successful volume-snapshot backup.
2. Build this utility before the maintenance window. Prepare the separate reviewed HA configuration change, but
   keep it unmerged until the data transfer is verified. Confirm `spire-db-rw` TLS using `spire-db-ca/ca.crt` and
   use the CNPG-generated `spire-db-app` credentials without printing them or storing them in Git.
3. During an explicitly authorized maintenance window, suspend automated reconciliation for the SPIRE Application
   and stop the existing SPIRE server. Record the original PVC and keep the complete `proompteng.ai` data directory,
   including SQLite WAL files and signing keys, in an access-controlled backup or retained Ceph snapshot. Do not
   delete the original PVC, replace its mount, or reset the trust domain.
4. Create a consistent offline SQLite snapshot with SQLite's backup API, not a copy of an open database file. Run
   this utility from an operator environment with access to the database and snapshot:

   ```sh
   /tmp/spire-migrate -source /secure-backup/datastore.sqlite3
   ```

   Supply `SPIRE_MIGRATION_DSN` through the existing secure operator environment. Use `sslmode=verify-full`, the
   CNPG CA file, `dbname=spire`, and the `spire-db-rw.spire-server.svc.cluster.local` endpoint. Do not put the DSN on
   the command line. The tool suppresses driver errors because they can contain credentials or row contents.
5. Only after the import commits and is verified, merge and reconcile the reviewed three-server HA change.
   Preserve `spire-server-0`'s existing data volume and `proompteng.ai` subdirectory. Each added server gets its own
   signing-key PVC; all three share PostgreSQL. Restore automated reconciliation and run the SPIRE verifier through
   at least two rotation windows. Exercise both application gRPC hops and the authenticated desktop.
6. In the authorized verification window, interrupt one SPIRE server and test renewal through another, then perform
   a CNPG primary switchover and repeat renewal and application requests. Readiness alone does not prove HA.

Certificate issuance is paused during the import. Existing two-minute SVIDs may expire if the window runs long;
agents must re-attest and application streams can reconnect. This is not a zero-downtime migration.

## Recovery

Before allowing PostgreSQL-backed issuance, a failed import can be recovered by restoring the original one-server
SQLite configuration and complete original data mount. After PostgreSQL-backed issuance starts, do not point a
server at the stale SQLite snapshot: it will lack newer agents, registrations, and CA material. Prefer restoring
PostgreSQL and the matching per-server signing-key volumes, or roll back to one server while retaining PostgreSQL.
Retain the original SQLite and key backup until HA renewal, failover, and database restore have been demonstrated.
