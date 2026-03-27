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

## Promotion mode

This app is registered as `manual` automation in the product ApplicationSet until the bilig production acceptance matrix is green.

## Notes

- The first tranche keeps object-storage integration optional and disabled-by-default in the app config until the durable snapshot adapter lands.
- The app is safe to register now because manual sync prevents accidental rollout before the corresponding container images are published.
