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

## Authentication rollout

- Cutover impact: client-supplied identity headers stop being trusted. On their next request, existing visitors receive a newly signed anonymous session, so their anonymous identity changes once at cutover. The shared demo workbook remains available.
- Secret readiness: validate the manifest with `kubeseal --validate --controller-name sealed-secrets --controller-namespace sealed-secrets`, then after sync require `kubectl -n bilig wait --for=condition=Synced sealedsecret/bilig-app-auth --timeout=120s` and confirm `secret/bilig-app-auth` exists before accepting the rollout.
- Pod safety: `BILIG_SESSION_SECRET` uses a required `secretKeyRef`; a replacement container cannot start until the Secret exists. The deployment's `maxUnavailable: 0`, `maxSurge: 1`, and readiness probe keep the previous replicas serving until each replacement is healthy.
- Rollback: re-promote the last known-good `bilig` Freight through Kargo, let Argo CD reconcile `kargo/bilig`, and
  wait for `deployment/bilig-app` to complete. Removing the signing Secret invalidates cookies issued during the
  cutover, which is expected.
