# Jangar Application Tech Debt Cleanup Plan

Status: Proposed (2026-04-08)

## Executive summary

Jangar is now on Vite 8 + React and the build/deploy path is healthy, but the application still carries substantial pre-migration debt. The biggest issues are not compile failures. They are architectural: background runtimes are started implicitly inside the web process, Kubernetes operations depend on shelling out to `kubectl`, configuration is fragmented across the codebase, and the React route layer is mostly bespoke state machines instead of a shared data model.

This document proposes an incremental production cleanup, not a rewrite. The plan keeps Bun, H3, Vite, React, and the existing CRD/domain model. The goal is to reduce operational risk, lower the cost of changes, and make the control-plane and operator UI easier to evolve without destabilizing production.

## Scope

This audit covers `services/jangar` application code, its local tests, and the directly adjacent docs that define or describe its runtime behavior. It does not redesign the product surface or replace the deployment model.

## Audit findings

### 1. The web runtime also acts as a side-effectful process supervisor

`services/jangar/src/server/runtime-startup.ts` starts agent comms, the control-plane cache, Torghut quant runtime, and the gRPC server through one global singleton. `ensureRuntimeStartup()` mutates `globalThis` state and installs signal handlers from inside the app runtime bootstrap.

Evidence:
- `services/jangar/src/server/runtime-startup.ts:11-50`

Why this matters:
- Web serving, controller loops, background subscribers, and gRPC lifecycle are coupled.
- Startup order, teardown, and partial failure handling are implicit.
- It is hard to run a narrower profile for local development, tests, or production isolation.

### 2. Kubernetes access is still implemented as shelling out to `kubectl`

The application’s primary Kubernetes gateway is a thin wrapper around `spawn('kubectl', ...)`. That pattern is used in the shared `KubernetesClient`, leader election, controller config, watches, and controller loops.

Evidence:
- `services/jangar/src/server/primitives-kube.ts:1-207`
- `services/jangar/src/server/leader-election.ts:1-241`
- `services/jangar/src/server/supporting-primitives-controller.ts:1-260`
- `services/jangar/src/server/orchestration-controller.ts`
- `services/jangar/src/server/primitives-reconciler.ts`

Why this matters:
- Runtime correctness depends on the presence, version, flags, and stdout/stderr behavior of an external CLI.
- It adds process-spawn overhead and makes retries/error handling string-based.
- It makes controller behavior harder to test and reason about than a typed client boundary would.

### 3. Configuration is fragmented and not validated as one contract

The current `config.ts` only covers model selection for chat, while environment reads are scattered across the app. The source tree currently references 348 distinct environment variables across 77 non-test source files.

Evidence:
- `services/jangar/src/server/config.ts:1-28`
- Config-heavy modules include:
  - `services/jangar/src/server/agents-controller/index.ts`
  - `services/jangar/src/server/codex-judge-config.ts`
  - `services/jangar/src/server/leader-election.ts`
  - `services/jangar/src/server/metrics.ts`
  - `services/jangar/src/server/torghut-whitepapers.ts`

Why this matters:
- Startup misconfiguration becomes runtime behavior instead of startup failure.
- Operators do not have one canonical env contract.
- Tests and docs drift because there is no authoritative schema.

### 4. Several central server modules are too large and mix multiple concerns

Jangar has multiple server modules that are large enough to hide distinct domains and failure modes inside one file.

Evidence:
- `services/jangar/src/server/supporting-primitives-controller.ts` — 3,364 LOC
- `services/jangar/src/server/codex-judge.ts` — 2,726 LOC
- `services/jangar/src/server/control-plane-status.ts` — 2,265 LOC
- `services/jangar/src/server/orchestration-controller.ts` — 2,180 LOC
- `services/jangar/src/server/chat-completion-encoder.ts` — 2,075 LOC
- `services/jangar/src/server/chat.ts` — 1,555 LOC

Why this matters:
- A single change often crosses parsing, orchestration, persistence, metrics, and transport concerns.
- Review quality degrades because files are too broad to reason about locally.
- Testing is forced toward giant integration-style unit tests instead of smaller contract tests.

### 5. The server route registration mechanism is fragile

The H3 server surface is built by scanning route source files with `import.meta.glob`, checking for `source.includes('server:')`, and extracting `createFileRoute(...)` with a regex.

Evidence:
- `services/jangar/src/server/app.ts:37-65`
- `services/jangar/src/server/app.ts:171-197`
- `services/jangar/src/types.d.ts:34-104`

Why this matters:
- Route discovery depends on source text shape, not an explicit typed manifest.
- Refactors that preserve semantics can silently break registration.
- The runtime cannot prove route coverage at build time.

