# landing web

This app expects the shared Convex backend in `packages/backend`.

Deployment: changes under `apps/landing/**` (or `packages/design/**`) merged to `main` trigger a Docker build and an Argo CD Image Updater PR that bumps `argocd/applications/proompteng/kustomization.yaml`.

## Local setup

1. Configure Convex once:

   ```sh
   bun run dev:setup:convex
   ```

   This prompts for or creates a Convex deployment and writes `packages/backend/.env.local`.

2. Copy the generated `NEXT_PUBLIC_CONVEX_URL` into `apps/landing/.env.local` (use the provided `.env.example` as a template).
3. If you want CMS-driven content, set `LANDING_CMS_URL` to your Payload instance (for example `https://cms.proompteng.ai`).
4. Live presence badge:
   - keep `NEXT_PUBLIC_ENABLE_LIVE_PRESENCE_COUNTER=true` to show `LIVE • N online` in the terminal title bar;
   - tune `NEXT_PUBLIC_PRESENCE_HEARTBEAT_SECONDS` and `PRESENCE_TTL_SECONDS` if needed.
5. Seed the Convex models catalog once so the UI has initial data:

   ```sh
   bun run seed:models
   ```

6. Launch the Next.js app together with the Convex dev backend:

   ```sh
   bun run dev:landing
   ```

The homepage shows a “convex backend” badge once it can reach the Convex health check query.

## Tengri BFF development

The server-only BFF uses stateless Better Auth GitHub OAuth and signed internal gRPC metadata. The browser never
receives Kubernetes credentials, the internal HMAC secret, or a guest bootstrap token.

1. Set the Better Auth, GitHub OAuth, gRPC endpoint, and HMAC variables from `.env.example`.
2. Register `http://localhost:3000/api/auth/callback/github` as the local GitHub callback.
3. Start the Rust Tengri service locally or point at an isolated development endpoint.

For a zero-downtime HMAC rotation, temporarily set `TENGRI_INTERNAL_HMAC_SECRET` to `new,current`. The BFF emits both
signatures until the controller has refreshed the same bundle; remove the previous key only after both sides have
observed it.

## Validation

```sh
cd apps/landing
bunx tsc --noEmit
bun run lint:oxlint
bun test src/lib/tengri
bun run build
```
