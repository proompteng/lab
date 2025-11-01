# Migration Guide

**Goal:** Move projects from the hybrid `@temporalio/*` SDKs to the Bun-native `@proompteng/temporal-bun-sdk` while keeping deterministic behaviour and TLS/API key integrations intact.

## Who Should Read This?
- Teams currently running Temporal workers with Node.js and the official `@temporalio/{client,worker,activity,workflow}` packages.
- Contributors upgrading existing Temporal Bun experiments that still rely on the upstream bridge or the vendor fallback.
- CI/CD owners validating that the published package carries prebuilt Zig artefacts so workflow deployments stay hermetic.

## Prerequisites
- Bun ≥ 1.1.20 installed locally and in CI.
- Zig 0.15.1 available for platforms where you need to rebuild the bridge (Linux arm64/x64, macOS arm64). The published package includes precompiled artefacts.
- Temporal namespace credentials (API key or TLS certificates) and access to either the Temporal CLI dev server or your Temporal Cloud namespace.

## Migration Checklist

1. **Remove upstream dependencies**
   - Delete `@temporalio/client`, `@temporalio/activity`, and any direct imports of `@temporalio/core-bridge` from your package manifests.
   - Keep `@temporalio/workflow` only for workflow sandbox APIs that have not been reimplemented yet.

2. **Install the Bun SDK**
   ```bash
   bun add @proompteng/temporal-bun-sdk
   # or inside this monorepo
   pnpm install
   ```

3. **Configure environment variables**
   - Create an `.env` (or update your deployment secrets) using the variables described in the README quickstart (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, TLS paths, `TEMPORAL_BUN_SDK_USE_ZIG=1`).
   - For mTLS, provide both `TEMPORAL_TLS_CERT_PATH` and `TEMPORAL_TLS_KEY_PATH`. The loader throws when only one is set.

4. **Update client/bootstrap code**
   ```ts
   import { createTemporalClient, loadTemporalConfig } from '@proompteng/temporal-bun-sdk'

   const config = await loadTemporalConfig()
   const { client, runtime } = await createTemporalClient({
     address: config.address,
     namespace: config.namespace,
     dataConverter: undefined, // default JSON converter
     apiKey: config.apiKey,
     tls: config.tls,
   })
   ```
   - Replace calls to `Connection.connect` or `WorkflowClient` from `@temporalio/client` with `createTemporalClient`.
   - Header updates now flow through `client.updateHeaders`. See `docs/ts-core-bridge.md` for serialization details.

5. **Swap worker bootstrap**
   ```ts
   import { createWorker } from '@proompteng/temporal-bun-sdk/worker'

   const { worker } = await createWorker({
     taskQueue: 'prix',
     workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
   })

   await worker.run()
   ```
   - Ensure `TEMPORAL_BUN_SDK_USE_ZIG=1` in the worker environment. When unset, the helper falls back to `@temporalio/worker` only if `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1` is explicitly set.
   - Activities continue to use Bun functions; no additional wrappers are required.

6. **Regenerate build/pack scripts**
   - Replace `npm run build` invocations with `bun run build` (or `pnpm --filter @proompteng/temporal-bun-sdk run build` inside this monorepo).
   - Call `bun run libs:download` during CI bootstrap to populate `.temporal-libs-cache` before running Zig builds or packaging.
   - Use `pnpm pack --filter @proompteng/temporal-bun-sdk` to verify that `dist/native/**` is included in the tarball.

7. **Validate the workflow**
   ```bash
   # Start local Temporal CLI server (optional)
   bun packages/temporal-bun-sdk/scripts/start-temporal-cli.ts

   # Run tests and worker
   pnpm --filter @proompteng/temporal-bun-sdk test
   TEMPORAL_BUN_SDK_USE_ZIG=1 bun run start:worker

   # Connectivity check
   TEMPORAL_BUN_SDK_USE_ZIG=1 temporal-bun check --namespace "$TEMPORAL_NAMESPACE"
   ```

8. **Remove legacy bridge hooks**
   - Delete references to `TEMPORAL_CORE_SERVER_URL` or other environment variables that only applied to the Node worker.
   - Remove code paths that toggled between the Rust and Zig bridges; the Zig bridge is now the primary runtime.

## Behaviour Changes to Note

| Area | Hybrid SDK | Bun SDK |
|------|------------|---------|
| Connection | `Connection.connect()` from `@temporalio/client` | `createTemporalClient()` backed by Zig-native handles |
| Worker default | `@temporalio/worker` Node runtime | Bun worker runtime uses Zig bridge when `TEMPORAL_BUN_SDK_USE_ZIG=1` |
| Vendor fallback | Implicit when Zig bridge missing | Opt-in via `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1` |
| TLS/API keys | Custom bootstrap code required | `loadTemporalConfig()` reads env and loads certificates |
| Replay | `@temporalio/worker` CLI | `temporal-bun replay` plus `runReplayHistory` |

## Post-Migration Validation
- Run `rg '@temporalio/' ./src --glob '*.ts'` to confirm only `@temporalio/workflow` remains in workflow code.
- Run `pnpm exec biome check <paths>` to satisfy formatting/linting requirements.
- Add the commands above to CI pipelines (see `.github/workflows/temporal-bun-sdk.yml` for reference).
- Inform operators that `TEMPORAL_BUN_SDK_USE_ZIG=1` is now mandatory outside the vendor fallback scenarios.

Need help? Review the [Troubleshooting & FAQ](./troubleshooting.md) for common issues and escalation steps.
