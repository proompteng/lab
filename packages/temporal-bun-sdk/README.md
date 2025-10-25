# `@proompteng/temporal-bun-sdk`

A Bun-first starter kit for running Temporal workers that mirrors our existing Go-based setup (namespace `default`, task queue `prix`, gRPC port `7233`) while providing typed helpers for connection, workflow, and activity registration.
<!-- TODO(codex, zig-pack-03): Expand Zig toolchain prerequisites section and link install script. -->

## Features
- Zod-backed environment parsing (`loadTemporalConfig`) with sane defaults and TLS loading.
- Factories for Temporal connections, workflow clients, and workers.
- Example workflows/activities plus an executable `temporal-bun-worker` binary.
- Project scaffolding CLI (`temporal-bun init`) with Docker packaging helpers.
- Dockerfile and `docker-compose` example for containerized development.
- Detailed FFI implementation blueprint in [`docs/ffi-surface.md`](./docs/ffi-surface.md) to guide future native bridge work.
- Zig migration roadmap in [`docs/zig-bridge-migration-plan.md`](./docs/zig-bridge-migration-plan.md) documenting the phased replacement of the former Rust bridge.

## Documentation

- [`docs/design-e2e.md`](./docs/design-e2e.md) – product and architecture overview.
- [`docs/ffi-surface.md`](./docs/ffi-surface.md) – native bridge blueprint.
- [`docs/ts-core-bridge.md`](./docs/ts-core-bridge.md) – TypeScript core bridge implementation.
- [`docs/client-runtime.md`](./docs/client-runtime.md) – Bun Temporal client rewrite.
- [`docs/worker-runtime.md`](./docs/worker-runtime.md) – worker orchestration plan.
- [`docs/workflow-runtime.md`](./docs/workflow-runtime.md) – deterministic workflow runtime strategy.
- [`docs/payloads-codec.md`](./docs/payloads-codec.md) – payload encoding & data conversion.
- [`docs/testing-plan.md`](./docs/testing-plan.md) – validation matrix.
- [`docs/migration-phases.md`](./docs/migration-phases.md) – phased rollout checklist.
- [`docs/zig-bridge-scaffold-checklist.md`](./docs/zig-bridge-scaffold-checklist.md) – bite-sized TODOs for the Zig bridge rollout.
- [`docs/zig-production-readiness.md`](./docs/zig-production-readiness.md) – formalities required before making Zig the default bridge.

## Installation

```bash
pnpm install

# Download pre-built static libraries (automatic during build)
# No manual setup required - libraries are downloaded from GitHub releases

# Build the Zig bridge (downloads pre-built libraries automatically)
pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig
pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig:bundle
pnpm --filter @proompteng/temporal-bun-sdk run package:native:zig
# Optional: build a Debug variant of the Zig bridge for local investigation
# pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig:debug
```

**No Rust toolchain installation is required.** The build process automatically downloads pre-built static libraries from GitHub releases, eliminating the need for local Rust compilation.



The bundling script cross-compiles ReleaseFast builds for `darwin` and `linux` (arm64 and x64), staging
them under `native/temporal-bun-bridge-zig/zig-out/lib/<platform>/<arch>/`. The packaging helper then
copies those artifacts into `dist/native/<platform>/<arch>/` so `pnpm pack --filter
@proompteng/temporal-bun-sdk` ships prebuilt Zig libraries alongside the TypeScript output. Running
`pnpm pack` or the publish workflow automatically executes both steps via the package `prepack` hook.

> **Note:** Windows/MSVC builds remain on the roadmap (`zig-pack-03`). Until platform-compatible Zig artefacts are ready, Windows hosts are not yet supported.

> **Tip:** For deterministic builds, stay on `sdk-typescript@v1.13.1` and the referenced `sdk-core` commit `de674173c664d42f85d0dee1ff3b2ac47e36d545`. Both are wired into this workspace’s vendor clones and match the Temporal 1.13 line as of October 20 2025.

Ensure `protoc` ≥ 28 is installed (`brew install protobuf` on macOS, `apt install protobuf-compiler` on Debian/Ubuntu).
On Debian/Ubuntu, also install `libprotobuf-dev` so the well-known types referenced by Temporal's Rust crates are available to `protoc`.

Build and test the package:

```bash
pnpm --filter @proompteng/temporal-bun-sdk build
pnpm --filter @proompteng/temporal-bun-sdk test
```

Packaged Zig bridge artifacts load automatically when present. Set `TEMPORAL_BUN_SDK_USE_ZIG=1` to assert Zig usage. Disabling the flag (`TEMPORAL_BUN_SDK_USE_ZIG=0`) is no longer supported because the Rust bridge has been removed.

