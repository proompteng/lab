# Nix Adoption Next Phase - 2026-06-27

## Executive Summary

The next phase is not "start Attic immediately." The next phase is to land the
existing Nix/OCI foundation PR, rerun proof from current `main`, then roll out
Attic as the first production cache service.

Current `origin/main` does not contain `flake.nix`, `flake.lock`, `nix/`, or the
Nix workflows. The Nix adoption work exists on open PR
`#11486` (`codex/adopt-nix-toolchain`) and is currently an 11-commit branch on
top of older `main`.

Recommended order:

1. Refresh and merge PR `#11486`.
2. Run a same-head benchmark on an enabled service after refresh.
3. Deploy Attic as the shared cluster-hosted Nix cache.
4. Wire trusted CI cache consumption and main-branch-only cache push.
5. Migrate additional image workflows to the native OCI reusable workflow only
   after the cache/readback surface is stable.

## Current State

Fresh branch used for this research:

```text
codex/nix-adoption-next-phase-20260627
base: origin/main at f61803a102
```

Current `main` has no first-class Nix files:

```text
no flake.nix
no flake.lock
no nix/
no .github/workflows/nix-toolchain.yml
no .github/workflows/oci-native-build-common.yml
```

The active Nix implementation is PR `#11486`:

```text
title: feat(nix): add native oci build tooling
branch: codex/adopt-nix-toolchain
state: OPEN
latest head: d886658ab3447123c25d80f99f12b493ab45c1de
ahead/behind vs current origin/main: 11 ahead, 88 behind
```

The PR is green from the GitHub check surface inspected on 2026-06-27. It has no
GitHub review decision yet. `git merge-tree` found no textual conflicts against
current `origin/main`, and the Nix-touched files have not changed on `main`
since the PR was last updated.

## What PR #11486 Adds

The open PR adds the actual Phase 1 foundation:

- `flake.nix` and `flake.lock` for a pinned multi-platform repo toolchain.
- `nix/packages.nix` for exact tool wrappers where nixpkgs versions do not match
  repo requirements.
- `nix/toolchain-doctor.sh` and `nix/oci-doctor.sh`.
- `.envrc.example` for opt-in `direnv`.
- `.github/workflows/nix-toolchain.yml`.
- `.github/workflows/oci-native-build-common.yml`.
- `.github/workflows/oci-builder-benchmark.yml`.
- `packages/scripts/src/shared/oci.ts` plus tests.
- A native-OCI canary conversion for `facteur`.
- Docs for OCI proof and Attic cache rollout.

Important implementation shape:

- Nix is additive. It pins outer repo tools; it does not replace Bun, Go,
  Python, Ruby, or service package managers.
- The corrected hot path does not run `nix develop` inside every per-platform
  image build. Nix is used for toolchain validation and publish/index tooling.
- The reusable native OCI workflow builds `linux/amd64` on `arc-amd64` and
  `linux/arm64` on `arc-arm64`, then publishes a multi-platform index.

## Current Proof Quality

The PR has useful proof, but it should be normalized before merge:

- PR checks are passing.
- Latest observed benchmark check on the PR showed:
  - legacy single-runner Buildx: `1m30s`
  - native Buildx amd64: `1m14s`
  - native Buildx arm64: `1m25s`
  - effective native wall-clock: `1m25s`
- The PR body also records prior Froussard benchmark runs with larger wins.

The benchmark story is directionally good, but the next merge pass should rerun
one current-head benchmark with the exact service, run id, and seconds captured
in the PR body. Avoid mixing cold, warm, Facteur, and Froussard numbers as one
claim.

## Phase 1: Land The Nix Foundation

This is the immediate next phase.

Steps:

1. Rebase or merge `origin/main` into `codex/adopt-nix-toolchain`.
2. Rerun local static validation that does not require host Nix:
   - workflow YAML parse
   - `actionlint`
   - `shellcheck` for `nix/*.sh`
   - Bun tests for `packages/scripts/src/shared/oci.ts`
   - `git diff --check`
3. Use GitHub Actions for Nix-specific proof because this desktop shell does not
   currently have `nix` on `PATH`.
4. Rerun `nix-toolchain.yml`.
5. Rerun `oci-builder-benchmark.yml` against one enabled service. Prefer
   `froussard` because it is an enabled app with a representative Bun/Node image
   and already appears in the prior proof trail.
6. Update PR body with one current-head benchmark table.
7. Merge after checks are green.

Acceptance gates:

- `nix flake check` passes in CI.
- `nix develop -c toolchain-doctor` passes in CI.
- `nix develop -c oci-doctor` passes in CI.
- `nix run .#lint-argocd`, `.#render-headlamp`, and
  `.#lint-argo-workflows` pass.
