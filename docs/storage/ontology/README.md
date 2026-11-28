# Galactic storage Auto Ontology knowledge

[Storage and CNPG knowledge](storage-cnpg-knowledge.json) is the reviewed version 1 glossary and operational guidance
for Galactic's Rook-Ceph storage, CNPG PostgreSQL, and backup and disaster recovery. Rules are database-scoped saved
searches, not enforcement or authorization. There are no custom analyses. Acronym names are global and compared
case-insensitively by the sync tool; check other reviewed and pending bundles before adding a term. Use the existing
`CNPG` identity rather than duplicating it here.

## Source contracts

- **Storage:** The [Rook-Ceph cluster values](../../../argocd/applications/rook-ceph/cluster-values.yaml) and
  [storage classes](../../../argocd/applications/rook-ceph/storageclasses.yaml) define the desired state.
  The [Galactic storage recovery runbook](../../runbooks/galactic-storage-and-workload-recovery.md) sets the recovery
  order, Ceph availability gate, and RBD snapshot and idle-device checks. The [Ceph monitor reference](https://docs.ceph.com/en/umbrella/rados/configuration/mon-config-ref/#storage-capacity)
  gives upstream fullness defaults, not Galactic live settings. Judge capacity by the effective OSDMap ratios and
  the most utilized relevant OSD, not the cluster average.
- **PostgreSQL:** The [Agents CNPG manifest](../../../argocd/applications/agents/postgres-cluster.yaml) declares one
  instance, sets `max_connections: 250`, and configures volume snapshot backup support. `250` is the per-instance
  ceiling, not application pool capacity; reserved slots and overlapping clients reduce available headroom. See
  [PostgreSQL connection settings](https://www.postgresql.org/docs/18/runtime-config-connection.html#RUNTIME-CONFIG-CONNECTION-SETTINGS).
  A [CNPG `-ro` Service](https://cloudnative-pg.io/docs/1.30/service_management/) selects replicas, whereas `-r` can
  include the primary. The [Agents audit guidance](../../agents/ontology/README.md) describes a separate read-only
  access path for the single-instance cluster; it does not provide standby isolation.
- **Backup and DR:** Use the [CNPG restore runbook](../../runbooks/cnpg-postgres-restore.md) for isolated restore and
  application data checks. Its Barman and WAL archive procedure applies where configured, not to every CNPG cluster.
  Ceph-backed volume snapshots and RGW backups on the same Ceph cluster share its failure domain. See also the
  [PostgreSQL cutover runbook](../../runbooks/postgres-18-final-cutover.md) for retaining snapshots and claims through
  rollback.

## Preview and publication boundary

From the repository root with Bun dependencies installed:

```sh
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/storage/ontology/storage-cnpg-knowledge.json --mode dry-run
bun packages/scripts/src/agents/validate-ontology-bundles.ts
```

Dry-run validates the bundle without credentials, HTTP requests, or writes. Keep `dataSource` as `storage`: the sync
tool derives `storage canonical rule` (22 characters), within the [25-character Auto Ontology 1.3.0 tag limit](https://github.com/NVIDIA/auto-ontology/blob/v1.3.0/auto_ontology/server/tags/router.py#L141-L150).
A separately authorized apply requires exactly one approved catalog database named `storage` and one tag named
`storage canonical rule`. This bundle provisions neither and does not connect to a database.
