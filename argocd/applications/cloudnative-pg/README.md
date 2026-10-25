# CloudNativePG operator

The platform Application renders the upstream `cloudnative-pg` Helm chart, including its CRDs, together with the
separately pinned Barman Cloud plugin. Chart `0.29.1` supplies operator `1.30.1`, including the PostgreSQL 18 WAL
collector fix for a null `stats_reset` value (upstream #11207). PostgreSQL operand images and plugin images remain
owned by their existing manifests; an operator patch upgrade must not change them implicitly.

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

For the WAL collector fix, confirm `cnpg_collector_last_collection_error` is zero on both primary and standby,
verify newly sampled metrics reach Mimir, and check that the prior null-value error no longer occurs in new logs.
Do not reset statistics, filter the error away, or treat absent metrics as zero. I/O timing and wait metrics must
continue to arrive after the instance restart.

## Recovery boundary

If an operator rollout fails, stop further administrative changes, retain logs and the exact failed revision, and
inspect the responsible operator/instance condition. A source revert and reviewed Application sync can restore the
previous operator release when its compatibility contract permits it; this may require another managed rolling
update. Do not downgrade CRDs blindly or delete retained database state. Diagnose application reconnect failures
separately from persistent database unavailability.

Upstream references:

- [Release notes for 1.30.1](https://cloudnative-pg.io/docs/1.30/release_notes/v1.30/)
- [Operator and instance-manager upgrades](https://cloudnative-pg.io/docs/1.30/installation_upgrade/)
