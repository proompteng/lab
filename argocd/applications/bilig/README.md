# bilig

This app is the standalone Argo CD product shell for `bilig`.

## Components

- `bilig-app`: fullstack monolith runtime serving the browser shell and backend APIs
- `bilig-zero`: Zero cache/runtime
- `bilig-db`: CNPG Postgres cluster
- `bilig-alloy`: namespace-local logs and metrics forwarding

## Hosts

- `bilig.proompteng.ai`
- `api.bilig.proompteng.ai`
- `zero.bilig.proompteng.ai`

The production monolith uses `bilig.proompteng.ai` as the primary public entrypoint:

- `/zero` routes to `bilig-zero`
- every other browser and API path routes to `bilig-app`
- `api.bilig.proompteng.ai` remains an API-only alias to `bilig-app`

## Promotion mode

This app is registered as `auto` automation in the product ApplicationSet. Kargo's `bilig` Stage is the image promotion
authority.

## Notes

- The external Bilig publisher publishes `bilig-app:<40-hex>`; Kargo's `bilig` Warehouse creates Freight from that bare
  40-hex tag and the exact automatic `bilig` Stage promotes it. Kargo copies the source commit and full digest/build metadata to `kargo/bilig` without a pull request;
  the Argo Application tracks that branch and auto-syncs it. No Image Updater, SHA manifest bump, release branch, or
  deployment PR is used.
- The public product shell runs in explicit `demo` authentication mode and signs anonymous sessions with the `bilig-app-auth` SealedSecret.
- Redis has been removed from the product runtime path; collaboration correctness now depends only on the monolith, Zero, and Postgres.

## Zero runtime compatibility

- `bilig-zero` is pinned to `rocicorp/zero:1.9.0@sha256:f80683bf3ddf08be26c68ddd94589fada29a0b8a4597668b090006c09041d4cd`. The upstream Zero release is a multi-architecture image with linux/amd64 and linux/arm64 manifests.
- The Bilig image observed before this upgrade uses `@rocicorp/zero@1.1.1`. Zero's [documented compatibility contract](https://zero.rocicorp.dev/docs/self-host) supports clients from the same major version, so this server upgrade does not require a blind Bilig application image rebuild. Keep the Zero cache rollout ahead of any future Bilig image that changes the Zero SDK, and verify `/keepalive`, query, mutate, and live sync behavior before accepting the rollout.
- The deployment uses `Recreate` and retains the `bilig-zero-replica` PVC so the cache is upgraded in place without creating a second replica against the same replica file. Startup and termination each allow ten minutes for replica initialization and graceful client draining, as recommended by the upstream self-hosting guide. Before rollout, require a Ready CNPG backup and record the existing replica integrity check, schema and table counts. After rollout, verify the new server version, upstream replication, query and mutation endpoints, and a client reconnect.
- If the new server fails acceptance, stop further upgrades and preserve the existing PVC. Do not assume the old binary can read a replica upgraded by a newer server. Restore a retained original replica snapshot to a separate PVC, or rebuild a separate replica from upstream Postgres under the documented single replication-manager contract, before any rollback cutover.

## Authentication rollout

- Cutover impact: client-supplied identity headers stop being trusted. On their next request, existing visitors receive a newly signed anonymous session, so their anonymous identity changes once at cutover. The shared demo workbook remains available.
- Secret readiness: validate the manifest with `kubeseal --validate --controller-name sealed-secrets --controller-namespace sealed-secrets`, then after sync require `kubectl -n bilig wait --for=condition=Synced sealedsecret/bilig-app-auth --timeout=120s` and confirm `secret/bilig-app-auth` exists before accepting the rollout.
- Pod safety: `BILIG_SESSION_SECRET` uses a required `secretKeyRef`; a replacement container cannot start until the Secret exists. The deployment's `maxUnavailable: 0`, `maxSurge: 1`, and readiness probe keep the previous replicas serving until each replacement is healthy.
- Rollback: re-promote the last known-good `bilig` Freight through Kargo, let Argo CD reconcile `kargo/bilig`, and
  wait for `deployment/bilig-app` to complete. Removing the signing Secret invalidates cookies issued during the
  cutover, which is expected.