### 6. The frontend route layer underuses TanStack Router and has no shared server-state model

There are no route loaders or `useLoaderData` usages anywhere in `services/jangar/src`. Most screens fetch data manually inside `useEffect` and manage request state locally.

Evidence:
- No `loader:` or `useLoaderData` usage in `services/jangar/src`
- `services/jangar/src/routes/control-plane/implementation-specs/$name.tsx`
  - 882 LOC
  - 19 `useState` calls
  - 6 `useEffect` calls
- `services/jangar/src/routes/github/pulls/$owner/$repo/$number.tsx`
  - 983 LOC
  - 12 `useState` calls
- `services/jangar/src/routes/torghut/trading.tsx`
  - 1,111 LOC
  - manual request ID / abort-controller orchestration
- `services/jangar/src/routes/control-plane/runs/index.tsx`
  - 662 LOC
  - repeated filter, refresh, pagination, and deletion state

Why this matters:
- Loading, refresh, error, polling, and invalidation logic are reimplemented per screen.
- The app is not using the strongest primitives from its own router stack.
- Large operator screens are hard to stabilize because view state and server state are intertwined.

### 7. The control-plane route surface is inflated by placeholder redirects

The `control-plane` route tree contains 42 `.tsx` files, but 36 of them are redirect stubs that simply send the user back to the implementation-specs page.

Evidence:
- `services/jangar/src/components/agents-control-plane-redirect.tsx`
- Redirect-backed routes include most of:
  - `services/jangar/src/routes/control-plane/agents/**`
  - `services/jangar/src/routes/control-plane/approvals/**`
  - `services/jangar/src/routes/control-plane/artifacts/**`
  - `services/jangar/src/routes/control-plane/budgets/**`
  - `services/jangar/src/routes/control-plane/memories/**`
  - `services/jangar/src/routes/control-plane/orchestrations/**`
  - `services/jangar/src/routes/control-plane/schedules/**`
  - `services/jangar/src/routes/control-plane/signals/**`
  - `services/jangar/src/routes/control-plane/workspaces/**`

Why this matters:
- The route tree implies a broad product surface that does not actually exist.
- It increases generated route noise and operator confusion.
- It obscures which control-plane objects are truly supported workflows.

### 8. Frontend abstractions exist, but only part of the UI uses them

The app already has reusable control-plane fetchers and primitive views, but adoption is inconsistent. Some screens use `src/data/*` wrappers and shared primitives; others fetch directly in components or routes.

Evidence:
- Shared helpers:
  - `services/jangar/src/data/agents-control-plane.ts`
  - `services/jangar/src/data/github.ts`
  - `services/jangar/src/components/agents-control-plane-primitives.tsx`
  - `services/jangar/src/components/agents-control-plane-overview.tsx`
- Direct-fetch UI components still exist:
  - `services/jangar/src/components/app-sidebar.tsx:123-149`
  - `services/jangar/src/components/json-response-view.tsx:11-47`
  - `services/jangar/src/routes/index.tsx`
  - `services/jangar/src/routes/torghut/trading.tsx:269-379`

Why this matters:
- There is no consistent boundary between API transport, normalization, and rendering.
- Improvements to error handling, retries, or caching have to be done screen by screen.

### 9. The memory subsystem has silent degraded behavior that can corrupt semantics

`memory-provider.ts` silently generates fake embeddings when the OpenAI embedding endpoint is not configured or returns the wrong dimension. It also creates a fresh Postgres `Pool` per operation.

Evidence:
- `services/jangar/src/server/memory-provider.ts:63-105`
- `services/jangar/src/server/memory-provider.ts:154-210`

Why this matters:
- Production can appear healthy while indexing/query quality is wrong.
- Fallback embeddings hide misconfiguration instead of surfacing it.
- Per-operation pool creation increases connection churn and latency.

### 10. Build and deploy debt is still packed into large, app-specific scripts and images

The migration fixed the biggest CI hot path, but the build and release surfaces are still much larger and more tightly coupled than they should be for one application.

Evidence:
- `services/jangar/Dockerfile` — 626 LOC
- `.github/workflows/jangar-build-push.yaml` — 178 LOC
- `packages/scripts/src/jangar/verify-deployment.ts` — 445 LOC
- `argocd/applications/jangar/deployment.yaml` — 437 LOC
- `argocd/applications/jangar/jangar-worker-deployment.yaml` — 225 LOC

