# Jangar Full-Stack Orchestrator — Design

## Overview

Jangar will become a single Bun-based service that provides:

- A Temporal workflow that runs **one Codex turn per Activity** (auditable, retryable, visible in history).
- A meta Codex (model `gpt-5.1-codex-max`, `danger-full-access`, network on, approval `never`) that plans and delegates work to worker Codex runs capable of repo changes and PR creation.
- HTTP + SSE APIs and a TanStack Start UI served from the same process for operators to chat and watch execution.
- Persistence in Convex (conversations, turns, messages, reasoning, commands, usage, rate limits, events per `docs/jangar/persistence.md`) for chat telemetry and turn history; optional object storage for raw logs.

## Goals

- Per-turn durability: every Codex turn is a Temporal Activity with stored snapshot.
- Full-stack in `services/jangar`: Temporal worker, HTTP/SSE API, UI assets.
- Repo automation: worker Codex runs can clone repos, apply changes, run tests/linters, and open PRs.
- Minimal token overhead: no MCP; use small Bun CLIs for side effects.

## Non-Goals (v1)

- Multi-repo coordination in one workflow.
- Rich RBAC; assume trusted operators.
- Long-term log archival (optional bucket, not mandatory).

- **Split runtime:** The Bun app image (`services/jangar/src/index.ts`) stays the single entrypoint for HTTP/SSE, TanStack Start UI, and the embedded `codex app-server` child. Temporal worker now runs in its own Deployment (same image) so Knative app pods stay lightweight. OpenWebUI is installed via the upstream Helm chart (`open-webui` 8.18.0 / app v0.6.40), which creates a StatefulSet and `open-webui` ClusterIP Service fronted by the Tailscale LB `openwebui` (80→8080). Websocket fan-out is backed by a Redis instance (`jangar-openwebui-redis`) managed by the OT-Container-Kit Redis operator. It reuses the CNPG cluster `jangar-db` for Postgres. The Jangar UI links out (no proxy/embed); OpenWebUI calls Jangar’s OpenAI-compatible endpoint for models/completions over the cluster-local service.
- **Workflow:** `codexOrchestrationWorkflow` loops, invoking `runCodexTurnActivity` for each turn; delegates worker tasks via `runWorkerTaskActivity`; exposes signals/queries.
- **Activities:**
  - `runCodexTurnActivity`: run one Codex turn with configured sandbox/model/env; returns events + snapshot.
  - `runWorkerTaskActivity`: clone repo, execute worker Codex, run lint/tests, push branch, open PR.
  - Optional `publishEventActivity` to push deltas to SSE broker.
- **Toolbelt:** `packages/cx-tools` Bun CLIs (`cx-codex-run`, `cx-workflow-*`, optional `cx-log`) emitting single-line JSON; used by Codex shell calls instead of MCP.
- **Persistence:** Convex collections `conversations`, `turns`, `messages`, `reasoning_sections`, `commands`/`command_chunks`, `usage_snapshots`, `rate_limits`, and `events_raw` (see `docs/jangar/persistence.md`) to store OpenAI proxy traffic, tool calls, usage, and audit events; optional bucket for raw event logs. OpenWebUI chat IDs map to `conversations.conversationId`; Codex thread IDs are stored on conversations/turns when provided.
- **Orchestrator UI:** TanStack Start shell plus OpenWebUI front-end pointed at our OpenAI-compatible proxy; exposes a `meta-orchestrator` model that routes into the workflow.

## Diagrams

### Turn-by-turn flow

```mermaid
sequenceDiagram
    participant U as Operator
    participant UI as Orchestrator (TanStack + OpenWebUI)
    participant API as HTTP/SSE server
    participant WF as Temporal Workflow
    participant ACT as runCodexTurnActivity
    participant CX as Meta Codex (gpt-5.1-max)
    participant TB as cx-* toolbelt
    participant WK as Worker Codex
    participant GH as GitHub/Repo

    U->>UI: Send messages
    UI->>API: POST /orchestrations, /message
    API->>WF: start workflow / signal
    loop per turn
        WF->>ACT: schedule turn (state + user msgs)
        ACT->>CX: run turn (danger-full-access, net on)
    CX->>TB: invoke cx-codex-run / workflow / git helpers
    CX-->>ACT: events + finalResponse
    ACT-->>WF: turn snapshot
        WF-->>API: state delta (query/push)
        API-->>UI: SSE update to chat/plan
    end
    CX->>WK: delegate implementation (worker activity)
    WK->>GH: push branch + open PR
    GH-->>UI: PR link/status via workflow state
```

### Deployment view (current)

