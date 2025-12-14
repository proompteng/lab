Jangar

OpenAI-compatible (streaming) chat completions endpoint backed by the Codex app-server.

## Architecture

More detailed write-up: `docs/jangar/current-state.md`.

```mermaid
flowchart TD
  subgraph Client["Clients"]
    OWU["OpenWebUI (or any SSE client)"]
  end

  subgraph HTTP["HTTP Surface"]
    Route["POST /openai/v1/chat/completions\nservices/jangar/src/routes/openai/v1/chat/completions.ts"]
  end

  subgraph Runtime["Effect Runtime + Services"]
    Handler["handleChatCompletionEffect\nservices/jangar/src/server/chat.ts"]
    Config["loadConfig\nservices/jangar/src/server/config.ts"]
    Encoder["ChatCompletionEncoder\nservices/jangar/src/server/chat-completion-encoder.ts"]
    ToolRenderer["ChatToolEventRenderer\nservices/jangar/src/server/chat-tool-event-renderer.ts"]
    ThreadState["OpenWebUiThreadState\nservices/jangar/src/server/openwebui-thread-state.ts"]
    ThreadStore["Redis ChatThreadStore\nservices/jangar/src/server/chat-thread-store.ts"]
  end

  subgraph Codex["Codex App Server"]
    ClientLib["@proompteng/codex\nCodexAppServerClient.runTurnStream"]
    Child["codex app-server child process\n(JSON-RPC over stdio)"]
  end

  subgraph Stream["SSE Response"]
    SSE["text/event-stream\nchat.completion.chunk + [DONE]"]
  end

  OWU --> Route
  Route --> Handler
  Handler --> Config
  Handler --> ClientLib
  Handler --> Encoder
  Handler --> ToolRenderer
  Handler -. "x-openwebui-chat-id" .-> ThreadState
  ThreadState --> ThreadStore
  ClientLib --> Child
  ClientLib -->|StreamDelta| Handler
  Handler -->|frames| SSE
```

## Development

```bash
bun --cwd services/jangar run dev
```

## Scripts

```bash
bun --cwd services/jangar run build
bun --cwd services/jangar run preview
bun --cwd services/jangar run test
bun --cwd services/jangar run lint
bun --cwd services/jangar run tsc
```

## API Notes

- `/openai/v1/chat/completions` is **streaming-only**; requests must set `stream: true`. Non-streaming responses are not implemented.
- Authentication and rate limiting are intentionally disabled because this endpoint is for internal use only; place it behind your own network guardrails when exposing it.
- Usage totals are emitted only when the request includes `stream_options: { include_usage: true }`. The final SSE chunk (empty `choices` array) carries the normalized OpenAI-style `usage`, even when a turn ends with an upstream error or client abort.
- Server-side Effect services follow `Context.Tag + Layer` patterns; see `src/server/effect-services.md`.

## Environment

- `JANGAR_MODELS` (comma-separated list; optional)
- `JANGAR_DEFAULT_MODEL` (optional)
- `JANGAR_REDIS_URL` (required only when using `x-openwebui-chat-id` thread persistence)
- `JANGAR_CHAT_KEY_PREFIX` (optional; defaults to `openwebui:chat`)