Why this matters:
- Application build logic, developer tooling, runtime packaging, and release verification are still encoded as Jangar-specific imperative code instead of smaller reusable contracts.
- Runtime image concerns are mixed with operator tooling and workstation bootstrap concerns.
- Rollout safety depends on bespoke scripts that parse manifests and shell out to cluster CLIs.

### 11. Tests are strongest in server units but weak on the highest-value operator flows

The server has strong unit coverage, but the browser coverage does not focus on the most stateful production screens. The generic UI route suite covers home, memories, atlas, API health/models, Torghut symbols, and GitHub pulls, but not control-plane spec execution or Torghut trading.

Evidence:
- Broad server test coverage under `services/jangar/src/server/__tests__`
- Browser snapshot coverage in `services/jangar/tests/ui/ui-routes.spec.ts`
  - routes covered include `/`, `/memories`, `/atlas/*`, `/api/models`, `/api/health`, `/torghut/symbols`, `/github/pulls`, and PR detail
- No direct test targets for:
  - `/control-plane/implementation-specs/$name`
  - `/control-plane/runs`
  - `/torghut/trading`

Why this matters:
- The screens with the most local state and the highest operational leverage are least protected.
- Regressions in operator workflows are more likely to escape unit tests.

### 12. Documentation has drifted away from the actual runtime shape

The public Jangar docs are no longer a reliable mental model. For example, the README describes both streaming and non-stream chat completions, the older current-state doc still says “streaming only,” and the chat module contains both code paths plus tests for non-stream conversion.

Evidence:
- `services/jangar/README.md:194-201`
- `docs/jangar/current-state.md`
- `services/jangar/src/server/chat.ts`
- `services/jangar/src/server/__tests__/chat-completions.test.ts:528-610`

Why this matters:
- On-call and contributors cannot trust one authoritative application contract.
- Cleanup work risks reintroducing drift unless the docs are tied to code ownership.

## Goals

1. Separate web serving, controller/background work, and operational adapters into explicit runtime profiles.
2. Replace shell-driven Kubernetes behavior in the hot path with a typed gateway.
3. Centralize and validate Jangar configuration at startup.
4. Introduce a consistent frontend server-state model using the existing TanStack stack.
5. Reduce the size and scope of the biggest server and route modules.
6. Align browser coverage with the highest-value operator flows.
7. Simplify build, packaging, and rollout verification so application changes do not require editing large imperative scripts.
8. Make the app’s docs match the runtime contract again.

## Non-goals

1. Replacing Bun, H3, Vite, or React.
2. Rewriting the entire control plane into separate services in one step.
3. Replacing the CRD/resource model.
4. Redesigning Torghut or Codex product workflows as part of the cleanup.

## Target architecture

### Runtime boundaries

Split Jangar into explicit boot profiles inside the same package:

- `web`
  - UI routes
  - API routes
  - websocket surface
- `controllers`
  - agents/orchestration/supporting/primitives controllers
  - leader election
  - watch loops
- `worker`
  - Temporal worker and workflow-facing background tasks
- `integrations`
  - optional gRPC server
  - agent comms subscriber
  - Torghut quant runtime

Each profile should expose:

- `start()`
- `stop()`
- `health()`
- a typed dependency graph

This replaces implicit `globalThis` startup with explicit composition.

### Platform boundaries

Introduce stable adapters under a platform layer:

- `config/`
- `kube/`
- `db/`
- `metrics/`
- `git/`
- `cache/redis/`
- `external/openai/`
- `external/github/`

The immediate goal is not to perfect the hierarchy. The goal is to stop every large domain module from reading env, calling `kubectl`, opening connections, and formatting transport responses directly.

### Frontend boundaries

Use TanStack Router as the primary data orchestration layer:

- route loaders for initial page data
- a shared query cache for refetch/invalidation where pages stay interactive after first load
- domain hooks for mutations and polling
- shared presentational primitives below those hooks

The control-plane screens should sit on top of one normalized control-plane client instead of mixing route-local fetch, `window` events, and screen-specific parsing.

## Proposed workstreams

### Workstream 0: Baseline and guardrails

Deliverables:

- Publish this plan and a short “source of truth” pointer from `services/jangar/README.md`.
- Add a lightweight architecture inventory:
  - top 20 largest app modules
  - runtime profiles
  - supported control-plane routes
- Add CI checks that fail on stale docs for core public contracts where feasible.

Validation:

- `bun run --cwd services/jangar test`
- `bun run --cwd services/jangar tsc`
- `bun run --cwd services/jangar build`

### Workstream 1: Typed config and runtime lifecycle

Deliverables:

- Replace ad hoc env reads with domain config modules:
  - `chatConfig`
  - `controllerConfig`
  - `githubReviewConfig`
  - `torghutConfig`
  - `metricsConfig`
