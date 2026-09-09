# Forgejo Argo CD App

This app deploys [Forgejo](https://forgejo.org/) using the official OCI Helm chart:

- Chart: `oci://code.forgejo.org/forgejo-helm/forgejo`
- Chart version: `17.1.5`
- App version: `16.0.3`

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

The image is explicitly pinned because chart 17.1.5 defaults to the 15.x LTS
release. The [upgrade runbook](../../../docs/runbooks/forgejo-16-upgrade.md)
records the consistent backup, isolated native migration and production
acceptance gates. Both original PVCs, the administrator identity and existing
HTTP/SSH addresses remain in use. The temporary zero-replica patch is removed
only after the snapshot-clone rehearsal succeeds.
