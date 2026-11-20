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
The isolated 17.0.2 rehearsal uses the retained snapshot clones and their
existing file ownership. It runs alongside Forgejo 16.0.3 with networking
disabled. The published image must carry the same upstream index digest as
the mirrored rehearsal image.

Require a successful rehearsal before switching the upstream pin. Capture a
fresh production checkpoint at cutover and retire the rehearsal resources
after the production migration has passed. Follow the
[upgrade runbook](../../../docs/runbooks/forgejo-16-upgrade.md) for the
acceptance checks and coordinated recovery.
