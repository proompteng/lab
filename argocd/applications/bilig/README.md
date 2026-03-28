# bilig

This app is the standalone ArgoCD product shell for `bilig`.

## Components

- `bilig-web`: browser shell
- `bilig-sync`: realtime sync and remote agent API
- `bilig-db`: CNPG Postgres cluster
- `bilig-redis`: Redis session/presence cache
- `bilig-alloy`: namespace-local logs and metrics forwarding

## Hosts

- `bilig.proompteng.ai`
- `api.bilig.proompteng.ai`
- `zero.bilig.proompteng.ai`

The production web shell now uses `bilig.proompteng.ai` as the single public entrypoint:
- `/v1` and `/api/zero` are routed to `bilig-sync`
- `/zero` is routed to `bilig-zero`

## Promotion mode

This app is registered as `auto` automation in the product ApplicationSet.

## Notes

- The first tranche keeps object-storage integration optional and disabled-by-default in the app config until the durable snapshot adapter lands.
- Argo CD Image Updater writes new published `bilig-web` and `bilig-sync` image tags back into this app, and Argo CD auto-sync applies them.
