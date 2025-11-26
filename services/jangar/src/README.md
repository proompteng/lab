# Jangar Start UI

TanStack Start scaffold for the Jangar operator UI. Routes are currently mock-only while the API/SSE work
(JNG-060a/b, JNG-070b) lands.

## Commands

- `bun run start:dev` (from `services/jangar`) – boots the Start dev server with mock missions at `/` and `/mission/$id`.
- `bun run start:build` – produces a production build under `services/jangar/dist/ui/`.

The follow-up image work (JNG-080c) will package the Start dist output from `dist/ui` alongside the server.

## Notes

- Data is mocked in `src/app/lib/mocks.ts` and mirrored in the UI as loading/error shells.
- UI dev server listens on port 3000 by default; OpenWebUI embed defaults to http://localhost:8080 to avoid port collisions.
- OpenWebUI integration remains TODO(jng-070c); the current layout reserves space for the chat/timeline stream.
