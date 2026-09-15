# Convex backend

Author Convex functions for proompteng here.

- Add tables in `schema.ts` with `defineSchema`.
- Implement queries/mutations alongside in this directory.
- Run `bun run --filter @proompteng/backend dev:setup` once to configure a Convex deployment.
- Start the dev server with `bun run --filter @proompteng/backend dev`.
- Seed default model catalog entries with `bun run seed:models` (idempotent; skips if records already exist).
- Merges to `main` that change this directory deploy functions through `.github/workflows/convex-deploy.yml` using the
  self-hosted deployment URL and admin key stored in GitHub Actions secrets.
- `crons.ts` drains rows left by the retired live-presence demo. Keep the `liveSessions` table until production
  confirms that cleanup has completed, then remove the table and cleanup mutation together.