```mermaid
flowchart TD
    subgraph NS["K8s namespace: jangar"]
        KS["Knative Service: jangar<br/>cluster-local LB"] --> APPPOD
        subgraph APPPOD["Pod: app"]
            S["Bun server.ts<br/>HTTP + SSE + /openwebui proxy"]
            UIA["TanStack Start assets"]
            APP["codex app-server child<br/>JSON-RPC stdio"]
            CXB["cx-tools dist"]
        end
        subgraph WDPOD["Pod: worker"]
            W["Temporal Worker<br/>(bun run src/worker.ts)"]
        end
        subgraph OWPOD["Pod: openwebui (StatefulSet)"]
            OWUI["OpenWebUI<br/>(helm chart v8.18.0 / app v0.6.40)"]
        end
        OWPOD --> OWDB[("CNPG Cluster: jangar-db")]
        OWPOD --> OWREDIS[("Redis: jangar-openwebui-redis<br/>OTCK operator")]
        APPPOD --> TF["Temporal Frontend svc"]
        WDPOD --> TF
        APPPOD --> GH["GitHub / gh CLI"]
        APPPOD --> TS["Tailscale LB"]
        APPPOD --> B[("Optional object store")]
    end
    KS --> CVX[("Convex cloud<br/>managed")]
```

## Infra Changes (Argo/CD)

- No in-cluster database for Jangar state. Persist telemetry in Convex; provision a `production` deployment (cloud or self-hosted via ArgoCD `argocd/applications/convex`). Create a service user deploy key with write access.
- `argocd/applications/jangar/kservice.yaml` updates:
  - Env: `CONVEX_DEPLOYMENT` (e.g., `https://<deploy-id>.convex.cloud`), `CONVEX_DEPLOY_KEY` (Convex deploy key), `CODEX_API_KEY`, `GITHUB_TOKEN`; optional `CODEX_PATH`, `GH_HOST`, `GH_REPO`.
  - Keep Tailscale LB; containerPort 8080 serves HTTP/API/UI.
- OpenWebUI is installed separately via Helm (StatefulSet + `open-webui` Service, exposed via `openwebui` Tailscale LB) and backed by Redis/Postgres from the platform stack. Jangar data remains in Convex.
- Optional: bucket creds (MinIO) for log archival; or small Redis for SSE fan-out (otherwise in-process emitter).

## Component Design (code paths)

1) **Codex wrapper env passthrough**
   - `packages/codex/src/options.ts`: add `env?: Record<string,string>` to `CodexOptions`.
   - `packages/codex/src/codex-exec.ts`: pass provided env to `spawn` (fallback `process.env`).
   - Re-export in `packages/codex/src/index.ts`.

2) **Toolbelt (no MCP)** — `packages/cx-tools`
   - CLIs: `cx-codex-run`, `cx-workflow-start`, `cx-workflow-signal`, `cx-workflow-query`, `cx-workflow-cancel`, optional `cx-log`.
   - Flags only; outputs single-line JSON.
   - Guard shell wrapper/allowlist for Codex-run commands.
   - Build to `packages/cx-tools/dist`; expose via package `bin`.

3) **Activities** — `services/jangar/src/activities`
   - `run-codex-turn.ts`: inputs `{threadId?, prompt, images?, depth, repoUrl?, workdir?, userMessages?, constraints?}`.
     - Prepare temp `CODEX_HOME`, temp workdir (clone if repoUrl).
     - Env: `CODEX_API_KEY`, optional `CODEX_PATH`, prepend toolbelt `bin`, set `CX_DEPTH`.
     - Run Codex turn with `model gpt-5.1-max`, `sandbox danger-full-access`, `networkAccessEnabled true`, `approvalPolicy never`.
     - Capture events; return snapshot `{threadId, finalResponse, items, usage, planSummary?, filesTouched?, commandsRun?}`.

- `run-worker-task.ts`: inputs `{repoUrl, task, depth, baseBranch?, tests?, lint?}`.
  - Clone shallow; branch `auto/<mission>-<id>`; run Codex worker (single or small loop), run lint/tests, push, open PR (`gh`/GitHub API); return `{prUrl, branch, commitSha, notes}`.
- Shared helpers in `services/jangar/src/lib/`: git ops, env builders, temp paths.

3.5) **Orchestrator (OpenWebUI front-end, direct host)**

- OpenWebUI runs separately and is accessed via the Tailscale hostname `openwebui`. The Jangar UI links out; no iframe/proxy is used.
- OpenWebUI is configured to point its OpenAI base URL to the cluster-local Jangar endpoint (e.g., `http://jangar.jangar.svc.cluster.local/openai/v1`). That endpoint translates `/v1/chat/completions` into Codex app-server JSON-RPC calls and streams deltas back in OpenAI format.
- Default model offered to OpenWebUI remains the single orchestrator model (mapped to `gpt-5.1-codex-max`). `/v1/models` returns only that entry.
- App-server is spawned once per pod; conversations can be mapped to Convex thread IDs for persistence as needed.

4) **Workflow** — `services/jangar/src/workflows/index.ts`
   - `codexOrchestrationWorkflow` input `{topic, repoUrl, constraints?, depth=1, maxTurns=8}`.
   - State: `threadId`, `turns[]`, `workerPRs[]`, `status`, `lastUpdated`.
   - Loop: call `runCodexTurnActivity`; append snapshot; stop on “done” or maxTurns.
   - Delegate worker tasks via `runWorkerTaskActivity` when planner requests; feed results into next prompt.
   - Signals: `submitUserMessage`, `abort`. Queries: `getState`.

