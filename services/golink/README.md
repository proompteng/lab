# golink

Internal Knative service that powers `http://go/<slug>` redirects with a small admin UI. Built with TanStack Start (React), Tailwind CSS v4, @proompteng/design, and Drizzle on Postgres/CNPG.

## Prerequisites
- `.env.local` in `services/golink` (copy `.env.example`) with `GOLINK_DATABASE_URL` set. Defaults point to the local compose Postgres on port 15433.
- Bun 1.3.5 and Node 24.11.1 (workspace defaults).

## Scripts
All commands run from the repo root unless noted.

```bash
# install workspace deps
a bun install

# local dev (watch)
bun run --filter @proompteng/golink dev

# production build + preview
bun run build:golink
bun run start:golink

# lint & tests
bun run lint:golink
bun run test:golink

# Drizzle migrations
cd services/golink
cp .env.example .env.local # set a custom DB url if needed
bun run generate   # generate SQL from schema
bun run migrate    # push to DB (requires GOLINK_DATABASE_URL)

# seed sample links
bun run seed
```

## Migrations
- Schema lives in `src/db/schema/links.ts`.
- Migrations are emitted to `src/db/migrations` via `bunx drizzle-kit generate --config drizzle.config.ts`.
- `bun run migrate` will run `drizzle-kit push` against `GOLINK_DATABASE_URL`; use `--dry-run` for safety.

## Deploy
`bun run golink:deploy` (root script) will:
1) run Drizzle migrations,
2) build + push the Docker image,
3) stamp the Knative manifest with the digest and rollout timestamp,
4) apply the manifest to the cluster.

The Knative service is cluster-local with Tailscale exposure at host `go`.

## Environment
- `PORT` defaults to 3000 in the container.
- `GOLINK_VERSION` / `GOLINK_COMMIT` are injected by the deploy script for observability.

## Testing
- Vitest covers redirect lookup and CRUD handlers using an in-memory PGlite database (`createTestDb`).
- UI behaviors rely on optimistic React Query mutations; manual QA: create/edit/delete rows and confirm slug redirect 302 and 404 for unknown slugs.
