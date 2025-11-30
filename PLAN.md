# Issue #1903 Plan – golink Knative service

## Objective
Deliver internal Knative service `services/golink` offering slug-based redirects and admin CRUD UI (TanStack Start + Tailwind v4 + shadcn/ui) backed by CNPG via Drizzle, containerized with Docker and deployed via Bun script that runs migrations before applying the Knative manifest.

## Task Breakdown
- Scaffold TanStack Start app under `services/golink`; wire `@tailwindcss/vite` import of `app.css?url`; add Tailwind v4 + shadcn canary setup.
- Configure Drizzle: `drizzle.config.ts`, DB client, `links` schema/migrations, seed script.
- Implement API/routes: slug redirect route, admin CRUD UI with validation, optimistic UX, shared Zod schemas.
- Tooling/scripts: package scripts (`dev/build/start/lint/test/migrate`), root delegating scripts, Biome coverage, tsconfig extend base.
- Docker/CI: multi-stage Dockerfile + .dockerignore; acceptance of version/commit args.
- Knative/Argo: manifests under `argocd/applications/golink/`; add ApplicationSet entry; cluster-local host `go`.
- Deploy script: `packages/scripts/src/golink/build-image.ts` & `deploy-service.ts` mirroring graf/facteur; run migrations then build/push/apply; root `golink:deploy` script.
- Tests/docs: Vitest/route tests for redirect + CRUD; README with env vars, scripts, migrations, deploy flow.

## Validation Checklist
- `bun install`
- `bun run build:golink`
- `bunx biome check services/golink`
- `bun run test:golink`
- `bunx drizzle-kit push --config drizzle.config.ts --dry-run` (staging)

## Risks & Notes
- CNPG secret/ingress readiness; migrations must halt on DB errors.
- Tailwind v4/shadcn canary volatility; pin versions.
- Deploy script must stop on migration failure to avoid bad rollout.
