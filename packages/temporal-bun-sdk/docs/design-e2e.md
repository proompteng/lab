# Temporal Bun SDK — End-to-End Design

**Author:** Your Name  
**Date:** 17 Oct 2025  
**Status:** Draft

---

## 1. Target Experience

Deliver `@proompteng/temporal-bun-sdk`, a Bun-first Temporal SDK that developers can install from npm, configure quickly, and rely on for production-quality workflow execution. The experience should mirror the official Temporal TypeScript developer journey while leveraging Bun’s runtime capabilities.<br>
[Temporal TypeScript getting started](https://docs.temporal.io/develop/typescript) · [Bun installation guide](https://bun.sh/docs/installation)

### Supported Platforms & Scenarios

- **Platforms:** macOS, Linux (x86_64 / arm64). Windows support is out of scope for the initial release.
- **Temporal Deployment Targets:**
  - Self-managed Temporal servers (local Docker Compose, Kubernetes clusters).
  - Temporal Cloud (requires mTLS and API key metadata as documented in the [Temporal Cloud certificate guide](https://docs.temporal.io/cloud/certificates) and [API key best practices](https://docs.temporal.io/cloud/api-keys)).
- **Developer Experience Goals:**
  - `pnpm install @proompteng/temporal-bun-sdk` should “just work” after basic environment setup.
  - Minimal manual steps; provide scripts and docs for building native bridge.
  - Example project demonstrating workflow authoring, activity registration, and client calls.
  - Clear instructions for provisioning certificates/API keys for Temporal Cloud (link to the Temporal Cloud docs above).


## 2. Architecture Overview

```
┌────────────────────────────┐
│  @proompteng/temporal-bun  │  npm package
│  ├─ TypeScript re-exports  │  (Bun-friendly ESM)
│  ├─ Bun FFI loader         │  → libtemporal_sdk_core_c_bridge
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│  temporal-sdk-core-c-bridge│ (vendored upstream build)
│  ├─ Runtime API            │
│  ├─ Client API             │
│  ├─ Worker API             │
│  └─ Metrics/Logging        │
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│  temporal-sdk-core (Rust)  │
│  ├─ gRPC client            │
│  └─ Workflow engine        │
└────────────┬───────────────┘
             │
             ▼
   Temporal Server / Temporal Cloud
```

Key design points:

- **Native Bridge:** Build the upstream [`temporal-sdk-core-c-bridge`](https://github.com/temporalio/sdk-core/tree/main/crates/sdk-core-c-bridge) and load it via Bun FFI. No custom Rust reimplementation; we leverage Temporal’s battle-tested core. All bridge calls expose non-blocking async handles so Bun’s event loop stays responsive.
- **TypeScript Surface:** Re-export upstream TypeScript modules (`common`, `worker`, `workflow`, `client`) under the `@proompteng` namespace, allowing developers to write workflows exactly as they would with the upstream SDK.
- **Configuration:** Provide typed configuration loaders for both local Temporal server and Temporal Cloud (mTLS + API key).<br>
  [Temporal Cloud connection guide](https://docs.temporal.io/cloud/certificates)
- **Metrics & Logging:** Support Prometheus and OpenTelemetry exporters, plus log forwarding callbacks consistent with Temporal’s production readiness guidance.<br>
  [Observability best practices](https://docs.temporal.io/production-readiness/observability)


## 3. Implementation Plan

### 3.0 Vertical Slice — Async Bun Execution (MVP-0)

Deliver a fully Bun-native workflow loop without `@temporalio/*` dependencies by landing the following slice:

- **Async bridge primitives:** Introduce pending-operation handles (`temporal_bun_pending_*`) that encapsulate Tokio futures and surface poll/consume semantics to Bun without blocking the main thread.
- **Client describe workflow smoke:** Rework `client_connect` and `describe_namespace` paths to use async handles, proving out the pattern against a live Temporal service.
- **Worker bootstrap contracts:** Sketch the async worker call graph (create → poll workflow task → complete) and document the data model needed for Bun to drive core activations.
- **Example script:** Update the sample Bun worker/client scripts to rely exclusively on the new bridge so we can execute a “hello workflow” end to end (similar to the [Temporal hello world sample](https://github.com/temporalio/samples-typescript/tree/main/hello-world)).
- **Exit criteria:** A developer can run `pnpm --filter temporal-bun-sdk run demo:e2e` (tracked follow-up) and watch a Bun worker execute a workflow without any Node.js SDK packages installed.

### 3.1 Native FFI Coverage

1. **Runtime API**
   - Map TS `RuntimeOptions` to Rust `TemporalCoreRuntimeOptions`, including telemetry, metrics, logging callbacks.
   - Support log forwarding (`forward_to` callback) and custom metrics (meter creation).

2. **Client API**
   - Expose `clientUpdateHeaders`, `clientUpdateApiKey`, and `clientSend*ServiceRequest` wrappers, converting Buffers ↔ ByteArray.
   - Propagate gRPC errors/status codes to TypeScript.

3. **Worker API**
   - Implement `newWorker`, `workerValidate`, poll/complete/heartbeat functions, Nexus, replay, shutdown.
   - Support either `workflowBundle` or `workflowsPath`; align with TS worker expectations.

4. **Ephemeral Server API** (optional but helpful for deterministic tests).

5. **Error Handling**
   - Reuse thread-local error storage; ensure all FFI functions return 0/null on error and set detailed messages.


### 3.2 TypeScript Layer

1. **Namespace Rewrites**
   - Add `paths` in `tsconfig.json` so `@proompteng/temporal-bun-sdk/*` resolves to the vendored upstream modules.
   - Update bundler config to emit ESM with `.ts` extension imports (Bun-compatible).

2. **Core Bridge Typings**
   - Wrap `core-bridge` to expose our FFI loader while reusing upstream error types.

3. **Cloud Support**
   - Provide utilities for loading mTLS certs/keys (paths), constructing API key metadata, and injecting into worker/client options as described in Temporal Cloud security docs.<br>
     [Temporal Cloud security controls](https://docs.temporal.io/best-practices/security-controls)

4. **Packaging**
   - Update `package.json` `files` & `exports` to ship compiled JS, type declarations, and README.


### 3.3 Build & Tooling

1. **Vendor Setup**
   - Document manual clone (macOS/Linux) of upstream repos (`sdk-core`, `sdk-typescript`).
   - Provide optional script to build `temporal-sdk-core-c-bridge` via Cargo following Temporal’s build instructions.<br>
     [Building Temporal SDK Core](https://github.com/temporalio/sdk-core#building)

2. **Native Build**
   - `pnpm run build:native` – compiles the bridge using system `protoc` (ensure prerequisites match Temporal’s documented build requirements).
   - Output stored under `native/temporal-bun-bridge/target/release` (ignored by git).

3. **Testing**
   - Unit tests: runtime/client creation, error propagation, pending-handle lifecycle, ByteArray transfer.
   - Integration tests: mix of local Temporal server (docker-compose) and mocked gRPC to keep CI light; assert async handles resolve without blocking the Bun event loop.

4. **CI Pipeline**
   - Linting, type-checking, native build, unit tests, optional integration tests (flag to skip in CI).


### 3.4 Developer Experience Enhancements

- Example app with workflow/activity scaffolding, environment templates (`.env.example`), and `pnpm run demo` to start Temporal server + worker + sample client.
- CLI helper to bootstrap workflows/activities with TypeScript templates **(initial `temporal-bun init` implemented; follow-up work needed to integrate native worker path once bridge is complete).**
- Native FFI blueprint maintained separately in [`ffi-surface.md`](./ffi-surface.md) to keep implementation steps unambiguous.
- Rich README covering local dev & Temporal Cloud setup (cert paths, API key assignment).


## 4. Temporal Cloud Support

1. **mTLS**
   - Load CA, client cert/key via `TEMPORAL_TLS_CA_PATH`, `TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH` env vars.
   - Validate file existence; propagate errors with actionable messages following [Temporal Cloud TLS requirements](https://docs.temporal.io/cloud/certificates).

2. **API Key Metadata**
   - Support API key injection via `TEMPORAL_API_KEY` or header overrides.

3. **Server Name Override**
   - Expose `TEMPORAL_TLS_SERVER_NAME` to match Temporal Cloud endpoints.

4. **Documentation**
   - Provide example `.env.cloud` and step-by-step instructions for obtaining credentials.


## 5. Deliverables & Publication

- **NPM Package** containing:
  - ES modules targeting Bun (compiled TS + type declarations).
  - `postinstall` guidance (if needed) to check bridge presence.
  - README with quick start, Temporal Cloud setup, integration example.

- **Repository** includes:
  - Docs (`docs/design-e2e.md`, in-progress architecture notes).
  - Example project and automated tests.
  - CI (GitHub Actions) verifying lint/build/test.

- **Release Process:**
  1. Tag version (e.g., `v0.1.0`).
  2. Build native bridge and package tarball.
  3. Publish to npm via `pnpm publish --access public`.
  4. Document required environment setup in release notes.


## 6. Timeline (High-Level)

| Week | Milestone |
|------|-----------|
| 1 | Finish FFI implementation (runtime, client, worker, metrics) with unit tests |
| 2 | Adapt TS modules, verify `bun test` and manual workflow execution |
| 3 | Build integration example + docker-compose, Temporal Cloud configuration helpers |
| 4 | Polish docs, finalize npm packaging, release candidate |


## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Upstream API changes | Pin to specific commits/tags; add update checklist |
| FFI errors causing runtime crashes | Add comprehensive unit tests; guard all pointers |
| Complex TLS/mTLS setup | Provide CLI checks & detailed docs |
| Bridge build friction for end-users | Offer optional prebuilt binaries or script to compile with Cargo |


## 8. Open Questions

1. Should we provide prebuilt bridge binaries for macOS/Linux to eliminate the Cargo step? (Would improve DX.)
2. Do we ship both TypeScript source and compiled JS, or compiled only? (Bun handles TS, but compiled JS reduces friction.)
3. Should the integration tests spin up a real dockerized Temporal server in CI? (Impacts runtime.)

---

This design doc captures the path to a production-ready, Bun-native Temporal SDK with first-class developer experience and Temporal Cloud support. It will live in `packages/temporal-bun-sdk/docs/design-e2e.md` so we can track progress and iterate as needed.
