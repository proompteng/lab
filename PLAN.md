# Implementation Plan – Issue #1514

## Summary
Bundle the Zig bridge artifacts for macOS and Linux into the Temporal Bun SDK npm package and ensure documentation/runtime prefer the packaged Zig builds.

## Steps
1. Extend `packages/temporal-bun-sdk/native/temporal-bun-bridge-zig/build.zig` plus a new orchestration script to compile ReleaseFast libraries for macOS (arm64+x64) and Linux (arm64+x64), staging them in per-target folders under `native/temporal-bun-bridge-zig/zig-out/lib` so they can be copied into the package.
2. Add a packaging helper (e.g. `packages/temporal-bun-sdk/scripts/package-zig-artifacts.ts`) invoked by `prepack`/publish workflows to copy the staged libs into `dist/native/<platform>/<arch>/` and ensure filenames follow Node/Bun ffi expectations.
3. Update `packages/temporal-bun-sdk/package.json` (`files` array, scripts) and any release automation to include `dist/native/**` in the tarball and to run the Zig build helper before packing so `pnpm pack` emits the binaries.
4. Enhance `packages/temporal-bun-sdk/src/internal/core-bridge/native.ts` to prefer packaged Zig artifacts (checking `dist/native/<platform>/<arch>`) and cleanly fall back to Rust when missing, including improved logging for missing binaries.
5. Refresh docs (README TODO removal, publish notes) and add release notes covering supported platforms plus any environment variables.

## Validation
- `pnpm --filter @proompteng/temporal-bun-sdk run build` (ensures dist output still builds TypeScript).
- `pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig:bundle && pnpm pack --filter @proompteng/temporal-bun-sdk` then inspect tarball for `dist/native/<platform>/<arch>/libtemporal_bun_bridge_zig.*`.
- Install the packed tarball into a throwaway project and run `TEMPORAL_BUN_SDK_USE_ZIG=1 bun test` (or existing smoke script) to confirm FFI loads the Zig bridge on host architecture.

## Risks
- Cross-compiling macOS binaries from Linux may require extra SDK or Zig configuration; CI might need macOS runners for `aarch64-macos` builds.
- Expanding the package `files` whitelist to include `dist/native` grows the published tarball; monitor npm size limits before release.
- Runtime detection must cover all packaging layouts; incorrect paths could break Zig fallback and impact users relying on Rust bridge.

## Handoff Notes
- Ensure the Codex progress comment stays updated via `apps/froussard/src/codex/cli/codex-progress-comment.ts`. Branch work continues on `codex/issue-1514-e007f300`.
