# `@proompteng/temporal-bun-sdk`

A Bun-first Temporal SDK for building workflows and activities with Bun runtime. This library provides a complete replacement for `@temporalio/*` packages, optimized for Bun's performance characteristics.

## Features

- **Bun Runtime Optimized**: Built specifically for Bun's JavaScript engine
- **No @temporalio Dependencies**: Complete replacement for Temporal TypeScript SDK
- **Native Bridge**: Zig-based native bridge for optimal performance
- **Type Safety**: Full TypeScript support with proper type definitions
- **Workflow Execution**: Execute workflows with Bun-specific optimizations
- **Activity Support**: Run activities with error handling and retries
- **Serialization**: Handles BigInt, Date, ArrayBuffer, and complex objects
- **Memory Management**: Efficient memory usage and garbage collection

## Features
- Zod-backed environment parsing (`loadTemporalConfig`) with sane defaults and TLS loading.
- Factories for Temporal connections, workflow clients, and workers.
- Example workflows/activities plus an executable `temporal-bun-worker` binary.
- Project scaffolding CLI (`temporal-bun init`) with Docker packaging helpers.
- Dockerfile and `docker-compose` example for containerized development.
- Detailed FFI implementation blueprint in [`docs/ffi-surface.md`](./docs/ffi-surface.md) to guide future native bridge work.
- Zig migration roadmap in [`docs/zig-bridge-migration-plan.md`](./docs/zig-bridge-migration-plan.md) covering the phased replacement of the Rust bridge.

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
# Install from npm
bun add @proompteng/temporal-bun-sdk

# Or install from source
git clone https://github.com/proompteng/temporal-bun-sdk.git
cd temporal-bun-sdk
bun install
bun run build
```

**No Rust toolchain installation is required.** The build process automatically downloads pre-built static libraries from GitHub releases, eliminating the need for local Rust compilation.

## Quick Start

1. **Start Temporal Server** (if not already running):
   ```bash
   docker compose up -d
   ```

2. **Create a workflow**:
   ```ts
   // workflows/hello.ts
   export default async function hello(input: any) {
     const { name = 'World' } = input
     await Bun.sleep(100)
     return { greeting: `Hello, ${name}!`, bunVersion: Bun.version }
   }
   ```

3. **Execute the workflow**:
   ```ts
   import { createTemporalClient, WorkflowIsolateManager } from '@proompteng/temporal-bun-sdk'
   
   const { client } = await createTemporalClient()
   const manager = new WorkflowIsolateManager('./workflows')
   
   const result = await manager.executeWorkflow('hello.ts', { name: 'Bun' })
   console.log(result) // { greeting: 'Hello, Bun!', bunVersion: '1.3.0' }
   ```

4. **Run the example**:
   ```bash
   bun run examples/basic-usage.ts
   ```



The bundling script cross-compiles ReleaseFast builds for `darwin` and `linux` (arm64 and x64), staging
them under `native/temporal-bun-bridge-zig/zig-out/lib/<platform>/<arch>/`. The packaging helper then
copies those artifacts into `dist/native/<platform>/<arch>/` so `pnpm pack --filter
@proompteng/temporal-bun-sdk` ships prebuilt Zig libraries alongside the TypeScript output. Running
`pnpm pack` or the publish workflow automatically executes both steps via the package `prepack` hook.

> **Note:** Windows/MSVC builds remain on the roadmap (`zig-pack-03`). Until then, Windows hosts rely
> on the Rust bridge.

> **Tip:** For deterministic builds, stay on `sdk-typescript@v1.13.1` and the referenced `sdk-core` commit `de674173c664d42f85d0dee1ff3b2ac47e36d545`. Both are wired into this workspace’s vendor clones and match the Temporal 1.13 line as of October 20 2025.

Ensure `protoc` ≥ 28 is installed (`brew install protobuf` on macOS, `apt install protobuf-compiler` on Debian/Ubuntu).
On Debian/Ubuntu, also install `libprotobuf-dev` so the well-known types referenced by Temporal's Rust crates are available to `protoc`.

Build and test the package:

```bash
pnpm --filter @proompteng/temporal-bun-sdk build
pnpm --filter @proompteng/temporal-bun-sdk test
```

Packaged Zig bridge artifacts load automatically when present. Set `TEMPORAL_BUN_SDK_USE_ZIG=1` to require the Zig
bridge (a warning is emitted if the binaries are missing) or `TEMPORAL_BUN_SDK_USE_ZIG=0` to force the Rust fallback.

## Usage

### Basic Workflow Execution

```ts
import { createTemporalClient, WorkflowIsolateManager } from '@proompteng/temporal-bun-sdk'

// Create Temporal client
const { client } = await createTemporalClient({
  address: 'http://127.0.0.1:7233',
  namespace: 'default'
})

// Execute workflow locally
const manager = new WorkflowIsolateManager('./workflows')
const result = await manager.executeWorkflow('my-workflow.ts', {
  message: 'Hello from Bun!',
  timestamp: new Date().toISOString()
})

console.log('Workflow result:', result)
```

### Advanced Client Operations

```ts
import { createTemporalClient } from '@proompteng/temporal-bun-sdk'

const { client } = await createTemporalClient()

// Start workflow
const handle = await client.startWorkflow({
  workflowId: 'my-workflow-001',
  workflowType: 'my-workflow',
  taskQueue: 'my-queue',
  args: [{ message: 'Hello!' }]
})

// Signal workflow
await client.signalWorkflow(handle, 'my-signal', { data: 'signal data' })

