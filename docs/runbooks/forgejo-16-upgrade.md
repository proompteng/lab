# Forgejo 16 upgrade

The target is Forgejo 16.0.3 with chart 17.1.5. The chart defaults to the
15.x LTS image, so explicitly pin the 16.0.3 rootless image and verified digest.
Keep the existing PostgreSQL instance, shared PVC, administrator identity,
credential references, SSH address and HTTP Services.

## Before maintenance

Read the upstream [upgrade guide](https://forgejo.org/docs/latest/admin/upgrade/)
and [16.0 release notes](https://forgejo.org/2026-07-release-v16-0/).
This instance does not use reverse-proxy authentication or repository mirrors,
so the corresponding v16 security changes require no compatibility override.
Do not restore wildcard proxy trust or weaken mirroring restrictions.

Capture the source PVC and Deployment UIDs, PostgreSQL system identifier and
schema version, user/repository/runner/key/token counts, and every repository
reference. Run Git `fsck` and Forgejo's diagnostic checks. The v15 baseline
has disabled LFS, old generated-hook warnings, and three orphaned archive
warnings; retain those distinctions when assessing the upgraded version.
The configured `/data/log` directory must exist for the native path check.

Immediately before merging the maintenance change, verify that authenticated
runner status is idle/offline, the pending-jobs API is empty, and no Git
subprocess is active. Do not cancel jobs or scale runners to obtain that state.
Flush the running Forgejo queues:

```sh
kubectl --context galactic-lan -n forgejo exec deployment/forgejo -c forgejo -- \
  forgejo manager flush-queues --timeout 2m
```

## Consistent backup and migration rehearsal

Forgejo is a manual GitOps application. Sync the exact merged maintenance
revision through Argo, preserving the ApplicationSet automation policy.

The maintenance commit sets only the existing Deployment's replica count to
zero in sync wave -20. The following read-only gate verifies its UID, both
source PVC UIDs and the absence of every Forgejo Pod before snapshots start.
The PostgreSQL backup is offline; the repository/data snapshot is taken while
Forgejo is stopped. Both snapshots and their clones are retained.

The rehearsal mounts only the two clones. PostgreSQL 17.11 starts with the
original system identifier and legacy base schema 305, using a loopback-only listener.
Forgejo tracks current migrations in `forgejo_migration`; the legacy `version`
value remains 305. Require the exact sorted migration ledger to move from the
27 original entries to all 39 IDs registered by the pinned 16.0.3 source.
The v2 rehearsal uses new clones of the retained pre-upgrade snapshots.
Forgejo 16.0.3 retains the cloned configuration and credentials while changing
only its database host to that listener. The Pod has no service-account token
and denies network ingress and egress. It never starts a Forgejo web server.

Require the native migration, database consistency checks, original identity
counts, repository reference hashes, Git integrity checks and clean PostgreSQL
shutdown to pass. Read both containers' logs and verify the Job succeeded.
Snapshot readiness alone does not establish recovery or migration success.

## Production upgrade and acceptance

After the rehearsal passes, merge the version change and remove the temporary
quiesce patch through GitOps, then sync that exact merged revision. Preserve the completed backup and rehearsal
resources. The normal Deployment remains a single replica with `Recreate`.

Verify the exact image and Argo revision, the same live PVC UIDs, completed
database migration, administrator and token identity, repository references,
authenticated repository/API reads, normal SSH access, and runner reconnection.
Run the native doctor checks again and compare findings with the baseline.
Inspect the repository UI through the existing account session. A readiness
probe or version endpoint alone does not establish completion.

If the rehearsal fails, the production database and shared volume still
contain the original data. Correct the isolated rehearsal, or remove the
quiesce patch with the old image to restore service while investigating.
Do not force-delete Pods or claims. After production migration, do not run the
old binary against the migrated database: coordinated recovery requires both
retained snapshots and accounting for any writes accepted after the upgrade.
