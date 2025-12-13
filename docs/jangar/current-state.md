# Jangar chat completions (2025-12-11)

This note describes the currently implemented chat-completion proxy. Source of truth: `services/jangar/src/server/chat.ts` and `services/jangar/src/routes/openai/v1/chat/completions.ts`.

## Endpoint surface
- POST `/openai/v1/chat/completions` (streaming only). Handler: `chatCompletionsHandler` in `services/jangar/src/routes/openai/v1/chat/completions.ts`.
- Request schema: `messages` non-empty array of `{ role, content, name? }`; `stream` must be `true` (otherwise SSE error response); optional `model`; optional `stream_options.include_usage`.
- Models/default model are configured in `services/jangar/src/server/config.ts`:
  - `JANGAR_MODELS` (comma-separated) overrides the advertised model list.
  - `JANGAR_DEFAULT_MODEL` overrides the default model (and is auto-added to `JANGAR_MODELS` if missing).
- Requests that specify a `model` not present in the advertised list fail fast with `model_not_found`.
- Prompt sent to Codex is built by joining messages as `"role: content"` lines; for OpenAI-style content parts arrays, text parts are concatenated and non-text parts are summarized (e.g. `[image_url] <url>`).

## SSE response shape
- Headers: `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`, `x-accel-buffering: no`.
- Heartbeat comment `: keepalive` every 5s (disabled in tests); no initial `retry:` hint.
- Validation failure for non-stream requests returns an SSE error payload followed by `[DONE]`; other validation errors are JSON.
- Stream is driven by `client.runTurnStream(prompt, { model, cwd })`; `CODEX_CWD` env overrides the default repo root (prod default `/workspace/lab`).
- On client abort the handler emits an error chunk `request_cancelled` and interrupts the active turn.

## Streamed events
- **Assistant text**: `choices[0].delta.content` chunks. Role is attached on the first emitted chunk.
- **Reasoning**: arrives as `reasoning_content`; asterisks of length ≥4 are broken onto newlines to avoid fences; flushed immediately to avoid long silent periods.
- **Tool events** (per Codex `delta.type === 'tool'`):
  - `command`: opens a fenced block ```` ``` ````; emits truncated output/detail (max 5 lines). Multiple commands are separated with `\n---\n`.
  - `file`: skips the `started` event; renders each change as a code block `<path>\n<diff...>` truncated to 5 lines; dedupes identical summaries.
  - `webSearch`: emits the attempted query in backticks before completion; no fencing.
  - Other tools: emits a plain text summary (title/detail/output) outside fences.
- **Usage**: when `stream_options.include_usage=true`, the last seen usage object is normalized to OpenAI fields (`prompt_tokens`, `completion_tokens`, `total_tokens`, plus cached/reasoning details) and emitted once near stream end even if an upstream error occurred.
- **Errors**: upstream errors are forwarded as `{ error: { message, type, code? } }` and the stream continues listening for trailing usage.
- **Completion**: if not aborted or errored, emits a final chunk with `finish_reason: "stop"` then `data: [DONE]`.

## Notable behaviors / gaps
- Heartbeat interval is 5s and there is no initial comment or `retry` directive, so some proxies may still time out idle connections.
- Response caching is disabled via `no-cache` but not `no-store`; intermediaries could still buffer.
- Tool calls are rendered as human-friendly text/fences, not OpenAI `tool_calls` objects; clients expecting strict OpenAI tool-calling need adaptation. We intentionally avoid emitting structured tool calls because OpenWebUI would try to re-execute them, which we do not want.

## Smoke test
- From `services/jangar`: `bun run start:dev` then stream with `curl -N -X POST http://localhost:3000/openai/v1/chat/completions -H 'content-type: application/json' -d '{"model":"gpt-5.1-codex-max","messages":[{"role":"user","content":"hi"}],"stream":true}'`.
