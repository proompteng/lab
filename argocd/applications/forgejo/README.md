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

## Version 17 upgrade

The Application tracks `kargo/forgejo` and authorizes only `forgejo-release:forgejo`.
The 17.0.2 checkpoint stops Forgejo before it takes fresh PostgreSQL and
repository snapshots. The rehearsal uses clones of those snapshots, preserves
their file ownership, and runs with networking disabled. The published image
uses the same upstream rootless index and platform digests as the rehearsal.

The two containers share the Job's 40-minute deadline. Each reports failure to
its peer when it exits early, and PostgreSQL shuts down before the Job passes.

Require a successful rehearsal before starting Forgejo against production
data. Keep both checkpoint snapshots and their clone claims. Follow the
[upgrade runbook](../../../docs/runbooks/forgejo-16-upgrade.md) for the
acceptance checks and coordinated recovery.