- Add one startup validation phase that fails fast on required production settings.
- Introduce explicit runtime profiles with teardown support.
- Move `ensureRuntimeStartup()` side effects into a boot module selected by entrypoint.

Validation:

- Unit tests for each config schema
- startup smoke tests per profile
- `bun run --cwd services/jangar test`
- `bun run --cwd services/jangar build`

### Workstream 2: Kubernetes gateway hardening

Deliverables:

- Introduce a `KubeGateway` interface with:
  - typed reads/writes
  - watch semantics
  - consistent retry/error classification
- Keep the current `kubectl` implementation as a temporary compatibility adapter.
- Migrate hot paths first:
  - leader election
  - controller CRD checks
  - control-plane status reads
  - primitive CRUD endpoints
- Remove CLI parsing from request-path code once the typed gateway is stable.

Validation:

- adapter contract tests with recorded success/error fixtures
- controller integration tests against a fake gateway
- `bun run --cwd services/jangar test`

### Workstream 3: Server module decomposition

Deliverables:

- Split `chat.ts` into:
  - request validation / contract
  - conversation state
  - prompt/transcript shaping
  - response transport conversion
  - OpenWebUI detail-link behavior
- Split `control-plane-status.ts` into collectors:
  - controller health
  - rollout health
  - workflow reliability
  - dependency quorum
  - execution trust
- Split `codex-judge.ts` and controller files into orchestration services plus transport adapters.
- Introduce module-size guardrails for new files.

Suggested threshold:

- no new file above 800 LOC
- legacy files only shrink, never grow

Validation:

- existing unit tests stay green
- new contract tests per extracted service
- no behavior change in deployed smoke tests

### Workstream 4: Frontend data model and route rationalization

Deliverables:

- Introduce route loaders and shared data hooks for:
  - control-plane spec/run pages
  - GitHub PR detail
  - Torghut trading
  - terminals
- Consolidate ad hoc `fetch` logic into `src/data/*` or a new domain client layer.
- Collapse redirect-only control-plane routes until their pages exist, or implement them on top of shared primitive pages.
- Make one canonical navigation map instead of route aliases pretending to be full pages.

Validation:

- add direct tests for:
  - `/control-plane/implementation-specs/$name`
  - `/control-plane/runs`
  - `/torghut/trading`
  - `/github/pulls/$owner/$repo/$number`
- keep `ui-routes.spec.ts` for visual smoke, but add behavior-focused tests for these flows

### Workstream 5: Memory and data-plane hardening

Deliverables:

- Replace fake embedding fallback with explicit dev/test-only behavior.
- Fail closed in production when embeddings are misconfigured or dimension-mismatched.
- Introduce pooled memory storage clients instead of per-call `Pool` creation.
- Add health/readiness signals for memory backends where they affect user-facing workflows.

Validation:

- regression tests for misconfiguration paths
- load test for repeated memory writes/queries
- production smoke for memory-backed flows

### Workstream 6: Build, packaging, and rollout simplification

Deliverables:

- Split Jangar runtime packaging from developer-tooling packaging:
  - one runtime image contract
  - one optional tools/base image contract
- Reduce Jangar-specific script logic in release and verification flows by moving shared logic into reusable helpers.
- Replace ad hoc YAML scanning/parsing in rollout verification with typed manifest readers.
- Document the canonical build contract:
  - inputs
  - outputs
  - required artifacts
  - runtime image expectations

Validation:

- `bun run packages/scripts/src/jangar/build-images.ts`
- `bun run packages/scripts/src/jangar/verify-deployment.ts --help`
- `bun run --cwd services/jangar build`
- `gh workflow run jangar-build-push --ref <branch>` for rehearsal when needed

### Workstream 7: Documentation and ownership cleanup

Deliverables:

- Replace stale “current state” notes with one authoritative application architecture index.
- Mark which docs are historical and which are operationally current.
- Tie code-owner responsibility to:
  - runtime
  - controllers
  - control-plane UI
  - GitHub review surface
  - Torghut UI/data

Validation:

- docs reviewed in the same PRs that change runtime contracts
- no conflicting endpoint claims between README, design docs, and tests

## Recommended sequencing

1. Workstream 0
2. Workstream 1
3. Workstream 2
4. Workstream 3 and Workstream 4 in parallel
5. Workstream 5
6. Workstream 6
7. Workstream 7 continuously across the program

Rationale:

- Runtime lifecycle and config must be stabilized before deeper decomposition.
- The Kubernetes boundary is the biggest operational risk and should be addressed before frontend polish.
- Frontend cleanup is highest leverage after the server/platform contracts stop moving underneath it.