5) **Persistence layer** — Convex functions (see `docs/jangar/persistence.md`)
   - Collections: `conversations`, `turns`, `messages`, `reasoning_sections`, `commands`/`command_chunks`, `usage_snapshots`, `rate_limits`, `events_raw`.
   - Server mutations implemented: `app:upsertConversation`, `app:upsertTurn`, `app:appendMessage`, `app:appendReasoningSection`, `app:upsertCommand`, `app:appendCommandChunk`, `app:appendUsageSnapshot`, `app:appendRateLimit`, `app:appendEvent`.
   - Indexing: conversations by `conversationId`; turns by `conversationId`, `chatId`, `turnId`; commands by `turnId` and `callId`; usage/rate limits by `turnId`; events by `conversationId, receivedAt`.
   - Env: `CONVEX_URL`/`CONVEX_DEPLOYMENT`, `CONVEX_DEPLOY_KEY` (or admin key), optional `CONVEX_SELF_HOSTED_URL`/`CONVEX_SITE_ORIGIN` for self-hosted; `VITE_CONVEX_URL` for dev.
   - The Bun service calls Convex via the official JS client; the OpenAI proxy and Codex stream persistence write usage/events/commands into Convex.
   - Optional bucket writes remain for raw logs; Convex is the source of truth for chat telemetry.

    ```mermaid
    flowchart LR
      UI["TanStack Start UI<br/>(services/jangar/src/ui)"] --> API["Start server (OpenAI proxy)<br/>services/jangar/src/app"]
      API --> CVX[("Convex mutations/queries")]
      API --> Temporal["Temporal Workflows<br/>services/jangar/src/workflows"]
      Temporal --> Activities["Activities<br/>services/jangar/src/activities"]
      Activities --> CVX
      Activities -->|optional| Bucket[("Object store")]
      API -. SSE .-> UI
    ```

6) **HTTP + SSE** — TanStack Start server routes (see `services/jangar/src/app/routes`)
 - `GET /health` → static ok payload.
 - `GET /openai/v1/models` → returns supported Codex models.
 - `POST /openai/v1/chat/completions` → OpenAI-compatible streaming proxy to `codex app-server`, persisting turns/usage/events into Convex.
 - SSE/mission REST endpoints are not yet implemented; workflow creation currently happens via Temporal SDK/activities (stub).

7) **UI (Orchestrator — TanStack Start + OpenWebUI)** — `services/jangar/src/ui/`
   - Routes: `/` (mission list), `/mission/$id` (chat, plan timeline, activity log, PR card).
   - TanStack Query for REST; SSE hook merges deltas.
   - OpenWebUI is linked out to the dedicated host (`openwebui` via Tailscale) instead of being embedded or proxied. The mission view can surface a CTA/link; assets for the orchestrator UI remain served by `server.ts`.

8) **Build & Deploy**
   - `packages/scripts/src/jangar/build-image.ts`: bundle `packages/cx-tools/dist`, `services/jangar/dist/ui`, run entry `bun run src/index.ts`.
   - Install Codex CLI inside the image (download official release or pre-bundled binary) so `codex app-server` and `codex exec` are available at runtime.
   - Deploy Convex functions first (`bunx convex deploy --yes` in `services/jangar`), then apply Kustomize for the service + OpenWebUI (cluster-local). Convex may be cloud or the existing self-hosted stack under `argocd/applications/convex`.

## Data & State

- Temporal history: authoritative per-turn events (planned once workflow loop lands).
- Convex: telemetry for conversations, turns, messages, reasoning sections, command logs, usage, rate limits, and raw events streamed from the OpenAI proxy.
- Optional bucket: raw event logs/streams (if enabled).

## Defaults & Guardrails

- Depth limit via `CX_DEPTH`; block if exceeded.
- Allowlisted commands only (`cx-*`, `git`, `gh`, minimal OS tools) when Codex shells.
- Activity timeout (e.g., 20 min); workflow `maxTurns` default 8.
- Sandbox `danger-full-access`; network on; approval `never` for meta; worker may reuse or downgrade per call.
- Model: `gpt-5.1-max` for meta; worker configurable.

## Testing Strategy

- Unit: toolbelt CLIs, env builder, git helper, Convex client layer.
- Integration: Temporal dev; run workflow end-to-end; verify each turn is an Activity and snapshots persist.
- E2E: sample public repo; worker opens PR; UI shows turn timeline.

## Open Questions

- Auth path for PRs (`gh` vs GitHub REST/app token); finalize env contract.
- Raw event log storage location (bucket vs none).
- Repo-specific lint/test commands—config-driven or prompt-driven?
- SSE fan-out scaling—stick to in-process emitter or add Redis.

## Implementation Order (recommended)

1) Codex env passthrough.
2) Toolbelt scaffold (`cx-codex-run`, `cx-workflow-start`).
3) `run-codex-turn` activity + helpers.
4) Workflow loop with signals/queries.
5) DB layer + migrations.
6) HTTP/SSE endpoints.
7) Worker task activity (clone/PR).
8) TanStack Start UI wiring.
9) Build/deploy updates; smoke tests.
