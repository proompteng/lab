# Jangar current state (2025-11-30)

Source code is the source of truth; this note captures what is actually implemented today.

## Working
- OpenAI-compatible proxy endpoints `/openai/v1/chat/completions` (streaming-only) and `/openai/v1/models` backed by the Codex app-server (`gpt-5.1-codex-*`).
- Convex schema and mutations for conversations, turns, messages, reasoning sections, commands (+ chunks), usage, rate limits, and events. The proxy writes via `src/services/db`.
- App server wrapper auto-clones the lab repo into `CODEX_CWD` when missing; runs Codex with sandbox `danger-full-access`, approval `never` by default.
- Tool invocation events from Codex (command/file/mcp/web search) are now forwarded in the SSE stream as OpenAI-style `tool_calls` deltas so OpenWebUI can display them. Example SSE line:
  - `data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"name":"command","arguments":"[{\"status\":\"started\",\"title\":\"ls\"}"}}]},"index":0,"finish_reason":null}],"model":"gpt-5.1-codex","created":1733011200}\n\n`

## Not yet implemented
- Activities: `run-codex-turn`, `run-worker-task`, and `publish-event` are stubs; no repo cloning, lint/test, PR creation, or SSE fan-out.
- Workflow: `codexOrchestrationWorkflow` schedules a single stub turn; signals/queries/loop/guardrails are missing.
- Toolbelt: `packages/cx-tools` contains only scaffolding—no `cx-codex-run` or `cx-workflow-*` binaries are built.
- UI: only a welcome page and `/health`; mission list/detail, chat, timeline, and SSE wiring are absent.
- Convex read-side queries are absent; UI cannot fetch history/state.
- Manifests lack secrets for `CODEX_API_KEY`, `GITHUB_TOKEN`, and Convex deploy/admin keys; app deployment disables the Temporal worker (`ENABLE_TEMPORAL_WORKER=0`).

## Behavioral notes
- `/v1/models` exposes four Codex variants (`gpt-5.1-codex-max`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1`). Adjust `src/services/models.ts` if only one should appear.
- Worker and app share the same image; worker command is `bun run src/worker.ts`. App entrypoint `src/index.ts` can start the worker if `ENABLE_TEMPORAL_WORKER` is set.
- Env helper `buildCodexEnv` sets `CX_DEPTH` and `CODEX_HOME` but does not yet wire `CODEX_API_KEY/CODEX_PATH`.

## Quick smoke
- From `services/jangar`: `bun run start:dev` (UI) and `curl -N -X POST http://localhost:3000/openai/v1/chat/completions ...` with `stream=true` to confirm SSE proxy + Convex writes.

Keep this file in sync with code changes until the planned features land.
