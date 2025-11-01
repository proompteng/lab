# Temporal Bun SDK — Zig Bridge Migration Plan

**Status:** Completed — Zig bridge is now the sole native path (Rust fallback removed 24 Oct 2025)  
**Owner:** Platform Runtime (Temporal Bun)  
**Related Issue:** #1458 — Native Bun support with Zig
**See Also:** `zig-bridge-architectural-plan.md` for the end-state architecture and roadmap.

---

## 1. Problem Statement

The current `temporal-bun-bridge` native layer is implemented in Rust and compiled with Cargo. While it delivers the Bun ↔ Temporal FFI surface defined in `docs/ffi-surface.md`, the Rust toolchain introduces material friction:

- ❌ Bun projects must install Rust + Cargo just to consume the SDK.
- ❌ Native builds are slow (multi-minute cold builds) and increase CI image weight.
- ❌ Shipping prebuilt artifacts requires cross-compiling via Cargo + `cross`, which complicates release automation.

To provide first-class Bun developer ergonomics we will reimplement the native bridge in Zig and align with Bun’s toolchain expectations.

---

## 2. Goals & Non-Goals

| Goals | Non-Goals |
|-------|-----------|
| Provide a Zig-built shared library exposing the `temporal_bun_*` symbols consumed by `src/internal/core-bridge/native.ts`. | Rewriting Temporal Core itself in Zig. We will continue to embed the upstream runtime via its C-ABI surface. |
| Match the existing successful client paths: runtime bootstrap, async client connect, namespace describe, workflow start. | Full worker runtime parity on day one. Worker APIs will move in a later phase. |
| Remove the direct dependency on `cargo` for consumers; only Zig (>=0.15.x) is required to build from source (see the [Zig install guide](https://ziglang.org/learn/getting-started/)). | Dropping the Rust toolchain from **our** CI machines immediately. (Historical note: Rust builds remained available for fallback until October 2025; they are now removed.) |
| Ship phased plan, validation strategy, owners, and rollout guardrails. | Changing Temporal server deployment. |

---

## 3. Current Surface Inventory (Oct 2025 Snapshot)

| Area | Symbol(s) | Current Status |
|------|-----------|----------------|
| Runtime | `temporal_bun_runtime_new`, `temporal_bun_runtime_free`, `temporal_bun_runtime_update_telemetry`, `temporal_bun_runtime_set_logger` | Runtime bootstrap, telemetry updates, and logger hooks ship; telemetry surfaces Temporal core gRPC statuses (`zig-rt-03` complete). |
| Client Async | `temporal_bun_client_connect_async`, pending poll/consume/free trio | Connect now spawns worker threads and resolves pending handles; concurrency guardrails from #1526 are merged. |
| Client RPCs | `temporal_bun_client_describe_namespace_async`, `temporal_bun_client_start_workflow`, `temporal_bun_client_signal*`, `temporal_bun_client_query_workflow`, `temporal_bun_client_terminate_workflow`, `temporal_bun_client_update_headers` | Describe, start, signal-with-start, signal, query, terminate, cancel, and header updates implemented (`zig-wf-06` closed). |
| Error Surface | `temporal_bun_error_message`, `temporal_bun_error_free` | Functional; mirrors the Rust bridge behaviour. |
| Worker | `temporal_bun_worker_*` suite | Creation ships behind `TEMPORAL_BUN_SDK_USE_ZIG=1`; polling, completion, heartbeats, and shutdown (initiate + finalize) now implemented (`zig-worker-02`…`zig-worker-09` complete). |
| Packaging | `build.zig` + scripts | Prebuilt static archives are published via `.github/workflows/temporal-static-libraries.yml`; `build.zig` links against the cached artifacts fetched by `scripts/download-temporal-libs.ts` (`zig-pack-01`/`02` ✅). |

Supporting modules:

- `bruke/src/pending.zig` needs the hardening from #1526 to be thread-safe.
- `bruke/src/byte_array.zig` now emits telemetry counters and guardrails (`zig-buf-02` ✅).
- TypeScript loader (`src/internal/core-bridge/native.ts`) now routes telemetry and logging through Zig; cancellation fallback handling removed in favour of the Zig implementation.
- Client bridge code now lives in `bruke/src/client/` with dedicated modules for connect, describe, workflow RPCs, and a lightweight aggregator `client/mod.zig` so teams can work in parallel without editing a monolith.

Packaging note: the static archive workflow intentionally targets Linux (arm64/x64) and macOS arm64 only. Intel macOS builds are out of scope; developers on those machines must consume the published artifacts rather than compiling locally.

---

## 4. Phased Roadmap (2025–2026)

| Phase | Goals | Dependencies | Exit Criteria |
|-------|-------|--------------|---------------|
| 0. Foundations | Land pending-handle fixes (#1526), correct docs, validate TLS against Temporal Cloud sandbox. | Zig 0.15.x toolchain, Temporal Cloud sandbox access. | Zig unit tests + TLS smoke succeed on macOS/Linux. |
| 1. Client Parity | Implement `zig-cl-*` / `zig-wf-*`, wrap Bun client API, publish quickstart docs. | `zig-pack-01` linkage, Bun FFI loaders. | Integration suite passes for connect/start/signal/query/terminate; docs author “Temporal on Bun”. |
| 2. Worker Parity | Complete `zig-worker-*`, run workflow/activity loops in Bun worker. | Client parity shipped; workflow runtime scaffolding. | Sample workflow executes end-to-end with timers, activities, signals. |
| 3. Observability | Harden telemetry/logging FFI and publish dashboards/runbooks. | Runtime parity, metrics exporters. | ✅ Prometheus + OTLP exporters validated; logging callback invoked from Bun. |
| 4. Release & Adoption | Package native binaries, publish npm canary/GA, gather feedback. | Packaging pipeline, CI matrix ready. | npm release published with SBOM + signatures; Temporal Cloud smoke in CI. |

The detailed architectural context for each phase lives in `zig-bridge-architectural-plan.md`.

---

## 4. Proposed Architecture (Zig)

### 4.1 Layering Overview

```
Bun (bun:ffi) ──▶ Zig Bridge (libtemporal_bun_bridge.zig)
                   │
                   ├─ Temporal Core Runtime (Rust) via C-ABI shim
                   ├─ Temporal gRPC stubs generated from proto → C bindings
                   └─ Async executor + channel implementation in Zig
```

1. **Zig Shared Library**  
   - Expose the same `temporal_bun_*` function signatures.  
   - Encode/decode JSON payloads using Zig stdlib (`std.json` with arena allocators).  
   - Maintain error buffer as `[*]u8` with length output mirroring current contract.

2. **Temporal Core Embedding**  
   - Build `temporal-sdk-core` and client crates as static libraries (`cargo build --release --target x86_64-unknown-linux-gnu --features c-api`).  
   - Generate C headers with `cbindgen` exposing `temporal_sdk_core_*` functions.  
   - Import headers into Zig via `@cImport` and wrap them with Zig-friendly safety layers.

3. **Async Pending Handles**  
   - Replace Tokio background threads with Zig `std.Thread.spawn` + condition variables, or leverage Zig’s event loop (`async`/`await`).  
   - Expose a `PendingHandle` struct storing state + mutex-protected union (`pending | ok | err`).  
   - Poll from Bun by checking atomic state; consume transfers ownership to Zig-managed heap slice.

4. **Byte Array Transport**  
   - Represent as struct `{ ptr: [*]u8, len: usize, cap: usize }` to match existing layout.  
   - Provide constructor helpers to zero-copy when safe or allocate copy when required.

5. **Telemetry & Logging Hooks**  
   - Keep slots for telemetry + logger callbacks; Zig forwards to Bun via function pointers (`extern struct`).  
   - `configureTelemetry` now delegates Prometheus/OTLP exporter wiring through the Zig runtime.

---

## 5. Implementation Phases

| Phase | Scope | Deliverables | Exit Criteria |
|-------|-------|--------------|---------------|
| 0 — Scaffolding | Add `bruke` with `build.zig`, hook into `pnpm build:native`. Generate C headers from Rust core (temporary). | Passing `zig build install` producing `.so/.dylib/.dll`, TypeScript loads via `bun:ffi` override behind feature flag. | `bun run packages/temporal-bun-sdk/scripts/smoke-client.ts` connects & describes namespace using Zig library gated by `TEMPORAL_BUN_SDK_USE_ZIG=1`. |
| 1 — Client Parity | Reimplement runtime + client connect + describe + start workflow. Maintain async pending handles. | Toggle default to Zig bridge on CI when env flag enabled. Update TS to fall back to Rust when Zig load fails. | `bun test` suite passes with Zig shared lib; docs updated. |
| 2 — Client Enhancements | Implement signal/query/terminate/cancel/signalWithStart + metadata updates. Add telemetry + logger support. | All TODOs in `src/internal/core-bridge/native.ts` removed or delegated to Zig. | Temporal integration tests (Temporal CLI dev server) green under Zig path. |
| 3 — Worker Runtime | Port worker creation, poll/complete, activity heartbeat. Mirror existing FFI blueprint. | `temporal-bun-worker` binary runs end-to-end solely on Zig bridge. | Example app runs against Temporal server without Rust artifacts. |
| 4 — Cleanup & Release | ✅ **COMPLETED** - Removed Rust bridge, deprecated Cargo build scripts, published prebuilt binaries (GitHub releases). | ✅ No Rust toolchain needed for consumers; README + scripts updated. |

---

## 6. Build & Tooling Updates

1. **Zig Toolchain Version** — Standardize on Zig 0.15.1 (matches `services/galette`) and follow the install guidance in [`README.md#zig-toolchain`](../README.md#zig-toolchain).  
   - When bumping Zig, update `.github/workflows/temporal-bun-sdk.yml`, `packages/temporal-bun-sdk/Dockerfile`, and the README section in the same PR so CI, local docs, and our container image stay aligned.  
   - Re-run `pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig` plus `pnpm exec biome check packages/temporal-bun-sdk/README.md` after the upgrade to confirm local builds pass and docs stay formatted.  
   - Debian/Ubuntu developers must install `xz-utils` before unpacking official tarballs; macOS users should `brew pin zig` after installing 0.15.1 to avoid automatic upgrades that break parity with CI.
2. **Package Scripts** — ✅ **COMPLETED** - Replaced `cargo build` scripts with pre-built library downloads:
   ```json
   "build:native": "bun run libs:download && zig build -Doptimize=ReleaseFast --build-file bruke/build.zig"
   ```
3. **CI Images** — ✅ **COMPLETED** - Removed Rust from Docker images, using only Zig with pre-built libraries.
4. **Prebuilt Artifacts** — Use `zig build install` to stage artifacts under `native/artifacts/<platform>/`.
5. **NPM Packaging** — Update publish step to copy Zig binaries into `dist/native/<platform>/`.

### Toolchain troubleshooting

- Run `zig version` and `zig env` whenever `build:native:zig` fails; a missing `zig` binary on `PATH` or the wrong version (≠0.15.1) is the most common issue.
- Verify Temporal libraries downloaded via `bun run scripts/download-temporal-libs.ts` before rebuilding; stale caches surface as linker errors.
- Windows/MSVC support remains deferred—call it out in release notes and onboarding docs until we publish compatible artifacts.
- Capture upgrade steps in the issue checklist: update workflow + Dockerfile + README, regenerate release notes, and notify Bun SDK maintainers.

---

## 7. Validation Strategy

- **Unit Tests (Zig)** — `zig build test` covering JSON parsing, pending handle state machine, error propagation.  
- **Bun Tests** — Extend `packages/temporal-bun-sdk/tests` to run against both bridges (feature flag).  
- **Integration** — Docker Compose Temporal stack verifying workflow start/signal/query across Linux/macOS.  
- **Performance Benchmarks** — Compare latency + CPU usage vs Rust bridge (target within ±5%).  
- **Cross-Platform Smoke** — x64 Linux, macOS (x64 + arm64 via Rosetta), Windows (MSVC). Use GitHub Actions matrix with Zig toolchain.

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Zig async runtime divergence vs Tokio semantics. | Pending handles may deadlock or starve. | Use dedicated worker threads managed in Zig; add stress tests with artificial latency. |
| Linking Rust static libs into Zig. | Build failures, symbol mismatch. | Introduce C shim crate exporting stable ABI; pin commit + verify with `zig build check`. |
| Release artifacts size/regression. | Consumer install friction. | Strip symbols (`zig build -Dstrip`) and compress binaries post-build. |
| Windows support parity. | Bun users on Windows blocked. | Validate MSVC toolchain early; add GitHub Actions job gating merges. |
| Telemetry/logging fallbacks. | Feature parity gap. | Prometheus and OTLP exporters now ship via Zig runtime; keep Rust bridge behind flag until worker telemetry lands. |

---

## 9. Open Questions

1. Do we maintain dual-bridge mode long term (Rust fallback) or enforce Zig-only after Phase 4?  
   - **Resolution:** Zig-only enforcement shipped on October 24, 2025.
2. Should we upstream Zig bindings to Temporal to reduce maintenance burden?  
3. What is the expected minimum Zig version for Bun consumers (align with Bun 1.1.x release cadence)?  
4. How will we distribute Apple arm64 binaries safely (notarization requirements)?

---

## 10. Next Steps

1. Socialize this plan with Temporal Runtime stakeholders for approval.  
2. Schedule Phase 0 spike (time-boxed) to validate Zig ↔ Rust static link viability.  
3. Once approved, convert phases into tracked GitHub issues / project items with owners & timelines.
