# Codex Image Asset Rehome (Froussard -> Jangar)

Status: Implemented (2026-02-05)

## Summary

Moved the Codex Docker image assets (Dockerfile, runtime scripts, and build helper) out of `apps/froussard` and into
`services/jangar` so the control-plane service owns the agent runtime image. This eliminates cross-service coupling,
reduces duplicate Codex CLI sources in Froussard, and aligns the image build flow with the Jangar-managed workflows.

## Background

Previously the Codex runtime image was built from `apps/froussard/Dockerfile.codex`, and the build helper lived under
`apps/froussard/src/codex/cli/build-codex-image.ts`. The Dockerfile copied multiple Codex CLI scripts and config files
from the Froussard tree. Jangar already carried parallel copies of some of these scripts (for example
`services/jangar/scripts/codex-implement.ts` and `services/jangar/scripts/agent-runner.ts`) plus a richer
`codex-config-container.toml`, which had already diverged from the Froussard copy.

The Codex image is a Jangar/agents concern, not a Froussard concern. Keeping its build assets in Froussard makes it
harder to evolve Jangar without touching unrelated webhook code and increases risk of drift between duplicate scripts.

## Goals

- Make Jangar the single owner of the Codex runtime image assets.
- Remove duplicate Codex CLI sources and container config.
- Keep the Docker image output and runtime behavior unchanged.
- Update docs and tests so new paths are the source of truth.

## Non-goals

- Change workflow templates, image tags, or registry locations.
- Redesign Codex runtime behavior, logging, or environment contracts.
- Refactor Froussard webhook logic or Codex task parsing.

## Current State (Post-move)

- Dockerfile: `services/jangar/Dockerfile.codex`.
- Build helper: `services/jangar/scripts/build-codex-image.ts`.
- Container config: `services/jangar/scripts/codex-config-container.toml`.
- Runtime scripts copied into the image:
  - `services/jangar/scripts/codex/codex-bootstrap.ts`
  - `services/jangar/scripts/codex/agent-runner.ts`
  - `services/jangar/scripts/codex/codex-implement.ts`
  - `services/jangar/scripts/codex/codex-research.ts`
  - `services/jangar/scripts/codex/codex-graf.ts`
  - `services/jangar/scripts/codex/lib/**`
  - `services/jangar/scripts/codex-nats-publish.ts`
  - `services/jangar/scripts/codex-nats-soak.ts`
  - `services/jangar/scripts/discord-channel.ts`
- Jangar service runtime still uses its own `services/jangar/scripts/agent-runner.ts` and
  `services/jangar/scripts/codex-implement.ts` for the control-plane container image.

## Implemented Changes

### New ownership and layout

Moved Codex image assets to `services/jangar` and treat Jangar as the only source of truth for the Codex runtime image.

Recommended layout:

- `services/jangar/Dockerfile.codex`
- `services/jangar/scripts/build-codex-image.ts`
- `services/jangar/scripts/codex-config-container.toml` (authoritative)
- `services/jangar/scripts/codex/` (Codex CLI entrypoints + lib helpers)
- `services/jangar/scripts/codex/__tests__` (unit tests for CLI helpers)

This keeps the image inputs co-located with Jangar while preserving a clear boundary between image assets and the
primary Jangar app code.

### File move map

| Current path | New path |
| --- | --- |
| `apps/froussard/Dockerfile.codex` | `services/jangar/Dockerfile.codex` |
| `apps/froussard/src/codex/cli/build-codex-image.ts` | `services/jangar/scripts/build-codex-image.ts` |
| `apps/froussard/scripts/codex-config-container.toml` | `services/jangar/scripts/codex-config-container.toml` |
| `apps/froussard/src/codex/cli/*` | `services/jangar/scripts/codex/*` |
| `apps/froussard/src/codex/cli/lib/*` | `services/jangar/scripts/codex/lib/*` |
| `apps/froussard/src/codex/cli/__tests__/*` | `services/jangar/scripts/codex/__tests__/*` |
| `apps/froussard/scripts/codex-nats-publish.ts` | `services/jangar/scripts/codex-nats-publish.ts` |
| `apps/froussard/scripts/codex-nats-soak.ts` | `services/jangar/scripts/codex-nats-soak.ts` |
| `apps/froussard/scripts/discord-channel.ts` | `services/jangar/scripts/discord-channel.ts` |

### Consolidate duplicate scripts

- Codex runtime image now uses the relocated scripts under `services/jangar/scripts/codex/` to preserve existing
  behavior.
- The Jangar service container continues to use `services/jangar/scripts/agent-runner.ts` and
  `services/jangar/scripts/codex-implement.ts` for control-plane tasks.

### Update Dockerfile references

- Update `COPY` statements in `services/jangar/Dockerfile.codex` to use the new `services/jangar/scripts/codex/*`
  and `services/jangar/scripts/*` paths.
- Keep build context at the repo root so the Dockerfile can still access workspace packages.

### Update build helper

- Point the build helper at `services/jangar/Dockerfile.codex` by default.
- Keep the same env overrides (`DOCKERFILE`, `IMAGE_TAG`, `CONTEXT_DIR`, `CODEX_AUTH`, `CODEX_CONFIG`).
- Remove the hardcoded `apps/froussard/Dockerfile.codex` fallback path.

### Documentation and references

Update references to the Dockerfile and build helper in:

- `docs/runbooks/codex-docker.md`
- `docs/autonomous-codex-design.md`
- `docs/agents/agents-helm-chart-design.md`
- `apps/froussard/README.md`

## Implementation Notes

- Moved Dockerfile, build helper, CLI scripts, and NATS/Discord helpers into `services/jangar`.
- Updated the Codex image Dockerfile `COPY` statements to the new Jangar paths.
- Moved CLI tests under `services/jangar/scripts/codex/__tests__` and extended Jangar Vitest config to include scripts.
- Updated docs and runbooks to reference the new paths.

## Validation

- `bunx vitest run --config services/jangar/vitest.config.ts` (ensure moved CLI tests pass).
- `bun services/jangar/scripts/build-codex-image.ts` (build succeeds, push optional).
- `docker build -f services/jangar/Dockerfile.codex -t codex-universal:test .` (basic image build).

## Risks and Mitigations

- Risk: Divergent Jangar/Froussard CLI scripts cause behavioral regression.
  Mitigation: Diff and reconcile before removing Froussard copies, keep unit tests with the moved scripts.
- Risk: Docker build context misses files after move.
  Mitigation: Keep repo root as build context, update `COPY` paths explicitly, verify with a local build.
- Risk: Docs and runbooks still point at old paths.
  Mitigation: Update all known references in the same change.

## Assumptions

- Jangar is the intended long-term owner of Codex workflow runtime assets.
- The image tag and registry remain `registry.ide-newton.ts.net/lab/codex-universal:latest` for now.
