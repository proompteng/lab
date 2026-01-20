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
```

Artifacts:

- `services/jangar/agentctl/dist/agentctl.js` (npm entry)
- `services/jangar/agentctl/dist/agentctl` (standalone binary)

## Publish npm

```bash
cd services/jangar/agentctl
npm publish --access public
```

## Homebrew

1. Upload the compiled `agentctl` binary to the release bucket or GitHub release.
2. Compute the SHA256 checksum.
3. Update the Homebrew formula in the tap repository with the new version and checksum.

Example checksum:

```bash
shasum -a 256 dist/agentctl
```

