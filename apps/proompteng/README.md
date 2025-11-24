# proompteng web

This app now expects the shared Convex backend in `packages/backend`.

## Local setup

1. Configure Convex once:
   ```sh
  bun run dev:setup:convex
   ```
   This prompts for or creates a Convex deployment and writes `packages/backend/.env.local`.
2. Copy the generated `NEXT_PUBLIC_CONVEX_URL` into `apps/proompteng/.env.local` (use the provided `.env.example` as a template).
3. Seed the Convex models catalog once so the UI has initial data:
   ```sh
  bun run seed:models
   ```
4. Launch the Next.js app together with the Convex dev backend (one command):
   ```sh
  bun run dev:proompteng
   ```

The homepage shows a “convex backend” badge once it can reach the Convex health check query.