## Success criteria

The cleanup should be considered successful only when these are true:

1. Jangar has explicit runtime profiles and does not rely on implicit global startup for background services.
2. Request-path and controller-core Kubernetes operations no longer shell out to `kubectl`.
3. All production env vars are declared in typed config modules with startup validation.
4. The largest operator routes use loaders/shared data hooks instead of bespoke effect-driven fetch orchestration.
5. The redirect-only control-plane route surface is either removed or backed by real pages.
6. Memory embeddings fail loudly in production when misconfigured.
7. Runtime packaging and rollout verification use reusable contracts instead of Jangar-only imperative glue.
8. The highest-value operator flows have direct browser or integration tests.
9. README and current architecture docs no longer contradict runtime behavior.

## Risks and mitigations

### Risk: Cleanup churn slows feature work

Mitigation:
- Use bounded workstreams with thin vertical slices.
- Prefer extracting stable interfaces first, not moving every file at once.

### Risk: Controller isolation changes rollout behavior

Mitigation:
- Gate new runtime profiles behind deployment flags.
- Run shadow mode for controller reads before controller writes move.

### Risk: Frontend refactors break operator workflows

Mitigation:
- Add flow-specific browser tests before major screen rewrites.
- Migrate one page family at a time.

### Risk: Typed config exposes hidden production drift

Mitigation:
- Add warning-only startup reporting first.
- Switch to fail-fast only after manifests and secrets are aligned.

## Concrete next steps

1. Create a `jangar-runtime-foundation` milestone that covers Workstreams 0 and 1.
2. Land a typed config inventory PR with no behavior change.
3. Introduce a `KubeGateway` interface and migrate one path (`control-plane-status`) as the proving ground.
4. Refactor `/control-plane/implementation-specs/$name` into loader + hook + presentational sections.
5. Add direct browser coverage for `/control-plane/implementation-specs/$name` and `/torghut/trading`.
6. Open a follow-up packaging PR that documents the current image/runtime contract and trims Jangar-specific release script duplication.

## Appendix: audit evidence snapshot

- Top-level scale snapshot:
  - `services/jangar/src/routes` — 201 files / 25,169 LOC
  - `services/jangar/src/components` — 25 files / 5,567 LOC
  - `services/jangar/src/server` — 268 files / 94,788 LOC
  - `services/jangar/src/routeTree.gen.ts` — 4,098 LOC generated
- Router/data-loading snapshot:
  - 106 `server: {}` route modules under `services/jangar/src/routes`
  - 0 TanStack route loaders in `services/jangar/src/routes`
  - 0 `QueryClient` / TanStack Query usage in `services/jangar/src`
  - 65 `useEffect(` occurrences across routes and components
- Largest server modules:
  - `services/jangar/src/server/supporting-primitives-controller.ts` — 3,364 LOC
  - `services/jangar/src/server/codex-judge.ts` — 2,726 LOC
  - `services/jangar/src/server/control-plane-status.ts` — 2,265 LOC
  - `services/jangar/src/server/orchestration-controller.ts` — 2,180 LOC
  - `services/jangar/src/server/chat.ts` — 1,555 LOC
- Largest route modules:
  - `services/jangar/src/routes/torghut/trading.tsx` — 1,111 LOC
  - `services/jangar/src/routes/github/pulls/$owner/$repo/$number.tsx` — 983 LOC
  - `services/jangar/src/routes/control-plane/implementation-specs/$name.tsx` — 882 LOC
  - `services/jangar/src/routes/atlas/search.tsx` — 890 LOC
- Largest components:
  - `services/jangar/src/components/agents-control-plane-overview.tsx` — 709 LOC
  - `services/jangar/src/components/terminal-view.tsx` — 642 LOC
  - `services/jangar/src/components/agents-control-plane.tsx` — 463 LOC
  - `services/jangar/src/components/agents-control-plane-primitives.tsx` — 457 LOC
- Control-plane route count:
  - 42 route files under `services/jangar/src/routes/control-plane`
  - 36 redirect-only files
- Configuration footprint:
  - 353 distinct `process.env.*` references in `services/jangar/src/server`
  - 550 distinct `process.env.*` references across `services/jangar/src`, `services/jangar/scripts`, and `services/jangar/tests`
- Build/deploy footprint:
  - `services/jangar/Dockerfile` — 626 LOC
  - `packages/scripts/src/jangar/verify-deployment.ts` — 445 LOC
  - `argocd/applications/jangar/deployment.yaml` — 437 LOC
  - `.github/workflows/jangar-build-push.yaml` — 178 LOC
