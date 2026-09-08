# proompteng app

Internal TanStack Start control-plane UI for operator workflows.

The current app provides:

- an authenticated root shell
- SSO login, callback, and logout routes
- a landing page shell for runs, policies, tools, observability, routing, and experiments

## Local development

From the repo root:

```bash
bun run dev:app
```

Or from this workspace directory:

```bash
bun run dev
```

The dev server runs on port `3000`.

## Scripts

```bash
bun run dev
bun run build
bun run start
bun run test
bun run lint
bun run format
bun run lint:oxlint
bun run lint:oxlint:type
```

## Current route structure

- `src/routes/__root.tsx`: authenticated root layout and redirect gate
- `src/routes/login.tsx`: SSO sign-in screen
- `src/routes/auth.login.ts`: starts auth flow
- `src/routes/auth.callback.ts`: handles auth callback
- `src/routes/auth.logout.ts`: clears the session
- `src/routes/index.tsx`: current control-plane shell homepage

Unauthenticated users are redirected to `/login`. The app marks pages as `noindex, nofollow`.

## Notes

- Styling comes from Tailwind CSS and shared components in `@proompteng/design`.
- `start` serves the built app from `.output/server/index.mjs`.
- This README intentionally documents the current shell and auth flow rather than the original scaffold examples.