// Query workflow
const result = await client.queryWorkflow(handle, 'my-query', { query: 'state' })

// Terminate workflow
await client.terminateWorkflow(handle, 'Workflow completed')

// Cancel workflow
await client.cancelWorkflow(handle)

// Signal with start
const newHandle = await client.signalWithStart({
  workflowId: 'new-workflow-001',
  workflowType: 'my-workflow',
  taskQueue: 'my-queue',
  signalName: 'my-signal',
  signalArgs: [{ data: 'signal data' }],
  workflowArgs: [{ message: 'Hello!' }]
})
```

### Worker with Interceptors

```ts
import { WorkerRuntime, LoggingInterceptor, MetricsInterceptor } from '@proompteng/temporal-bun-sdk'

const worker = await WorkerRuntime.create({
  workflowsPath: './workflows',
  activities: {
    'my-activity': async (input: any) => {
      return { result: `Processed: ${input.message}` }
    }
  },
  taskQueue: 'my-queue',
  namespace: 'default',
  interceptors: new DefaultInterceptorManager()
})

// Add interceptors
worker.getInterceptorManager().addWorkflowInterceptor(new LoggingInterceptor())
worker.getInterceptorManager().addActivityInterceptor(new MetricsInterceptor())

// Start worker
await worker.run()
```

### Workflow Bundling

```ts
import { createWorkflowBundle, loadWorkflowBundle } from '@proompteng/temporal-bun-sdk'

// Create bundle
const bundle = await createWorkflowBundle({
  workflowsPath: './workflows',
  outputPath: './dist',
  includeActivities: true,
  minify: true
})

// Load bundle
const loader = loadWorkflowBundle('./dist/workflow-bundle.json')
const workflowCode = await loader.loadWorkflow('my-workflow')
const activityCode = await loader.loadActivity('my-activity')
```

### Telemetry and Observability

```ts
import { CoreRuntime } from '@proompteng/temporal-bun-sdk'

const runtime = new CoreRuntime({
  telemetry: {
    prometheus: {
      bindAddress: '0.0.0.0:9090'
    },
    otlp: {
      endpoint: 'http://localhost:4317'
    }
  },
  logging: {
    level: 'info',
    forwardTo: (level, message) => {
      console.log(`[${level}] ${message}`)
    }
  }
})

// Configure telemetry
await runtime.configureTelemetry({
  prometheus: { bindAddress: '0.0.0.0:9090' },
  otlp: { endpoint: 'http://localhost:4317' }
})

// Install logger
await runtime.installLogger((level, message) => {
  console.log(`[${level}] ${message}`)
})
```

### Workflow Definition

```ts
// workflows/my-workflow.ts
export default async function myWorkflow(input: any) {
  console.log('Workflow started with input:', input)
  
  // Use Bun-specific APIs
  await Bun.sleep(100)
  
  return {
    success: true,
    message: `Processed: ${input.message}`,
    bunVersion: Bun.version,
    runtime: 'bun',
    processedAt: new Date().toISOString()
  }
}
```

### Activity Definition

```ts
// activities/my-activity.ts
export async function myActivity(input: any) {
  console.log('Activity started with input:', input)
  
  // Simulate work
  await Bun.sleep(50)
  
  return {
    success: true,
    result: `Activity completed: ${input.task}`,
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
```

### Worker Runtime

```ts
import { WorkerRuntime } from '@proompteng/temporal-bun-sdk'

// Create worker
const worker = await WorkerRuntime.create({
  workflowsPath: './workflows',
  activities: {
    'my-activity': myActivity
  },
  taskQueue: 'my-queue',
  namespace: 'default'
})

// Start worker
await worker.run()
```

## CLI

The package ships a CLI for project scaffolding and container packaging.

```bash
# Initialize a new project
temporal-bun init my-worker
cd my-worker
bun install
bun run dev          # runs the worker locally
bun run docker:build # builds Docker image via Bun script
```

Verify connectivity to your Temporal cluster:

```bash
temporal-bun check --namespace default
```

Build Docker image:

```bash
temporal-bun docker-build --tag my-worker:latest
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | `http://127.0.0.1:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Namespace for workflows |
| `TEMPORAL_TASK_QUEUE` | `default` | Task queue for workers |
| `TEMPORAL_API_KEY` | _unset_ | API key for Temporal Cloud |
| `TEMPORAL_TLS_CA_PATH` | _unset_ | Path to TLS CA certificate |
| `TEMPORAL_TLS_CERT_PATH` | _unset_ | Path to TLS client certificate |
| `TEMPORAL_TLS_KEY_PATH` | _unset_ | Path to TLS client key |
| `TEMPORAL_TLS_SERVER_NAME` | _unset_ | TLS server name override |
| `TEMPORAL_ALLOW_INSECURE` | `false` | Allow insecure connections |
| `TEMPORAL_WORKER_IDENTITY_PREFIX` | `temporal-bun-worker` | Worker identity prefix |

## Docker

Build the worker image:

```bash
docker build -f packages/temporal-bun-sdk/Dockerfile -t temporal-bun-sdk:dev .
```

Or use Docker Compose for full stack:

```bash
docker compose -f packages/temporal-bun-sdk/tests/docker-compose.yaml up --build
```

## Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Watch and run worker in development mode |
| `bun run build` | Build TypeScript to `dist/` |
| `bun run test` | Run test suite |
| `bun run test:coverage` | Run tests with coverage |
| `bun run start:worker` | Start compiled worker |
| `bun run build:native` | Build native bridge |
