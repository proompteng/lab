# Temporal Bun SDK — Architectural Plan

**Published:** 20 Oct 2025  
**Authors:** Platform Runtime (Temporal Bun)  
**Status:** Draft — guides implementation toward the npm GA release of the Bun-native Temporal SDK. Current progress (1 Nov 2025): client RPCs (start/query/signal/terminate/cancel/update headers) flow through [`src/internal/core-bridge/native.ts`](../src/internal/core-bridge/native.ts) into the Zig layer, workflow task execution and activity completion/heartbeats run via [`bruke/src/worker.zig`](../bruke/src/worker.zig), and Bun stack-trace enrichment (`TEMPORAL_SHOW_STACK_SOURCES`) ships today. Remaining gaps focus on telemetry/logging hooks and graceful worker shutdown instrumentation.

---

## 1. End-State Vision

Ship `@proompteng/temporal-bun-sdk` to npm so Bun developers can:

- install a single package that bundles Zig-built native libraries for macOS (arm64/x64) and Linux (arm64/x64); the library loads through `bun:ffi` without requiring Rust on consumer machines (see [Bun FFI docs](https://bun.com/docs/api/ffi)).
- author workflows, activities, and workers purely in Bun/TypeScript with an API surface comparable to the Node Temporal SDK while preserving determinism guarantees (see [Temporal concepts](https://docs.temporal.io/concepts/what-is-temporal)).
- connect securely to Temporal Cloud (TLS, worker versioning, long-running workflow support) out of the box (see [Worker versioning](https://docs.temporal.io/worker-versioning) and [Long-running workflows](https://temporal.io/blog/very-long-running-workflows)).
- run production-grade telemetry (Prometheus, OTLP) and logging hooks via the Zig runtime bridge so platform teams can operate Bun workers at scale (see [Temporal production checklist](https://docs.temporal.io/determine-deploy-production)).

---

## 2. Architectural Pillars

### 2.1 Core Native Bridge

- Complete `zig-pack-01` / `zig-pack-02` so `zig build` links against the vendored Temporal static archives and stages per-target shared objects in `zig-out/lib/<platform>/<arch>/`.  
- Harden the pending-handle concurrency model (merge PR #1526) before wiring additional async APIs.  
- Implement all runtime/client/worker TODOs (`zig-rt-*`, `zig-cl-*`, `zig-wf-*`, `zig-worker-*`) by calling the Temporal core C-ABI.  
- Keep the bridge crash-safe: null checks, deterministic errors via `temporal_bun_error_message`, and structured telemetry/logging callbacks.

### 2.2 Bun Interop Layer

- Provide TypeScript wrappers (`src/core-bridge/**`) that mirror the Node SDK surface but translate to Bun primitives (e.g., `Bun.file`, `AbortController`, top-level `await`).  
- Detect Bun at runtime and load the Zig library with `dlopen`. When running on unsupported runtimes, fail fast with actionable guidance (see [Bun FFI docs](https://bun.com/docs/api/ffi)).
- Validate TLS handshakes against Temporal Cloud and document known Docker pitfalls observed by early adopters (see [Temporal community report](https://community.temporal.io/t/temporal-client-fails-to-connect-inside-docker-container-node-js-bun/17982)).

### 2.3 Developer Experience & Tooling

- Ship a `bun create temporal` (or `pnpm create`) template showcasing local development, Temporal CLI integration, and recommended Bun project structure.  
- Bundle docs and code samples demonstrating worker versioning rollouts, workflow testing, and replay flows (see [Worker versioning](https://docs.temporal.io/worker-versioning) and [Long-running workflows](https://temporal.io/blog/very-long-running-workflows)).
- Support `bun test` and `bun --watch` for quick feedback, with guidance on using the Temporal web UI/debugger alongside Bun workflows (see [Bun debugger discussion](https://www.reddit.com/r/bun/comments/1m69ui2)).

### 2.4 Observability & Operations

- Wire `temporal_bun_runtime_update_telemetry` and `temporal_bun_runtime_set_logger` once the bridge exposes them, surfacing Prometheus and OTLP exporters to Bun.  
- Provide default dashboards/alerts and document SLO expectations for Bun workers (see [Temporal production checklist](https://docs.temporal.io/determine-deploy-production)).
- Capture long-running workflow considerations (timeouts, continue-as-new) to avoid surprises when moving from Node to Bun (see [Long-running workflows](https://temporal.io/blog/very-long-running-workflows)).

### 2.5 Quality Bar

- Matrix CI on macOS and Linux (arm64/x64) using the latest Bun LTS (track via [endoflife.date](https://endoflife.date/bun)).
- Integrate Temporal CLI–driven integration tests plus a nightly Temporal Cloud TLS smoke.  
- Publish SBOMs, checksums, and signature metadata for native artifacts; document the support policy for experimental Bun FFI releases (see [Bun FFI docs](https://bun.com/docs/api/ffi)).

---

## 3. Phased Roadmap

| Phase | Target Window | Goals | Exit Criteria |
|-------|---------------|-------|---------------|
| 0. Foundations | Q4 2025 | Harden pending handles (#1526), correct documentation, prove TLS against Temporal Cloud sandbox. | Zig tests green, TLS smoke succeeds on macOS & Linux. |
| 1. Client Parity | Q4 2025 – Q1 2026 | Implement `zig-cl-*` / `zig-wf-*`, wrap in Bun client API, ship quickstart docs. | Integration suite passes for connect/start/signal/query/terminate; docs publish “Temporal on Bun” tutorial. |
| 2. Worker Parity | Q1 2026 | Complete `zig-worker-*`, run workflow/activity loops in Bun worker. | Workflow and activity task execution (including heartbeats) are live; remaining work covers activity metrics, graceful shutdown, and operational telemetry. |
| 3. Observability | Q1 – Q2 2026 | Telemetry/logging wiring, dashboards, alerting runbooks. | Prometheus + OTLP exporters validated; logging callbacks verified from Bun. |
| 4. Release & Adoption | Q2 2026 | Package native binaries, publish npm canaries/GA, monitor early adopters. | npm package released with release notes, SBOM, and support policy; Temporal Cloud smoke part of CI. |

Dates assume we prioritize the Zig bridge alongside existing Rust bridge maintenance.

---

## 4. Documentation Backlog

- **Quickstart:** “Temporal on Bun” (local dev + Temporal Cloud).  
- **FFI Safety Notes:** explain Bun’s experimental status, supported platforms, and (historical) fallback behaviour — the Rust bridge was fully removed in October 2025 (see [Bun FFI docs](https://bun.com/docs/api/ffi)).
- **Worker Versioning & Deployment Guide:** tailored to Bun packaging/deploy flows (see [Worker versioning](https://docs.temporal.io/worker-versioning)).
- **Troubleshooting TLS/Docker:** collect known issues and fixes from community threads (see [Temporal community report](https://community.temporal.io/t/temporal-client-fails-to-connect-inside-docker-container-node-js-bun/17982)).
- **Release Notes Template:** highlight Bun minimum version, platform coverage, experimental warnings.
- **Runtime Configuration:** document `TEMPORAL_BUN_SDK_USE_ZIG`, `TEMPORAL_BUN_SDK_VENDOR_FALLBACK`, and `TEMPORAL_SHOW_STACK_SOURCES` so operators can toggle behaviour predictably.

Keep this list synchronized with `zig-production-readiness.md`.

---

## 5. References

1. [Bun FFI documentation](https://bun.com/docs/api/ffi) (“Experimental — not recommended for production use yet”).
2. [Temporal Cloud Docker TLS issue report](https://community.temporal.io/t/temporal-client-fails-to-connect-inside-docker-container-node-js-bun/17982) illustrating current friction.
3. [Temporal worker versioning rollout guide](https://docs.temporal.io/worker-versioning).
4. [Temporal long-running workflow best practices](https://temporal.io/blog/very-long-running-workflows).
5. [Bun community feedback on debugging workflow failures](https://www.reddit.com/r/bun/comments/1m69ui2).
6. [Bun release lifecycle](https://endoflife.date/bun) for tracking supported versions.
7. [Temporal production deployment checklist](https://docs.temporal.io/determine-deploy-production).
8. [Temporal platform overview](https://docs.temporal.io/concepts/what-is-temporal).

---

**Lifecycle:** Review quarterly or whenever major milestones (phases) complete. Update linked docs (`zig-bridge-migration-plan.md`, `zig-production-readiness.md`) after each review.
