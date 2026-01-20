# agentctl release process

This document describes how to build and publish `agentctl` for npm and Homebrew.

## Prereqs

- Bun 1.3.5
- npm (for publishing)
- Access to `proompteng` npm org and the Homebrew tap repo

## Build artifacts

From the repo root:

```bash
bun run --filter @proompteng/agentctl build
bun run --filter @proompteng/agentctl build:bin
bun run --filter @proompteng/agentctl build:bins
bun run --filter @proompteng/agentctl build:release
```

Artifacts:

- `services/jangar/agentctl/dist/agentctl.js` (npm entry)
- `services/jangar/agentctl/dist/agentctl-<os>-<arch>` (standalone binary)
- `services/jangar/agentctl/dist/release/agentctl-<version>-<os>-<arch>.tar.gz`
- `services/jangar/agentctl/dist/release/*.sha256`
- `services/jangar/agentctl/dist/release/agentctl.rb` (Homebrew formula with checksums, generated when all targets are built)

## Publish npm

```bash
cd services/jangar/agentctl
npm publish --access public
```

## Homebrew

1. Upload the compiled archives from `dist/release` to a GitHub release.
2. To generate the formula, run `bun run --filter @proompteng/agentctl build:release -- --all` (or set
   `AGENTCTL_TARGETS=darwin-amd64,darwin-arm64,linux-amd64,linux-arm64`) so all checksums are present.
3. Copy the generated `dist/release/agentctl.rb` into the Homebrew tap repo and commit.
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
