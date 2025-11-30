# Jangar Implementation Plan (sync point)

Date: 2025-11-24 (updated 2025-11-30)  
Context: use this plan to split work across Codex agents/Argo jobs. Markers use the format `JNG-###` and appear in code as `TODO(jng-###)`. Source code is the source of truth; statuses below match what is currently implemented.

## Workstream map

- **JNG-001 Foundations:** Codex SDK env passthrough + shared types.
- **JNG-010 Toolbelt:** `packages/cx-tools` CLIs (`cx-codex-run`, workflow helpers, optional `cx-log`).
- **JNG-020 Persistence:** Convex schema + mutations for conversations/turns/messages/reasoning/commands/usage/rate limits/events.
- **JNG-030 Activities:** `runCodexTurnActivity` (meta turn) + `publishEventActivity` (SSE/log fan-out).
- **JNG-040 Worker activity:** `runWorkerTaskActivity` (clone repo, worker Codex, lint/test, push, PR).
- **JNG-050 Workflow:** `codexOrchestrationWorkflow` loop, signals/queries, depth/turn limits.
- **JNG-060 HTTP/SSE:** REST + SSE endpoints; OpenAI proxy → app-server bridge.
- **JNG-070 UI:** TanStack Start shell + OpenWebUI wiring to proxy.
- **JNG-080 Infra/Build:** Image assembly, kustomize/Argo updates, OpenWebUI sidecar, CNPG.
- **JNG-090 Testing/QA:** Unit, integration (Temporal dev), E2E happy-path + failure-path.

## Assignment-ready task list (status = current code)

### JNG-001 Foundations (in progress)

- ✅ `env?: Record<string, string>` is plumbed through the Codex SDK to `codex-exec` spawn env.
- ⏳ TODO(jng-001): Export helper to merge base env + turn-specific env (`services/jangar/src/services/env.ts`), and wire CODEX_API_KEY/CODEX_PATH once secrets are finalized.

### JNG-010 Toolbelt (`packages/cx-tools`)

- 🚧 Not started. `packages/cx-tools` only exports a `notImplemented` placeholder; no CLIs exist.
- TODO(jng-010a): Implement `cx-codex-run` CLI; flags `--prompt/--file`, `--images`, `--model`, `--sandbox`, `--cwd`, `--depth`, `--env KEY=VAL`, `--json`. Streams JSON lines.
- TODO(jng-010b): Implement workflow CLIs `cx-workflow-start/signal/query/cancel` (Temporal client wrapper) with env/flag config for namespace/task queue/address.
- TODO(jng-010c): Optional `cx-log` tailer for workflow/activity logs.
- Deliverables: build to `dist/`, expose via `bin`, bundle into image scripts.

### JNG-020 Persistence (Convex)

- ✅ Convex schema exists (`services/jangar/convex/schema.ts`).
- ✅ Mutations exist (`services/jangar/convex/app.ts`) and are invoked by the OpenAI proxy via `services/jangar/src/services/db/index.ts`.
- ⏳ TODO(jng-020a): Add queries/read endpoints for UI/history views.
- ⏳ TODO(jng-020b): Persist worker activity snapshots once worker tasks are implemented.

### JNG-030 Activities (meta turn + events)

- 🚧 Stubs. `runCodexTurnActivity` and `publishEventActivity` return placeholders; no Codex invocation or persistence occurs.
- TODO(jng-030a): Implement `runCodexTurnActivity` (prepare env/workdir, run Codex meta turn, capture events/items/usage, persist snapshot).
- TODO(jng-030b): Implement `publishEventActivity` for SSE/log fan-out.

### JNG-040 Worker activity (implementation delegate)

- 🚧 Stub. `runWorkerTaskActivity` and git helpers are placeholders.
- TODO(jng-040a): Clone repo shallow, create branch `auto/<mission>-<id>`, run worker Codex + lint/tests, push, open PR; return `prUrl/branch/commitSha/notes`.

### JNG-050 Workflow (Temporal)

- 🚧 Stub. Workflow currently schedules a single placeholder turn and returns `{status: 'pending'}` with no signals/queries/worker delegation.
- TODO(jng-050a): Implement loop with maxTurns/depth guardrails, signals (`submitUserMessage`, `abort`), query (`getState`), worker delegation, DB writes.

### JNG-060 HTTP/SSE + OpenAI proxy

- ✅ Streaming OpenAI-compatible proxy (`/openai/v1/chat/completions`, `/openai/v1/models`) plus `/health` are live.
- ⏳ TODO(jng-060a): Mission/workflow REST + SSE endpoints to expose Temporal state once the workflow exists.
- ⏳ TODO(jng-060b): Abort/cancel path and idempotency for long-running worker tasks.

### JNG-070 UI (TanStack Start + OpenWebUI)

- 🚧 Minimal scaffold (welcome + health). No mission list/detail/chat/logs/PR cards; no SSE wiring.
- TODO(jng-070a): Build `/` and `/mission/$id` routes backed by Temporal/Convex data.
- TODO(jng-070b): Surface single orchestrator model in UI copy; link out to OpenWebUI host.

### JNG-080 Infra/Build

- 🚧 Partial. ArgoCD manifests deploy app + worker with Convex URL only; CODEX_API_KEY/GITHUB_TOKEN/Convex deploy/admin keys not present. Image scripts exist but do not yet ensure `cx-tools`/UI dist bundling.
- TODO(jng-080a): Add required secrets/env to manifests (`argocd/applications/jangar/*`).
- TODO(jng-080b): Keep OpenWebUI Helm release pinned; verify Redis/Postgres deps in values.
- TODO(jng-080c): Update `packages/scripts/src/jangar/build-image.ts` & `deploy-service.ts` to bundle `packages/cx-tools/dist`, UI dist, and stamp `JANGAR_VERSION/JANGAR_COMMIT`; keep `convex deploy --yes` pre-step.

### JNG-090 Testing/QA

- 🚧 Partial. Some handler/env tests exist; activities/workflow/git helpers lack coverage.
- TODO(jng-090a): Unit tests for env builder, git helper, activity inputs, DB adapter (beyond current coverage).
- TODO(jng-090b): Integration: Temporal dev workflow end-to-end with sample repo; verify per-turn snapshots.
- TODO(jng-090c): E2E: worker opens PR on sample public repo; UI renders timeline and SSE updates.

## Handoff guidance

- Each TODO marker in code mirrors a JNG task above; claim and close them via PRs referencing this doc.
- Prefer Argo jobs per workstream (e.g., `jngar-wf-030` for Activities) to keep diffs focused.
- Keep env contracts in sync with `services/jangar/src/types/orchestration.ts` and `docs/jangar/design.md`.
