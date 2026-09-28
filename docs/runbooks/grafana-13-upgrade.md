# Grafana 13 upgrade

Grafana 13 migrates dashboards and folders to unified storage. Downgrading the
binary after that migration does not restore the old database state. Require
a verified backup and restore rehearsal before changing the production image.

The production target is Grafana 13.2.1 with community chart 13.2.2. Pin the
image digest and install these compatible plugin versions synchronously before
startup: Traces Drilldown 2.2.0, Logs Drilldown 2.5.2, Metrics Drilldown 2.5.1,
and Profiles Drilldown 2.3.0. Keep the existing `tempo`, `loki`, and `prom`
datasource UIDs and endpoints.

Grafana 13 can update bundled datasource plugins during startup. Keep the
container filesystem read-only and use the chart's `shadowBundledPlugins`
option, with every bundled plugin explicitly listed and version-pinned in
`plugins`. This installs them on the existing writable plugin volume. Preserve
all thirteen bundled datasource IDs, including the active Loki, Prometheus,
and Tempo providers; shadowing without that complete inventory removes them.
Pin the Advisor app as well to avoid untracked default plugin updates.

## Snapshot and restore rehearsal

Merge the preparation resources while production still runs Grafana 12.3.1.
Record the source PVC UID, the current Git revision, and the current dashboard,
datasource, organization, and user inventories. Configuration and provisioning
are reproducible from that Git revision and the existing Secret references.

The versioned VolumeSnapshot retains the entire Grafana volume, including
plugins. Its separate restore PVC must become Bound before the rehearsal Job
can start. The production volume is never mounted by this Job. On the restored
clone, SQLite recovers any captured journal or WAL; its backup API creates an
independent database file. Full integrity checks and protected entity IDs must
match after copying that file into a separate restore directory.

The Job starts the exact old Grafana image against that copy. Alerting, update
checks, and plugin preinstallation are disabled for the rehearsal, and its
NetworkPolicy denies network ingress and egress. Native startup must complete,
`/api/health` must report database `ok` and version `12.3.1`, and the protected
entity inventories must remain unchanged. The Job then exits and Kubernetes
stops its native sidecar.

Require the snapshot `readyToUse`, the same source PVC UID, a completed Job,
and the persisted `grafana-before-13-2-1/{grafana.db,backup.json,runtime-restore.json}`
artifacts on the restore PVC. A partial or modified backup fails closed; never
overwrite it to manufacture a successful gate. The versioned Job remains
completed instead of repeating the backup on unrelated application syncs.

## Production rollout and acceptance

Upgrade to Grafana 13.2.1 only after the rehearsal passes. Preserve the live
PVC and datasource UIDs. Update installed plugins for React 19 compatibility;
the removed in-process image renderer must not be configured. Roll one Grafana
instance, then verify completed unified-storage migration, the original
dashboard and datasource UIDs, and real Mimir, Loki, and Tempo queries through
Grafana. Native readiness alone does not establish these results.

Keep the snapshot and restore PVC retained after removing the temporary Job
and its NetworkPolicy. If recovery requires the old binary, restore the
verified pre-upgrade database and corresponding Git configuration together;
preserve the failed upgraded volume for inspection. A rollback to the snapshot
does not include changes made after the snapshot was taken.

Sources: [Grafana 13 migration](https://grafana.com/docs/grafana/latest/upgrade-guide/upgrade-v13.0/)
and [SQLite backup API](https://www.sqlite.org/backup.html).
