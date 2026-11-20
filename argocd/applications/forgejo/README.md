# Forgejo Argo CD App

This app deploys [Forgejo](https://forgejo.org/) using the official OCI Helm chart:

- Chart: `oci://code.forgejo.org/forgejo-helm/forgejo`
- Chart version: `17.1.5`
- App version: selected by Kargo from the verified release publisher

## Current profile

- Single-pod baseline (`replicaCount: 1`)
- Persistent storage enabled (`50Gi`) on `rook-ceph-block`
- External Postgres on CNPG (`forgejo-db`, `10Gi` on `rook-ceph-block`)
- Traefik ingress enabled for `code.proompteng.ai`
- SSH service exposed as `LoadBalancer` on port `22` with SSH clone domain `git.proompteng.ai`
- Public user registration disabled
- Admin user: `kalmyk` (password generated into `forgejo-admin` secret)

## Notes from upstream docs

- The chart defaults to SQLite for simple installs, but this app is configured to use CNPG Postgres.
- Forgejo upstream recommends external PostgreSQL/MySQL for long-term multi-user installations.
- For medium/large workloads, external Redis/Valkey is recommended for session/cache/queue workloads.

References:

- https://forgejo.org/docs/latest/
- https://artifacthub.io/packages/helm/forgejo-helm/forgejo

## Version 16 rollout

The Application tracks `kargo/forgejo` and authorizes only `forgejo-release:forgejo`.
The Warehouse requires a main source commit and its matching immutable
published image. The Stage updates both Helm-rendered containers and the
isolated rehearsal through a Kustomize image transformation, writes source
metadata, and syncs the exact generated commit.

The selected-image rehearsal passed against new snapshots and isolated clones.
The final promotion restores one production replica and retires the maintenance
Jobs, ConfigMap, read-only RBAC and isolation policy. Both recovery sets and all
claims remain retained. Follow the [upgrade runbook](../../../docs/runbooks/forgejo-16-upgrade.md)
for migration acceptance and coordinated recovery.

## Version 17.0.2 maintenance

Before merging the rehearsal, use the [upgrade runbook](../../../docs/runbooks/forgejo-16-upgrade.md)
to hold Forgejo at its current Kargo revision, verify idle runners and an empty
queue, and flush the server queues. Confirm the reviewed activation is ready.
The runbook's recorded versions and migration counts describe the previous
cutover.

The first 17.0.2 promotion stops the current Deployment, confirms that its
Pods are gone and that both source claims retain their identities, and takes a
fresh offline PostgreSQL backup and repository snapshot. The rehearsal uses
isolated clones with PostgreSQL 18.6 and the promoted Forgejo image. It verifies
all 45 release migrations, identity counts, references and Git integrity, and
shuts down the cloned database cleanly. Keep production stopped until that
proof passes. The activation promotion restores the one production replica and
retires the maintenance Jobs, RBAC and isolation policy while retaining the
snapshots and clones.
