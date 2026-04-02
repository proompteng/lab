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

This app is registered as `auto` automation in the product ApplicationSet.

## Notes

- Argo CD Image Updater writes new published `bilig-app` image tags back into this app, and Argo CD auto-sync applies them.
- Redis has been removed from the product runtime path; collaboration correctness now depends only on the monolith, Zero, and Postgres.
