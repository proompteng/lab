# Jangar Start UI

TanStack Start scaffold for the Jangar operator UI. In production the app proxies an external OpenWebUI Deployment at `/openwebui/` (same origin for the iframe); API/SSE wiring is in progress.

## Commands

- `bun run start:dev` (from `services/jangar`) – boots the Start dev server.
- `bun run start:build` – produces a production build under `services/jangar/dist/ui/`.

The follow-up image work (JNG-080c) will package the Start dist output from `dist/ui` alongside the server.

## Notes

- Data is mocked in `src/app/lib/mocks.ts` and mirrored in the UI as loading/error shells.
- UI dev server listens on port 3000 by default; OpenWebUI embed defaults to http://localhost:8080 to avoid port collisions and still uses the reverse proxy path `/openwebui/` in production.
- OpenWebUI integration is embedded via iframe; env var `VITE_OPENWEBUI_URL` controls the target.
