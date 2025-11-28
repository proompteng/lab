# Jangar Start UI

TanStack Start scaffold for the Jangar operator UI. OpenWebUI now ships as its own Helm release; Jangar connects to it via
the configured host instead of an in-app banner.

## Commands

- `bun run start:dev` (from `services/jangar`) – boots the Start dev server.
- `bun run start:build` – produces a production build under `services/jangar/dist/ui/`.

The follow-up image work (JNG-080c) will package the Start dist output from `dist/ui` alongside the server.

## Notes

- Data is mocked in `src/app/lib/mocks.ts` and mirrored in the UI as loading/error shells.
- UI dev server listens on port 3000 by default; OpenWebUI defaults to http://localhost:8080 for local dev and uses the
  external host in production via `VITE_OPENWEBUI_URL`.
