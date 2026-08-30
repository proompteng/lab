# Repo notes

## Area

services/bumba workflows

## Files

- services/bumba/src/workflows/index.ts
- services/bumba/src/activities/index.ts
- packages/scripts/src/atlas/rebuild.ts

## Commands run

- rg -n "reconcileAtlasRepository" services/bumba
- bun run atlas:rebuild --repository proompteng/lab --ref main
