# landing web

This app now expects the shared Convex backend in `packages/backend`.

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
5. Launch the Next.js app together with the Convex dev backend (one command):
   ```sh
   bun run dev:landing
   ```

The homepage shows a “convex backend” badge once it can reach the Convex health check query.
