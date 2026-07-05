# Enabled-App Nix Build Performance Rollout Plan

## Summary

This rollout makes enabled repo-owned image builds faster, more reproducible, and fully Nix-backed. It does not count synthetic workflows, disabled apps, benchmark-only jobs, chart-only apps, or vendor manifests as production proof.

Source of truth:

- Enabled apps come from `argocd/root.yaml` and the ApplicationSets under `argocd/applicationsets`.
- Upstream Nix/Nixpkgs implementation notes are captured in `docs/nix-upstream-rollout-research.md`.
- Live rollout proof only counts root-enabled apps that own repo image builds.

Current inventory from the repo guardrail:

- 71 enabled ApplicationSet entries.
- 1 direct root-managed Application: `home-root`.
- Helm/chart-only apps do not receive image builds.
- Vendor/static manifest apps do not receive image builds unless this repo owns their image build path.
- External-source apps are not repo image migration targets.
- Repo-image apps must be either `nix-image`, explicitly `deferred`, or a documented manifest-only exception.
- Helm values that override chart images with `registry.ide-newton.ts.net/lab/...` count as repo-image references. `headlamp`
  is therefore deferred until its Docker-backed workflow is migrated or intentionally retired.

Hard exclusions:

- No Ceph, Rook, ObjectBucketClaim, PVC, Talos, node, power, or storage changes.
- No synchronous Nix `post-build-hook` cache upload in CI.
- No fake cache smoke/warm jobs.
- No Docker-backed build path may be described as native Nix OCI.

## Production Contracts

### Enabled-App Contract

The enabled-app scanner classifies each root-enabled app as:

- `nix-image`: this repo owns the image build path and the app has a concrete Nix image attr.
- `helm-chart`: chart-rendered third-party app; optimize render/lint/pinning/smoke only.
- `vendor-manifest`: static/upstream manifests; optimize digest pinning and smoke only.
- `external-source`: source repository is outside this repo.
- `deferred`: repo image exists, but migration needs a separate service-specific plan or clean live health first.

Guardrails fail if:

- chart/vendor/external apps receive image build state.
- a chart app unexpectedly owns lab images.
- a repo-image app lacks a `nix-image`, `deferred`, or documented manifest-only disposition.
- a `nix-image` app lacks a concrete Nix attr.
- a deferred app lacks a reason.

### Build Performance Contract

Every migrated image workflow must emit phase timings for:

- checkout
- Nix setup
- dependency realization/helper priming
- image build
- image inspection
- platform push
- OCI index creation
- release contract/PR handoff

Each summary reports:

- Attic substitutions.
- `cache.nixos.org` substitutions.
- local derivation builds.
- planned local build blocks.
- timed phase count.
- total timed seconds.
- image archive observations and bytes when the local archive still exists.

Required gate: no migrated mandatory workflow may regress by more than 10%. Warm Nix runs should reduce repeated setup/dependency time by at least 25%.

### Reproducibility Contract

Each migrated image must produce a release contract with:

- service name.
- source SHA.
- lockfile hashes.
- Nix attr.
- Nix output path.
- OCI digest.
- platforms.
- tool versions.
- cache provenance.
- timings.

Same commit plus same lockfiles should reproduce the same Nix output path and OCI digest. Use `nix build --rebuild` where practical and `max-jobs = 0` substitute-only proof for warmed closures.

### Nix Image Contract

- Use `dockerTools.buildLayeredImage` or a service-specific derivation around it.
- Do not emulate Dockerfile builds.
- Do not use `created = "now"`.
- Tune `maxLayers` based on layer reuse and registry push cost.
- Push platform images with `skopeo`.
- Create and verify multi-platform indexes with `crane`.

## Rollout Sequence

1. **PR 1: Upstream Research, Metrics, And Gates**
   - Clone/read upstream Nix and Nixpkgs references.
   - Add the research notes to docs.
   - Tighten enabled-app inventory policy.
   - Add real checkout/Nix setup timers to the reusable Nix OCI workflow.
   - Extend cache/performance summaries.
   - Add tests for enabled-app disposition, workflow timing, fake-job removal, and deterministic image rules.
   - No service migration.

