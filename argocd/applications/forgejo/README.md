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

The Application tracks `kargo/forgejo` and authorizes only `lab-delivery:forgejo`.
The Warehouse requires a main source commit and its matching immutable
published image. The Stage updates both Helm-rendered containers and the
isolated rehearsal through a Kustomize image transformation, writes source
metadata, and syncs the exact generated commit.

This preparation stops the existing Deployment and takes a new pair of
snapshots after the earlier restoration. It migrates only fresh clones using
the selected Kargo image. Require that rehearsal to complete before removing
the temporary quiesce patch and Jobs in the final release. Retain both recovery
sets and all claims. Follow the [upgrade runbook](../../../docs/runbooks/forgejo-16-upgrade.md).
