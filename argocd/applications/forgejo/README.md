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

## Version 17 recovery

The Application tracks `kargo/forgejo` and authorizes only `forgejo-release:forgejo`.
The 17.0.2 cutover retained offline PostgreSQL and repository snapshots and
their isolated clone claims. Recover them as a pair from the
`forgejo-server-17-0-2-cutover-*` resources. The published image uses the
upstream rootless index and platform digests exercised in the clone rehearsal.

Follow the [upgrade runbook](../../../docs/runbooks/forgejo-16-upgrade.md) for
the acceptance checks and coordinated recovery.
