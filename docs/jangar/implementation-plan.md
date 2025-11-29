# Jangar Implementation Plan (sync point)

Date: 2025-11-24  
Context: use this plan to split work across Codex agents/Argo jobs. Markers use the format `JNG-###` and appear in code as `TODO(jng-###)`.

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

## Assignment-ready task list

### JNG-001 Foundations (in progress)

- ✅ Add `env?: Record<string, string>` to Codex options and pass through to `codex-exec` spawn env.
- TODO(jng-001): Export helper to merge base env + turn-specific env (see `services/jangar/src/lib/env.ts`).

### JNG-010 Toolbelt (`packages/cx-tools`)

- TODO(jng-010a): Implement `cx-codex-run` CLI; flags: `--prompt/--file`, `--images`, `--model`, `--sandbox`, `--cwd`, `--depth`, `--env KEY=VAL`, `--json`. Streams JSON lines.
- TODO(jng-010b): Implement workflow CLIs: `cx-workflow-start`, `cx-workflow-signal`, `cx-workflow-query`, `cx-workflow-cancel` (Temporal client wrapper). Config via env/flags for namespace/task queue/address.
- TODO(jng-010c): Optional `cx-log` (tail workflow/activity logs) for debugging.
- Outputs: compiled to `packages/cx-tools/dist`, binaries exposed via `bin` field; consumed by activities and server proxy.

### JNG-020 Persistence (Convex)

- ✅ Define Convex schema in `services/jangar/convex/schema.ts` for conversations, turns, messages, reasoning sections, commands/command_chunks, usage_snapshots, rate_limits, events_raw.
- ✅ Implement mutations in `services/jangar/convex/app.ts` and client wrapper in `services/jangar/src/db/index.ts` used by the OpenAI proxy.
- TODO(jng-020a): Add queries as needed for UI/history views once workflow/state pages land.
- TODO(jng-020b): Expand persistence to capture worker activity snapshots when worker tasks exist.

### JNG-030 Activities (meta turn + events)

- TODO(jng-030a): Implement `runCodexTurnActivity` in `services/jangar/src/activities/run-codex-turn.ts`:
  - Prepare temp `CODEX_HOME`, optional repo clone into temp workdir, set `CX_DEPTH`, inject toolbelt `PATH`.
- Invoke Codex meta turn (`gpt-5.1-codex-max`, sandbox `danger-full-access`, approval `never`, network on), capture events, items, usage.
  - Persist snapshot via DB helper; return `RunCodexTurnResult`.
- TODO(jng-030b): Implement `publishEventActivity` (SSE/log fan-out) stubbed in `services/jangar/src/activities/publish-event.ts`.

### JNG-040 Worker activity (implementation delegate)

- TODO(jng-040a): Implement `runWorkerTaskActivity` in `services/jangar/src/activities/run-worker-task.ts`:
  - Clone repo shallow, create branch `auto/<mission>-<id>`.
  - Run worker Codex turn/loop with provided depth; run lint/tests; push branch; open PR via `gh` or REST.
  - Return `WorkerTaskResult` with `prUrl`, `branch`, `commitSha`, `notes`.

### JNG-050 Workflow (Temporal)

- TODO(jng-050a): Flesh `codexOrchestrationWorkflow` in `services/jangar/src/workflows/orchestration.ts`:
  - Input `{topic, repoUrl, constraints?, depth=1, maxTurns=8}`.
  - Loop until done/max; schedule `runCodexTurnActivity`; capture snapshots; delegate worker tasks when requested; support signals (`submitUserMessage`, `abort`) and query (`getState`).
  - Enforce depth/turn guardrails; write state to DB.

### JNG-060 HTTP/SSE + OpenAI proxy

- ✅ OpenAI-compatible proxy routes (`/openai/v1/chat/completions`, `/openai/v1/models`) in TanStack Start server, bridging to `codex app-server` and persisting telemetry.
- ✅ Health route (`/health`).
- TODO(jng-060a): Add mission/workflow REST + SSE endpoints once workflow loop exists; reconcile with Convex queries.
- TODO(jng-060b): Add abort/cancel path and idempotency for long-running worker tasks.

### JNG-070 UI (TanStack Start + OpenWebUI)

- TODO(jng-070a): Scaffold TanStack Start app under `services/jangar/src/ui/` with routes `/`, `/mission/$id` (list/detail/chat/logs/PR card).
- TODO(jng-070b): Point OpenWebUI sidecar at proxy; ensure single model `meta-orchestrator`.

### JNG-080 Infra/Build

- TODO(jng-080a): Ensure `argocd/applications/jangar/kservice.yaml` carries Convex env (`CONVEX_DEPLOYMENT`, `CONVEX_DEPLOY_KEY` or self-hosted), `CODEX_API_KEY`, `GITHUB_TOKEN`, and OpenWebUI host vars.
- TODO(jng-080b): Keep OpenWebUI Helm release pinned; verify Redis/Postgres dependencies in values.
- TODO(jng-080c): Update `packages/scripts/src/jangar/build-image.ts` & `deploy-service.ts` to bundle `packages/cx-tools/dist`, UI dist, and stamp `JANGAR_VERSION/JANGAR_COMMIT`; preserve `convex deploy --yes` pre-step.

### JNG-090 Testing/QA

- TODO(jng-090a): Unit tests for env builder, git helper, activity inputs, DB adapter.
- TODO(jng-090b): Integration: Temporal dev workflow end-to-end with sample repo; verify per-turn snapshots.
- TODO(jng-090c): E2E: worker opens PR on sample public repo; UI renders timeline and SSE updates.

## Handoff guidance

- Each TODO marker in code mirrors a JNG task above; claim and close them via PRs referencing this doc.
- Prefer Argo jobs per workstream (e.g., `jngar-wf-030` for Activities) to keep diffs focused.
- Keep env contracts in sync with `services/jangar/src/types/orchestration.ts` and `docs/jangar/design.md`.
