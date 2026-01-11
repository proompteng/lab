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
    ThreadState["ThreadState\nservices/jangar/src/server/thread-state.ts"]
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

### Local Jangar + remote cluster deps (Tilt)

From the repo root, run:

```bash
tilt up
```

This runs Jangar locally (Bun) and keeps `kubectl port-forward` sessions open to the remote cluster for:

- Postgres (CNPG `jangar-db`)
- Redis (OpenWebUI thread/worktree persistence)
- NATS (agent comms)
- ClickHouse (Torghut visuals)

Tilt uses your default kubeconfig/current context. If you need to change ports or disable optional deps:

```bash
# run Jangar on a different port
tilt up -- --jangar_port 3001

# avoid conflicts with a local Postgres
tilt up -- --db_local_port 15433

# disable optional forwards
tilt up -- --enable_redis=false --enable_nats=false --enable_clickhouse=false

# self-hosted embeddings (recommended if your DB schema uses vector(1024))
tilt up -- --openai_api_base_url http://127.0.0.1:11434/v1 --openai_embedding_model qwen3-embedding-saigak:0.6b --openai_embedding_dimension 1024
```

Troubleshooting:

- If a port-forward fails with "address already in use", change the corresponding `*_local_port`.
- If you see "lost connection to pod" on a port-forward, Tilt will automatically retry.
- If a secret lookup fails, confirm your kube context has access to the `jangar` namespace.

## Scripts

```bash
bun --cwd services/jangar run build
bun --cwd services/jangar run preview
bun --cwd services/jangar run test
bun --cwd services/jangar run lint
bun --cwd services/jangar run tsc
```

## Deployment

```bash
bun run packages/scripts/src/jangar/build-image.ts
bun run packages/scripts/src/jangar/deploy-service.ts
```

## API Notes

- `/openai/v1/chat/completions` is **streaming-only**; requests must set `stream: true`. Non-streaming responses are not implemented.
- Authentication and rate limiting are intentionally disabled because this endpoint is for internal use only; place it behind your own network guardrails when exposing it.
- Usage totals are emitted only when the request includes `stream_options: { include_usage: true }`. The final SSE chunk (empty `choices` array) carries the normalized OpenAI-style `usage`, even when a turn ends with an upstream error or client abort.
- Server-side Effect services follow `Context.Tag + Layer` patterns; see `src/server/effect-services.md`.

## Terminal backend

Jangar terminals are intended to run against a dedicated terminal backend deployment (`jangar-terminal` in GitOps). The main Jangar service proxies session APIs to that backend.

- Main Jangar: set `JANGAR_TERMINAL_BACKEND_URL` to the backend service URL so session APIs are proxied.
- Terminal backend: set `JANGAR_TERMINAL_PUBLIC_URL` to the browser-accessible origin for terminal WebSockets.
- Terminal backend: set `JANGAR_TERMINAL_BACKEND_ID` (unique per pod) for session metadata and routing diagnostics.
- Optional: tune `JANGAR_TERMINAL_BUFFER_BYTES` (output replay buffer) and `JANGAR_TERMINAL_IDLE_TIMEOUT_MS` (auto-terminate idle sessions).

## MCP (memories)

The memories MCP endpoint is available at `POST /mcp` (see `services/jangar/src/routes/mcp.ts`). The Codex app-server is configured to use it via `threadConfig.mcp_servers.memories` (see `services/jangar/src/server/codex-client.ts`).

The MCP server provides:

- `persist_memory`: stores `{ namespace, content, summary?, tags? }` plus an OpenAI embedding in Postgres (pgvector).
- `retrieve_memory`: semantic search over stored memories (cosine distance) for a namespace.

Storage details:

- Table is `memories.entries` (auto-created on first use; see `schemas/embeddings/memories.sql`) and requires `pgvector` + `pgcrypto` extensions.
- No table migrations are performed; the store expects the current schema only. If `OPENAI_EMBEDDING_DIMENSION` does not match the existing `memories.entries.embedding` column dimension, MCP calls will fail with a schema mismatch error.

## REST (memories)

Jangar also exposes JSON endpoints that mirror the MCP memory inputs:

- `POST /api/memories` with `{ namespace?, content, summary?, tags? }` to persist a memory.
- `GET /api/memories?query=...&namespace=...&limit=...` to retrieve matches.

## Environment

- `JANGAR_MODELS` (comma-separated list; optional)
- `JANGAR_DEFAULT_MODEL` (optional)
- `JANGAR_REDIS_URL` (required only when using `x-openwebui-chat-id` thread persistence)
- `JANGAR_STATEFUL_CHAT_MODE` (optional; set to `1` to enable additive OpenWebUI transcript handling + reset-on-edit)
- `JANGAR_CHAT_KEY_PREFIX` (optional; defaults to `openwebui:chat`)
- `JANGAR_WORKTREE_KEY_PREFIX` (optional; defaults to `openwebui:worktree`)
- `JANGAR_TRANSCRIPT_KEY_PREFIX` (optional; defaults to `openwebui:transcript`)
- `JANGAR_MCP_URL` (optional; defaults to `http://127.0.0.1:$PORT/mcp`)
- `DATABASE_URL` (required to use MCP memories tools)
- `PGSSLMODE` (optional; defaults to `require`; Jangar does not support `sslrootcert` URL params for Bun’s Postgres client)
- `OPENAI_API_KEY` (API key used for embedding calls; required for hosted OpenAI, optional for self-hosted OpenAI-compatible endpoints like Ollama)
- `OPENAI_API_BASE_URL` / `OPENAI_API_BASE` (optional; defaults to `https://api.openai.com/v1`)
- `OPENAI_EMBEDDING_MODEL` (optional; defaults to `text-embedding-3-small` on OpenAI, or `qwen3-embedding-saigak:0.6b` for self-hosted bases)
- `OPENAI_EMBEDDING_DIMENSION` (optional; defaults to `1536` on OpenAI, or `1024` for the self-hosted model)
- `OPENAI_EMBEDDING_TIMEOUT_MS` (optional; defaults to `15000`)
- `OPENAI_EMBEDDING_MAX_INPUT_CHARS` (optional; defaults to `60000`)

### Ollama embeddings (docker-host)

To use the self-hosted embeddings model on `docker-host`:

```bash
export OPENAI_API_BASE_URL='http://192.168.1.190:11434/v1'
export OPENAI_EMBEDDING_MODEL='qwen3-embedding-saigak:0.6b'
export OPENAI_EMBEDDING_DIMENSION='1024'
# OPENAI_API_KEY is optional for Ollama
```
