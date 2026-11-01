# Ofz and Keycloak recovery storage

The private Ceph object gateway stores the `ofz-audit`, `ofz-database-backups` and `keycloak-database-backups` buckets.
The production NUC recovery service is retired. Omni storage and backups on NUC are separate and remain unchanged.

The audit bucket uses versioning and ninety-day COMPLIANCE retention. Database buckets use versioning, thirty-day
COMPLIANCE retention and Barman's thirty-five-day recovery window. Each writer has access only to its own bucket.
The custodian credentials are retained in the `ofz-recovery-owner` namespace-scoped SealedSecret; workloads do not
mount them. Writers use their existing Secret names with Ceph credentials.

This target uses the existing internal Ceph S3 endpoint over HTTP, without SSE or a new key manager. Backup and live
database storage share the same Ceph failure domain. These copies support database recovery while that Ceph cluster
is available; they are not an independent disaster-recovery copy.

## Migrate the retained NUC objects

Run the reviewed `services/ofz/migrate_recovery.py` with Python, boto3 and psycopg from an authenticated operator workstation.
It reads NUC credentials over the existing SSH identity and never prints credentials. Destination credentials and the
version ledger stay in a private `/tmp/ofz-ceph-recovery` directory. Retain that directory until cutover is verified.

```sh
python3 services/ofz/migrate_recovery.py inventory
python3 services/ofz/migrate_recovery.py provision
python3 services/ofz/migrate_recovery.py seal-owner
python3 services/ofz/migrate_recovery.py copy
python3 services/ofz/migrate_recovery.py verify
python3 services/ofz/migrate_recovery.py rebind-audit
```

Every source object version is copied in creation order, read back by its new Ceph version ID, and checked against
the original SHA-256 and retention deadline. The ledger permits retries without creating another copy of completed
versions. The three source inventories contain no delete markers; the migration rejects them before copying.
Reconcile the final source inventory before retiring its writer. Update persisted audit archive receipts
to the verified Ceph version IDs with `rebind-audit`, which holds the exporter's SQL advisory lease. It ends only
the old exporter sessions using that same SQL role. Preserve acknowledgement times,
sequence numbers, original receipts and payload hashes.

Reconcile the reviewed backup ObjectStores and exporter through GitOps. Require successful new physical backups,
current WAL archiving, a current verified audit checkpoint, and an isolated restore. Verify Ofz policy access and
real Tengri file, terminal and chat operations before declaring recovery complete.

Only after those checks, stop the old `ofz-recovery-archive-1` container, remove its dedicated Tailscale port 9444,
and remove `/var/lib/ofz-recovery` and the old `ofz-releases` source archives from NUC. Do not remove Omni, image-factory,
other containers or their data. Preserve the Ceph custodian Secret and its version ledger as the cutover evidence.

Store the final version ledgers in `ofz-audit/migration-receipts/2026-10-25-nuc-to-ceph/` with COMPLIANCE retention.
An Ofz database backup taken before receipt rebinding contains the old object version IDs. After restoring such a
backup, use that ledger and `rebind-audit` before starting Ofz consumers. This mode requires only Ceph and SQL access;
it does not contact NUC. Put the audit writer credentials from `ofz/ofz-audit-archive` under the `ofz-audit-export` key
in the private `destination-identities.json`. Version reads use the writer because the bucket custodian does not own
versions created by that writer. Take the final Ofz qualification backup after receipt rebinding, then restore that exact backup ID to
verify that new backups contain the Ceph receipt bindings.
