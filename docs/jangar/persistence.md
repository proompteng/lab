# Jangar persistence

JNG-020 introduces a durable Postgres backing store for orchestrations, turns, and worker PR results. The service uses Drizzle ORM to manage schema and migrations and will automatically apply pending migrations on startup.

## Environment
- `DATABASE_URL` (required): Postgres connection string, e.g. `postgres://postgres:postgres@localhost:6543/jangar`.
- `PGSSLROOTCERT` (optional): Filesystem path to a CA bundle when the database requires TLS verification. If provided, the file must be readable by the process; failures are treated as fatal.

## Local workflow
1. Install deps: `cd services/jangar && bun install`.
2. Generate migrations from the schema: `DATABASE_URL=postgres://... bun run db:generate`.
3. Apply migrations: `DATABASE_URL=postgres://... bun run db:migrate`.
4. Type-check: `bun run check`.

During runtime (`src/server.ts` and `src/worker.ts`), Jangar calls `runMigrations()` before starting the HTTP server or Temporal worker. If migrations fail (e.g., missing `DATABASE_URL` or unreachable DB), the process logs the error and exits non-zero to avoid partial startup.

## Schema overview
- `orchestrations`: id (text PK), topic, repo_url, status, created_at, updated_at.
- `turns`: uuid PK, orchestration_id FK, index (unique per orchestration), thread_id, final_response, items (jsonb), usage (jsonb), created_at.
- `worker_prs`: uuid PK, orchestration_id FK, pr_url, branch, commit_sha, notes, created_at.

The generated SQL lives under `services/jangar/drizzle/` and is committed so CI/CD can run migrations without regeneration.
