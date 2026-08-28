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
4. Seed the Convex models catalog once so the UI has initial data:

   ```sh
   bun run seed:models
   ```

5. Launch the Next.js app together with the Convex dev backend:

   ```sh
   bun run dev:landing
   ```

The homepage shows a “convex backend” badge once it can reach the Convex health check query.

## Tengri BFF development

The server-only BFF uses stateless Better Auth GitHub OAuth and signed internal gRPC metadata. The browser never
receives Kubernetes credentials, the internal HMAC secret, or a guest bootstrap token.
The BFF rate-limits the authenticated GitHub subject. GitOps adds a separate Traefik rate-limit middleware that uses
Traefik's connection source, so the application never trusts caller-supplied forwarding headers for IP throttling.

1. Set the Better Auth, GitHub OAuth, gRPC endpoint, HMAC, and `TENGRI_PUBLIC_URL` variables from `.env.example`.
   The public URL must match the Rust controller and is exposed to the browser only as the allowlisted preview gateway
   origin. HTTPS is required except for the exact `http://localhost` development host.
2. Register `http://localhost:3000/api/auth/callback/github` as the local GitHub callback.
3. Start the Rust Tengri service locally or point at an isolated development endpoint.

For a zero-downtime HMAC rotation, temporarily set `TENGRI_INTERNAL_HMAC_SECRET` to `new,current`. The BFF emits both
signatures until the controller has refreshed the same bundle; remove the previous key only after both sides have
observed it.

Changing `TENGRI_PUBLIC_URL` rolls the landing Deployment through GitOps and briefly interrupts the web UI and BFF.
Merge the reviewed manifest, let Argo replace the Pod, then verify
`kubectl --context galactic-lan -n proompteng rollout status deployment/proompteng --timeout=5m` and confirm an
authenticated `/api/tengri` snapshot reports the expected `previewGatewayOrigin`. Existing MicroVM Pods and PVCs are
not touched. Roll back by reverting the configuration commit through a follow-up PR and Argo; do not apply or undo the
Deployment directly.

## Validation

```sh
cd apps/landing
bunx tsc --noEmit
bun run lint:oxlint
bun test src/lib/tengri
bun run build
```
