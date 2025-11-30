# Jangar service

This directory hosts the Bun app that serves the OpenAI-compatible proxy, the TanStack Start UI scaffold, and the Temporal worker (same image). As of November 30, 2025 the implementation is partial; see “Current state” below.

## Current state

- ✅ OpenAI proxy endpoints `/openai/v1/chat/completions` (streaming only) and `/openai/v1/models` backed by the Codex app-server.
- ✅ Convex mutations for telemetry are called by the proxy; schema lives in `convex/schema.ts`.
- ⚠️ Workflow/activities are stubs: `run-codex-turn`, `run-worker-task`, `publish-event` and the `codexOrchestrationWorkflow` loop do not perform real work yet.
- ⚠️ Toolbelt (`packages/cx-tools`) is unimplemented, so activities cannot shell out via `cx-*` CLIs.
- ⚠️ UI is a minimal shell (`/_index`, `/health`); mission/chat/SSE views are not present.
- `/v1/models` returns four Codex variants; narrow this list in `src/services/models.ts` if you need a single orchestrator model.
- The app Deployment disables the Temporal worker by default (`ENABLE_TEMPORAL_WORKER=0`); the worker Deployment runs the same image with `bun run src/worker.ts`.

## Running locally

- UI/dev + worker watch: `bun run dev:all` (or `bun run start:dev` for UI only). Default ports: UI 3000, OpenWebUI 8080 (Docker compose).
- Prod-style entrypoint: `bun run src/index.ts` (spawns app-server, UI server, optional worker based on `ENABLE_TEMPORAL_WORKER`).
- OpenWebUI link: use `VITE_OPENWEBUI_URL` to point the UI at an external host; defaults to `http://localhost:8080` in dev.

## Build

- `bun run start:build` produces the TanStack Start output in `dist/ui/`. Image assembly is handled by `packages/scripts/src/jangar/build-image.ts` (bundles dist + Codex binary); bundling `packages/cx-tools/dist` will be required once the toolbelt exists.

## Missing pieces (tracked in docs/jangar/implementation-plan.md)

- Real implementations for activities and workflow loop.
- Worker repo clone/branch/push helpers in `src/services/git.ts`.
- Mission REST/SSE endpoints and UI views for orchestrations.
- Toolbelt CLIs and bundling into the image.
