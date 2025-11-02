# `@proompteng/temporal-bun-sdk`

A Bun-first Temporal SDK that ships a Zig-backed bridge, Bun-native client/worker wrappers, and a CLI for scaffolding Temporal projects without Node.js runtime dependencies.

## Highlights
- Zod-backed environment parser (`loadTemporalConfig`) with TLS, API key, and identity defaults that match our Go workers.
- Bun-native factories for Temporal connections, workflow clients, and workers that talk to Temporal Core through the Zig bridge.
- Pluggable data conversion (`createDataConverter`) with JSON defaults and codec hooks for custom payload handling.
- CLI utilities (`temporal-bun`) for scaffolding apps, packaging Docker images, replaying histories, and checking cluster connectivity.
- Prebuilt Zig bridge artefacts for macOS (arm64) and Linux (x64/arm64) included in the published tarball so most contributors never invoke `zig build`.
- Deterministic replay helper (`runReplayHistory`) and workflow runtime abstractions designed for Bun’s module graph.

## Prerequisites
- **Bun ≥ 1.1.20** – required for the Bun-native runtime, worker bootstrapping, and CLI commands.
- **Zig 0.15.1** – only needed when rebuilding the bridge locally (`bun run build:native:zig`). The published package includes precompiled libraries for Linux arm64/x64 and macOS arm64.
- **Temporal CLI ≥ 1.4** – optional, but recommended for the quickstart and demo workflow.
- **`protoc` ≥ 28** (macOS: `brew install protobuf`, Debian/Ubuntu: `apt install protobuf-compiler libprotobuf-dev`) so the SDK’s generated bindings stay reproducible.

Intel macOS and Windows hosts are not yet supported by the prebuilt Zig artefacts. Use a Linux arm64/x64 or macOS arm64 environment (local or containerised) when running the worker.

## Quickstart
1. **Install dependencies and fetch bridge artefacts**
   ```bash
   bun install
   bun run libs:download
   ```

2. **Configure Temporal access**
   Create an `.env` (or export variables in your shell) with the connection details. `loadTemporalConfig` reads these at runtime:
   ```env
   TEMPORAL_ADDRESS=temporal.example.com:7233
   TEMPORAL_NAMESPACE=default
   TEMPORAL_API_KEY=temporal-cloud-api-key-123
   TEMPORAL_TLS_CA_PATH=certs/cloud-ca.pem
   TEMPORAL_TLS_CERT_PATH=certs/worker.crt        # optional – only for mTLS
   TEMPORAL_TLS_KEY_PATH=certs/worker.key         # optional – only for mTLS
   TEMPORAL_TLS_SERVER_NAME=temporal.example.com  # optional – SNI override
   TEMPORAL_TASK_QUEUE=prix
   TEMPORAL_BUN_SDK_USE_ZIG=1
   ```

   > Need to run against a local Temporal CLI dev server? Omit the TLS variables and set `TEMPORAL_ADDRESS=127.0.0.1:7233`. Set `TEMPORAL_ALLOW_INSECURE=1` when testing against self-signed certificates.

3. **Build the SDK once**
   ```bash
   bun run build
   ```

4. **Run the Bun-native worker**
   ```bash
   # optional: start the Temporal CLI dev server in another terminal
   bun scripts/start-temporal-cli.ts

   # run the Bun worker backed by the Zig bridge
   TEMPORAL_BUN_SDK_USE_ZIG=1 bun run start:worker
   ```

5. **Interact with your namespace using the CLI**
   ```bash
   # Check connectivity and TLS/API key wiring
   TEMPORAL_BUN_SDK_USE_ZIG=1 temporal-bun check --namespace "$TEMPORAL_NAMESPACE"

   # Scaffold a fresh worker project (outputs into ./hello-worker)
   temporal-bun init hello-worker
   ```

The CLI and worker automatically load the prepackaged Zig libraries. Setting `TEMPORAL_BUN_SDK_USE_ZIG=1` ensures the Bun-native bridge is mandatory; unset it only when opting into the vendor fallback described in the troubleshooting guide.

## Guides & References
- [Migration guide](./docs/migration-guide.md) – move from the hybrid `@temporalio/*` packages to the Bun SDK.
- [Troubleshooting & FAQ](./docs/troubleshooting.md) – bridge loading, TLS, API keys, CI environments, and vendor fallback.
- [TypeScript core bridge](./docs/ts-core-bridge.md) – Bun ↔ Zig FFI design.
- [Migration phases](./docs/migration-phases.md) – phased rollout checklist with status.
- [Worker runtime](./docs/worker-runtime.md) – architecture for Bun-native polling, activities, and shutdown.
- [Workflow runtime](./docs/workflow-runtime.md) – deterministic execution and replay mechanics.
- [Design overview](./docs/design-e2e.md) – full-stack architecture and testing strategy.

## Zig Toolchain

The native bridge compiles with Zig **0.15.1**, matching our CI workflow (`.github/workflows/temporal-bun-sdk.yml`) and the Docker build stage (`packages/temporal-bun-sdk/Dockerfile`). Update those references and this section together whenever we bump the toolchain.

### Install options

- **macOS (Homebrew)**
  ```bash
  brew update
  brew install zig
  zig version
  ```
  Homebrew’s `zig` formula tracks stable releases. If `zig version` prints something other than `0.15.1`, install from an alternative below and `brew pin zig` (or uninstall the mismatched version) to prevent PATH conflicts.