- Native OCI publish/index canary passes for `facteur`.
- One enabled-service benchmark is attached with exact run URL and measured
  seconds.

## Phase 2: Deploy Attic Cache

After Phase 1 is merged, implement the Attic plan as the first production Nix
cache service.

Why Attic is the right next service:

- It matches the repo's existing platform primitives: Argo CD ApplicationSet,
  Rook/Ceph S3 bucket, CNPG Postgres, External Secrets, private ingress, and ARC
  runners.
- It supports a shared cache model instead of depending on one local builder's
  `/nix/store`.
- It lets CI consume substitutions first, then push from trusted main-branch
  contexts only.

Required repo changes:

- Add `argocd/applications/attic/`.
- Add the `attic` element to `argocd/applicationsets/platform.yaml`.
- Add an ObjectBucketClaim for cache storage.
- Add a CNPG cluster for Attic metadata.
- Add ExternalSecret wiring for signing key and CI token.
- Add private ingress and Tailscale exposure.
- Add an idempotent bootstrap job for the `lab` cache and scoped CI token.
- Add a garbage-collection CronJob.
- Add `nix/cache-doctor.sh` and `nix/cache-push.sh`.
- Add `docs/nix-cache.md`.

Rollout gates:

- Argo app `attic` is `Synced` and healthy.
- `atticd` readiness is green.
- `cache-doctor` proves the substituter endpoint and public key are reachable.
- CI can consume the cache without token access.
- Only trusted `main` CI can push to the cache.
- A second `nix-toolchain` run shows measurable substitution wins after a warm
  cache.

## Phase 3: Expand Native OCI Workflow Deliberately

Do not mass-convert all build workflows in one PR. Convert services in batches
based on risk and build shape.

Current build-push workflows still using direct Buildx or handwritten Buildx:

```text
.github/workflows/agents-build-push.yml
.github/workflows/dernier-build-push.yaml
.github/workflows/facteur-build-push.yaml
.github/workflows/graf-build-push.yaml
.github/workflows/jangar-build-push.yaml
.github/workflows/symphony-build-push.yaml
.github/workflows/torghut-build-push.yaml
.github/workflows/torghut-hyperliquid-feed-build-push.yaml
.github/workflows/torghut-ta-build-push.yaml
.github/workflows/torghut-ws-build-push.yaml
.github/workflows/vecteur-manual-build-push.yaml
```

Suggested migration order:

1. Keep `facteur` as the canary from PR `#11486`.
2. Convert one low-risk app workflow with simple image metadata.
3. Convert `froussard` or another enabled Bun app for a representative app image.
4. Convert `agents` only after output contract parity is proven.
5. Convert Torghut-family workflows last, because they are tied to release PRs,
   post-deploy verification, and runtime smoke gates.

Each conversion must preserve:

- image name
- immutable SHA tag
- `latest` behavior
- build args
- cache behavior
- OCI index digest output
- release PR trigger behavior
- post-deploy verification behavior

## Phase 4: Broaden Toolchain Adoption

After cache rollout and OCI conversion are stable, use Nix to pin more outer
tooling surfaces:

- `actionlint`
- `oxfmt`
- `go-task` or equivalent task runner if adopted
- Terraform/OpenTofu provider validation helpers
- Helm/Kustomize render wrappers for more Argo apps
- schema tooling used by kubeconform and Argo Workflow lint

Avoid moving application dependency resolution into Nix at this stage. Keep
language package managers authoritative:

- Bun keeps owning JavaScript dependencies.
- Go modules keep owning Go dependencies.
- Ruby/Bundler keeps owning Rails/Gem dependencies.
- `uv` keeps owning Python environments.

## Key Risks

1. **Unmerged foundation risk**
   - Until PR `#11486` lands, `main` has no Nix adoption.

2. **Benchmark ambiguity**
   - Prior proof contains multiple benchmark runs. Use one current-head run as
     the merge gate.

3. **CI trust boundary**
   - Cache push must be main-branch-only. Pull requests should consume public
     substitutions but must not get write tokens.

4. **Runtime rollout blast radius**
   - Converting Torghut build workflows too early can affect image promotion and
     post-deploy verification. Do it only after simpler services are stable.

5. **Developer setup drift**
   - Nix must remain additive. Developers without Nix need clear fallback commands
     until `nix develop` is proven reliable on macOS and ARC.

## Recommendation

Use this sequence:

```text
PR A: refresh and merge #11486
PR B: Attic cache GitOps service + cache doctor/push wrappers
PR C: CI cache consumption/push wiring
PR D: one additional non-Torghut native OCI workflow conversion
PR E: broader workflow migration batch
PR F: Torghut-family workflow conversion after release/smoke contract tests
```

That keeps the adoption production-safe: foundation first, cache second,
workflow migration third, high-blast-radius service builds last.
