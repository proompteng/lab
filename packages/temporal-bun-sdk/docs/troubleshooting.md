# Troubleshooting & FAQ

Use this guide to resolve the most common issues when running the Bun-native Temporal SDK and Zig bridge.

## Bridge Fails to Load (`NativeBridgeError: failed to load libtemporal_bun_bridge_zig`)
1. Confirm `TEMPORAL_BUN_SDK_USE_ZIG=1` is set. Without it the worker helper short-circuits and may surface confusing errors.
2. Run `bun run libs:download` to fetch the prebuilt Temporal static libraries used by the Zig build.
3. Rebuild the bridge:
   ```bash
   bun run build:native:zig
   bun run build:native:zig:bundle
   bun run package:native:zig
   ```
4. Confirm the host is supported (Linux x64/arm64 or macOS arm64). The Bun SDK no longer ships a Node fallback; build the Zig bridge from source or run the worker from a supported host when targeting other platforms.
5. Verify `dist/native/<platform>/<arch>/libtemporal_bun_bridge_zig.*` exists inside the package (`pnpm pack --filter @proompteng/temporal-bun-sdk && tar tf @proompteng-temporal-bun-sdk-*.tgz`).

## TLS Errors (`certificate verify failed` or `UNKNOWN: bad certificate format`)
- Ensure both `TEMPORAL_TLS_CERT_PATH` and `TEMPORAL_TLS_KEY_PATH` are set for mTLS. The loader throws when the pair is incomplete.
- Use PEM-encoded certificates/keys. DER files need conversion (`openssl x509 -inform der -in cert.der -out cert.pem`).
- When connecting to Temporal Cloud, set `TEMPORAL_TLS_SERVER_NAME=temporal.cloud` (or your tenancy-specific endpoint) to align with the issued certificate.
- For local testing with self-signed certs, set `TEMPORAL_ALLOW_INSECURE=1` in addition to `TEMPORAL_TLS_CA_PATH`.

## API Key Authentication Fails
- Double-check that `TEMPORAL_API_KEY` is present in the worker environment.
- API keys are mutually exclusive with mTLS client certificates. Remove `TEMPORAL_TLS_CERT_PATH`/`TEMPORAL_TLS_KEY_PATH` when using API keys only.
- Use `temporal-bun check --namespace <ns>` to confirm the runtime can authenticate; failures bubble up detailed status codes from Temporal Core.

## `NativeBridgeError: temporal-bun-bridge-zig: worker creation failed`
- Ensure the Temporal namespace endpoint is reachable. When using the Temporal CLI dev server, keep `temporal server start-dev` (or the `temporal:start` helper script) running before launching the worker.
- Verify the Zig bridge library resolved to the expected path by setting `TEMPORAL_BUN_SDK_NATIVE_PATH` and watching for load warnings in stdout.
- Confirm `TEMPORAL_TASK_QUEUE`, `TEMPORAL_NAMESPACE`, and `TEMPORAL_ADDRESS` are populated; empty strings are rejected with the same error code.
- Inspect the `NativeBridgeError` diagnostics that are logged alongside the failure; resolve the reported configuration or bridge issue before retrying (the Bun worker no longer supports falling back to the Node SDK).

## CI Pipelines Cannot Access Zig
- Install Zig 0.15.1 in CI (see `.github/workflows/temporal-bun-sdk.yml`). The scripts assume `zig` is on PATH.
- Cache `.temporal-libs-cache` between runs to avoid re-downloading large static libraries.
- Run `bun run libs:download` before `bun run build:native:zig` so the Zig build has the required archives.

## Unsupported Platforms
- The published Zig artefacts target Linux x64/arm64 and macOS arm64. For other platforms, cross-compile the bridge (`bun run build:native:zig`) or run the worker on a supported host until additional artefacts ship.
- If you need to compare against the Temporal Node worker, run it from the Node SDK directly; the Bun SDK no longer bundles the vendor fallback.
- Capture bridge logs and `NativeBridgeError` payloads when reporting unsupported-host issues so the runtime team can prioritise porting work.

## Where Do Temporal Core Logs Go?
- Install a logger via `coreBridge.runtime.createRuntime().installLogger(event => { … })`. Without a logger callback, log records are dropped.
- The bridge spawns a background flush thread when the linked Temporal Core export supports it. Logs flush roughly every 300 ms and once more during shutdown so the callback sees every record.
- Write events anywhere you prefer—e.g. mirror to `console` for local dev and append to `./logs/temporal-core.log` in production using Node’s `fs.createWriteStream`.
- If you rotate files, call `runtime.removeLogger()` before closing the old stream, then reinstall the logger with the new destination.
- When upgrading static libraries, ensure they export `temporal_core_runtime_flush_logs` (or its legacy alias). Without it the bridge still works, but flushing falls back to Temporal Core’s internal cadence.

## Packed Tarball Missing Zig Artefacts
1. Run `pnpm --filter @proompteng/temporal-bun-sdk run build` to emit TypeScript output.
2. Execute `pnpm pack --filter @proompteng/temporal-bun-sdk`.
3. Inspect the tarball:
   ```bash
   tar tf @proompteng-temporal-bun-sdk-*.tgz | grep 'dist/native'
   ```
4. If entries are missing, ensure `bun run package:native:zig` succeeded and that `scripts/package-zig-artifacts.ts` copied artefacts into `dist/native`.
5. On hosts without macOS frameworks installed, set `TEMPORAL_BUN_SDK_TARGETS=linux-arm64,linux-x64` before running the packaging scripts, or install the macOS SDK and expose it via `SDKROOT` so the Zig build can link `Security.framework`, `CoreFoundation.framework`, `SystemConfiguration.framework`, and `IOKit.framework`.

## Support Channels
- Post questions in the Temporal platform Slack channel `#temporal-bun-sdk`.
- File GitHub issues with repro steps and the output of `temporal-bun --version` plus `zig version`.
- Capture `NativeBridgeError` payloads (JSON) and include them when escalating bridge issues.