- **macOS/Linux (asdf)**
  ```bash
  asdf plugin add zig https://github.com/zigcc/asdf-zig.git
  asdf install zig 0.15.1
  asdf global zig 0.15.1
  zig version
  ```
  This keeps Zig scoped per-shell via `.tool-versions`. Use `asdf local zig 0.15.1` inside consumer projects if you do not want a global default.

- **Manual tarball (official release)**
  ```bash
  ZIG_VERSION=0.15.1

  case "$(uname -s)" in
    Darwin) ZIG_OS=macos ;;
    Linux) ZIG_OS=linux ;;
    *) echo "Unsupported OS for the Zig tarball install"; exit 1 ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) ZIG_ARCH=aarch64 ;;
    x86_64|amd64) ZIG_ARCH=x86_64 ;;
    *) echo "Unsupported CPU architecture for the Zig tarball install"; exit 1 ;;
  esac

  curl -LO "https://ziglang.org/download/${ZIG_VERSION}/zig-${ZIG_OS}-${ZIG_ARCH}-${ZIG_VERSION}.tar.xz"
  tar -xf "zig-${ZIG_OS}-${ZIG_ARCH}-${ZIG_VERSION}.tar.xz"
  sudo mv "zig-${ZIG_OS}-${ZIG_ARCH}-${ZIG_VERSION}" "/usr/local/zig-${ZIG_VERSION}"
  sudo ln -sf "/usr/local/zig-${ZIG_VERSION}/zig" /usr/local/bin/zig
  zig version
  ```
  Linux hosts need `xz-utils` (`sudo apt-get install xz-utils` on Debian/Ubuntu) before extracting. macOS users should remove or pin any conflicting Homebrew install to keep the downloaded toolchain first on `PATH`.

### Verify your setup

```bash
zig version             # should report 0.15.1
zig env | grep cache    # optional sanity check
pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig
```

The build script (`packages/temporal-bun-sdk/scripts/build-zig-artifacts.ts`) expects `zig` on `PATH`. If the final command fails, confirm the Temporal libraries downloaded via `bun run scripts/download-temporal-libs.ts` and re-run after fixing your Zig install.

> **Windows support:** Windows/MSVC builds remain on the roadmap (`zig-pack-03`). Until compatible Zig artifacts ship, Windows hosts are not supported for native bridge development.

## Packaging & Release Tasks
The package’s `prepack` hook downloads the Temporal static libraries, bundles the Zig artefacts, and compiles TypeScript output so `pnpm pack` always produces a ready-to-publish tarball.

```bash
pnpm --filter @proompteng/temporal-bun-sdk run build
pnpm pack --filter @proompteng/temporal-bun-sdk

tar tf @proompteng-temporal-bun-sdk-*.tgz | sed 's/^/• /'
```

Expect to see:
- `package/dist/**` – compiled TypeScript output.
- `package/dist/native/{darwin,linux}/{arm64,x64}/libtemporal_bun_bridge_zig.*` – prebuilt Zig libraries.
- `package/README.md` – this guide.

Set `TEMPORAL_BUN_SDK_TARGETS=linux-arm64,linux-x64` when running on hosts without the macOS SDK; the packaging scripts will restrict the Zig build to the requested targets. CI should run with the default (all targets) so both macOS and Linux artefacts ship.

The `scripts/package-zig-artifacts.ts` helper copies staged artefacts from `bruke/zig-out/lib/<platform>/<arch>` into `dist/native`. When building on a new platform, run:

```bash
bun run build:native:zig        # ReleaseFast build
bun run build:native:zig:bundle # Stage artefacts under bruke/zig-out/lib
bun run package:native:zig      # Copy into dist/native
```

## Usage Example

```ts
import { createTemporalClient, createDefaultDataConverter } from '@proompteng/temporal-bun-sdk'

const dataConverter = createDefaultDataConverter()
const { client } = await createTemporalClient({
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  identityPrefix: 'temporal-bun-example',
  dataConverter,
  apiKey: process.env.TEMPORAL_API_KEY,
  tls: undefined, // loadTemporalConfig() populates TLS automatically when env vars are set
})

const handle = await client.workflow.start({
  workflowId: 'helloTemporal-001',
  workflowType: 'helloTemporal',
  taskQueue: 'prix',
  args: ['Proompteng'],
})

await client.workflow.signal(handle, 'complete', { ok: true })
const result = await client.workflow.query(handle, 'currentState')
console.log('Current state', result)
```

For deterministic replay, reuse the same converter:

```ts
import { runReplayHistory } from '@proompteng/temporal-bun-sdk/workflow/runtime'
import { readFile } from 'node:fs/promises'

const history = await readFile('histories/simple-workflow.json', 'utf8')

await runReplayHistory({
  workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
  namespace: 'default',
  taskQueue: 'replay-task-queue',
  history,
  dataConverter,
})
```

## CLI Reference

```bash
temporal-bun init my-worker
cd my-worker
bun install
TEMPORAL_BUN_SDK_USE_ZIG=1 bun run dev           # runs the worker locally against TEMPORAL_ADDRESS
bun run docker:build --tag my-worker:latest      # builds a Docker image using Bun
TEMPORAL_BUN_SDK_USE_ZIG=1 temporal-bun check --namespace default
```

`temporal-bun replay` validates recorded histories and surfaces nondeterminism failures. Provide `--converter` to ensure custom codecs run during replay.