## Usage

```ts
import { createTemporalClient, loadTemporalConfig } from '@proompteng/temporal-bun-sdk'

const { client } = await createTemporalClient()
const start = await client.workflow.start({
  workflowId: 'helloTemporal-001',
  workflowType: 'helloTemporal',
  taskQueue: 'prix',
  args: ['Proompteng'],
})
console.log('Workflow execution started', start.runId)

// Persist start.handle for follow-up signal/query calls once they land.
const handle = start.handle

// Example (pending implementation): await client.workflow.signal(handle, 'complete', { ok: true })

> **Note:** The current Bun-native client supports workflow starts today. Signal, query, and termination APIs are under active development. The start result surfaces `firstExecutionRunId` when Temporal returns it so you can correlate resets or continue-as-new runs.
```

Start the bundled worker (after building):

```bash
pnpm --filter @proompteng/temporal-bun-sdk run start:worker
```

## CLI

The package ships a CLI for project scaffolding and container packaging.

```bash
temporal-bun init my-worker
cd my-worker
bun install
bun run dev          # runs the worker locally
bun run docker:build # builds Docker image via Bun script
```

Verify connectivity to your Temporal cluster using the Bun-native bridge:

```bash
temporal-bun check --namespace default
```

To build an image from the current directory without scaffolding:

```bash
temporal-bun docker-build --tag my-worker:latest
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | `${TEMPORAL_HOST}:${TEMPORAL_GRPC_PORT}` | Direct address override (e.g. `temporal.example.com:7233`). |
| `TEMPORAL_HOST` | `127.0.0.1` | Hostname used when `TEMPORAL_ADDRESS` is unset. |
| `TEMPORAL_GRPC_PORT` | `7233` | Temporal gRPC port. |
| `TEMPORAL_NAMESPACE` | `default` | Namespace passed to the workflow client. |
| `TEMPORAL_TASK_QUEUE` | `prix` | Worker task queue. |
| `TEMPORAL_API_KEY` | _unset_ | Injected into connection metadata for Cloud/API auth. |
| `TEMPORAL_TLS_CA_PATH` | _unset_ | Path to trusted CA bundle. |
| `TEMPORAL_TLS_CERT_PATH` / `TEMPORAL_TLS_KEY_PATH` | _unset_ | Paths to mTLS client certificate & key (require both). |
| `TEMPORAL_TLS_SERVER_NAME` | _unset_ | Overrides TLS server name. |
| `TEMPORAL_ALLOW_INSECURE` / `ALLOW_INSECURE_TLS` | `false` | Accepts `1/true/on` to disable TLS verification (sets `NODE_TLS_REJECT_UNAUTHORIZED=0`). |
| `TEMPORAL_WORKER_IDENTITY_PREFIX` | `temporal-bun-worker` | Worker identity prefix (appends host + PID). |

These align with the existing Temporal setup (`services/prix/worker/main.go`, `packages/atelier/src/create-default-namespace.ts`) so Bun workers can drop into current environments without additional configuration.

## Docker

Build the worker image from the repo root:

```bash
docker build -f packages/temporal-bun-sdk/Dockerfile -t temporal-bun-sdk:dev .
```

Or spin up the Temporal dev stack (Temporalite + optional worker) via Compose:

```bash
# start Temporalite (SQLite-backed Temporal server)
docker compose -f packages/temporal-bun-sdk/examples/docker-compose.yaml up -d temporal

# optional: build and run the example worker container
docker compose -f packages/temporal-bun-sdk/examples/docker-compose.yaml up --build worker
```

With the Temporal container running, you can execute the native integration tests:

```bash
cd packages/temporal-bun-sdk
TEMPORAL_TEST_SERVER=1 bun test tests/native.integration.test.ts
```

Shut everything down with:

```bash
docker compose -f packages/temporal-bun-sdk/examples/docker-compose.yaml down
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm --filter @proompteng/temporal-bun-sdk dev` | Watch `src/bin/start-worker.ts` with Bun. |
| `pnpm --filter @proompteng/temporal-bun-sdk build` | Type-check and emit to `dist/`. |
| `pnpm --filter @proompteng/temporal-bun-sdk test` | Run Bun tests under `tests/`. |
| `pnpm --filter @proompteng/temporal-bun-sdk run test:coverage` | Run tests with Bun coverage output under `.coverage/`. |
| `pnpm --filter @proompteng/temporal-bun-sdk run start:worker` | Launch the compiled worker. |
| `pnpm --filter @proompteng/temporal-bun-sdk run build:native` | Build the Bun ↔ Temporal native bridge. |
