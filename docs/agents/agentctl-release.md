# agentctl release process

This document describes how to build and publish `agentctl` (bundled with the Jangar service) for npm and Homebrew.
`agentctl` ships with Jangar and uses gRPC only (no direct Kubernetes access).

## Prereqs

- Bun 1.3.5
- npm (for publishing)
- Access to `proompteng` npm org and the Homebrew tap repo

## Build artifacts

`agentctl` is packaged as Bun single binaries for each target (macOS/Linux, amd64/arm64) plus an npm launcher
that dispatches to the correct compiled binary.

From the repo root:

```bash
bun run --filter @proompteng/agentctl build
bun run --filter @proompteng/agentctl build:bin
bun run --filter @proompteng/agentctl build:bins
bun run --filter @proompteng/agentctl build:release
```

Artifacts:

- `services/jangar/agentctl/dist/agentctl.js` (npm launcher; dispatches to platform binary)
- `services/jangar/agentctl/dist/agentctl-<os>-<arch>` (standalone Bun-compiled binary)
- `services/jangar/agentctl/dist/agentctl` (host binary helper for npm + local runs)
- `services/jangar/agentctl/dist/release/agentctl-<version>-<os>-<arch>.tar.gz`
- Each archive contains a single `agentctl` binary (no suffix).
- `services/jangar/agentctl/dist/release/*.sha256`
- `services/jangar/agentctl/dist/release/agentctl.rb` (Homebrew formula with checksums, generated when all targets are built)
- Compiled binaries use Bun's CJS output format plus `--compile-autoload-package-json` so `@grpc/grpc-js` can read its
  embedded package metadata when running as a standalone binary.

`build:release` builds all targets by default. To limit targets (e.g., per-OS builds in CI), set
`AGENTCTL_TARGETS=darwin-amd64,darwin-arm64,linux-amd64,linux-arm64` or pass `--targets`.

## Validation (compiled binary)

By default, the validation script spins up a local mock gRPC server and exercises the compiled binary:

```bash
bun run --filter @proompteng/agentctl build:bin
bun run --filter @proompteng/agentctl validate:bin
```

To validate against a port-forwarded in-cluster server instead:

```bash
kubectl -n agents port-forward svc/agents-grpc 50052:50051
bun run --filter @proompteng/agentctl validate:bin -- --server 127.0.0.1:50052
```

## Publish npm

Before publishing, confirm the npm metadata is correct in `services/jangar/agentctl/package.json`:

- `name`, `version`, `description`, `license`, `repository`, and `homepage`
- `bugs` points to the repo issues page and `publishConfig.access` is `public`
- `bin` points to `dist/agentctl.js`
- `files` includes `dist/` and `README.md`

```bash
bun run --filter @proompteng/agentctl validate:metadata
```

```bash
cd services/jangar/agentctl
npm run prepack # builds launcher + all platform binaries
npm pack --dry-run # optional sanity check: ensures dist/ contains launcher + binaries
npm publish --access public
```

## Homebrew

1. Upload the compiled archives from `dist/release` to a GitHub release.
2. To generate the formula, run `bun run --filter @proompteng/agentctl build:release` (or set
   `AGENTCTL_TARGETS=darwin-amd64,darwin-arm64,linux-amd64,linux-arm64`) so all checksums are present.
3. If you built artifacts on multiple machines, combine them and run
   `bun run --filter @proompteng/agentctl homebrew:generate -- --input dist/release`
   to generate `agentctl.rb` with verified checksums.
4. Copy the generated `dist/release/agentctl.rb` into the Homebrew tap repo and commit.
4. If needed, the template lives at `services/jangar/agentctl/scripts/homebrew/agentctl.rb`.

Example checksum:

```bash
shasum -a 256 dist/release/agentctl-<version>-darwin-arm64.tar.gz
shasum -a 256 dist/release/agentctl-<version>-darwin-amd64.tar.gz
shasum -a 256 dist/release/agentctl-<version>-linux-arm64.tar.gz
shasum -a 256 dist/release/agentctl-<version>-linux-amd64.tar.gz
```

## CI release (tag)

Push a semver tag (e.g. `v0.1.0`) to trigger `.github/workflows/agentctl-release.yml`. It:

- builds all target binaries and archives,
- uploads the artifacts to the GitHub release,
- optionally publishes npm if `NPM_TOKEN` is available.

```bash
git tag v0.1.0
git push origin v0.1.0
```