2. **PR 2: ARC Runner Speed Foundation**
   - Build deterministic ARC runner images with pinned Nix, Bun, uv, Go, Python, `skopeo`, `crane`, `cosign`, `jq`, `yq`, `kustomize`, and repo CI helpers.
   - Nix workflows should validate preinstalled tools and fail on ARC fallback to repeated installer actions.
   - Shared setup action callers running on ARC must set `require-preinstalled: 'true'`; missing Nix or missing CI toolchain commands fail instead of invoking `cachix/install-nix-action` or `nix profile install`.
   - Runner image smoke must execute `toolchain-doctor` and `oci-doctor` inside the built image before a release contract can be emitted.
   - Keep Docker/DinD only while Docker-backed transitional workflows remain.
   - Build the ARC runner image with `dockerTools.buildLayeredImageWithNixDb` from the pinned upstream Actions runner image plus the Nix CI toolchain layer; do not use the Dockerfile/curl installer path.

3. **PR 3: Finish Agents Nix Runtime**
   - Finish and merge the Agents runtime dependency gap.
   - Package `agents-codex-runner` runtime dependencies through Nix.
   - Remove Docker image build paths for enabled Agents service images once the runner image is migrated.
   - Smoke only the root-enabled Agents app.

4. **PR 4: Torghut-Family Nix Migration**
   - Add uv/Nix derivations for `torghut`, `torghut-hyperliquid-feed`, `torghut-hyperliquid-runtime`, and `torghut-options`.
   - Preserve all trading behavior, Pyright gates, health checks, and promotion safety.
   - Start only after live Torghut app health is clean.

5. **PR 5: Dependency Closure Optimization**
   - Split Bun, uv, and Go dependency closures from app source layers.
   - Warm real closures from trusted `main` only.
   - Tune `maxLayers` per service with measured push/build tradeoffs.
   - Add substitute-only `max-jobs = 0` proofs for warmed closures.

6. **PR 6: Docker Quarantine And Removal**
   - Remove Docker Buildx/CLI build-push paths from migrated enabled apps.
   - Rename remaining Docker helpers as Docker-backed transitional paths.
   - Migrate or retire `headlamp-ci.yml`; the live Helm release currently overrides the upstream chart with a repo-built
     `lab/headlamp` image, so it cannot be counted as chart-only.
   - Disabled and non-owned apps cannot count as rollout proof.

7. **PR 7: Final Rollout Report**
   - Record PRs, workflow run IDs, before/after timings, cache-hit counts, output paths, digests, Argo revisions, and smoke outputs.
   - Prove faster warm builds, deterministic rebuilds, digest-pinned releases, and no fake jobs/apps counted.

## Test Plan

- `bun test packages/scripts/src/shared/__tests__/enabled-apps.test.ts packages/scripts/src/shared/__tests__/oci.test.ts packages/scripts/src/shared/__tests__/arc-runner.test.ts`
- `nix flake check --print-build-logs`
- Build each migrated image attr on both required platforms.
- Inspect image archives and pushed registry indexes for OCI media types and `linux/amd64` plus `linux/arm64`.
- Run substitute-only proof with `max-jobs = 0`.
- Rebuild same commit/lockfiles and compare Nix output paths plus OCI digests.
- Smoke every migrated enabled app after release: Argo `Synced Healthy`, live image digest matches the release contract, and the service readiness check passes.

## Acceptance

- No build is added for chart-only, vendor-only, external-source, or disabled apps.
- Every migrated build-owning app works through GitHub Actions and manual deploy scripts.
- Migrated workflows and scripts publish the same OCI digest/platform contract.
- Real Nix OCI workflows emit phase timing and cache provenance.
- Warm cache proof uses real closures and substitute-only validation, not synthetic packages.
- No migrated mandatory workflow regresses by more than 10%.
- Final report proves the measured performance change and reproducibility result.
- No Ceph, Rook, ObjectBucketClaim, PVC, Talos, node, power, or storage changes are included.
