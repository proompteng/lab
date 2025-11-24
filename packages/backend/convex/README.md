# Convex backend

Author Convex functions for proompteng here.

- Add tables in `schema.ts` with `defineSchema`.
- Implement queries/mutations alongside in this directory.
- Run `bun run --filter @proompteng/backend dev:setup` once to configure a Convex deployment.
- Start the dev server with `bun run --filter @proompteng/backend dev`.
- Seed default model catalog entries with `bun run seed:models` (idempotent; skips if records already exist).
