# CloudNativePG operator

The platform Application renders the upstream `cloudnative-pg` Helm chart, including its CRDs, together with the
separately pinned Barman Cloud plugin. Chart `0.29.2` supplies operator `1.30.2`, which adds Lease deletion to its
existing cluster role. Barman Cloud 0.16.0 supplies the backup operator and the instance sidecar. Explicit PostgreSQL
image pins live in each Cluster manifest.

## Reviewed operator upgrades

Keep `cloudnative-pg` on manual synchronization in the platform ApplicationSet. Before syncing a reviewed revision,
render the entire application and compare resource identities, CRDs, RBAC, operator arguments, images and plugin
resources against the previous render. Preserve existing credentials, webhook enforcement, instance-manager update
mode, storage, synchronous replication and application-specific primary update policies.

The default instance-manager update mode remains a rolling update. The operator waits 30 seconds between cluster
rollouts and five seconds between instance rollouts to spread shared-storage load. These delays do not prevent
single-instance databases from being briefly unavailable or guarantee that different clusters never overlap.
Applications must tolerate reconnects; multi-instance clusters follow their existing restart or switchover policy.

Before an upgrade, record the complete cluster and instance inventory, Ready conditions, current primaries,
PostgreSQL images, instance-manager versions, backup/archiving status, and any pre-existing failures. Retain this
operational evidence privately rather than in this public repository. A historical successful backup status is not
proof of a recent restore test. Avoid interrupting an active backup or an already-degraded database rollout.

After required CI passes and the change is merged, sync only this Application at the exact reviewed main revision.
Do not directly patch operator images, enable broad automatic synchronization, delete CRDs, or recreate databases.
Observe operator readiness and the managed rollout until every expected database instance is Ready on the new
instance manager. Verify unchanged PostgreSQL image and durability configuration, valid primary endpoints, ongoing
replication and application-level recovery independently of the Argo health summary.

Confirm continuous WAL archiving recovers for each plugin-backed Cluster. Verify that new collector samples reach
Mimir and `cnpg_collector_last_collection_error` stays zero on both primary and standby after their restart.

## Recovery boundary

If an operator rollout fails, stop further administrative changes, retain logs and the exact failed revision, and
inspect the responsible operator/instance condition. A source revert and reviewed Application sync can restore the
previous operator release when its compatibility contract permits it; this may require another managed rolling
update. Do not downgrade CRDs blindly or delete retained database state. Diagnose application reconnect failures
separately from persistent database unavailability.

Upstream references:

- [Release notes for 1.30.2](https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.30.2)
- [Barman Cloud plugin 0.16.0](https://github.com/cloudnative-pg/plugin-barman-cloud/releases/tag/v0.16.0)
- [Operator and instance-manager upgrades](https://cloudnative-pg.io/docs/1.30/installation_upgrade/)
