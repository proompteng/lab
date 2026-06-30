# Enabled-App Nix Build Performance Rollout Plan

## Summary

This rollout treats Nix adoption as build performance and reproducibility work across the root-enabled Argo surface. The source of truth is `argocd/root.yaml`, which points Argo at `argocd/applicationsets`; only apps enabled through those files count as production rollout proof.

The current inventory shape is:

- 71 enabled ApplicationSet entries.
- 1 direct root-managed Application in the same directory: `home-root`.
- 11 migrated `nix-image` apps.
- 25 Helm/chart apps.
- 24 vendor/manifest apps, including manifest-only repo-image references where this checkout does not own the image build.
- 2 external-source apps.
- 10 deferred repo-image apps that need separate service-specific migration work or clean live health first.
- Helm/chart-only and vendor-manifest apps are not image-build migration targets.
- Repo-image apps are only migration candidates after source ownership and a build/deploy path are proven.

Both supported production paths must remain available for each migrated build-owning app:

- GitHub Actions build/release workflows.
- Existing manual deploy scripts such as `bun run <service>:deploy`.

No Ceph, Rook, ObjectBucketClaim, PVC, or storage changes are in scope.

## Key Changes

- Add a root-enabled inventory guardrail that classifies apps as `nix-image`, `helm-chart`, `vendor-manifest`, `external-source`, or `deferred`.
- Keep chart-only apps out of image migration. For Helm apps, optimize reproducible `kustomize build --enable-helm`, schema validation, chart/version pinning, and live smoke only.
- Add a shared Nix OCI contract helper for future migrated services. The helper defines one contract for service name, Nix attr, source SHA, output path, image digest, platforms, cache provenance, timing, and tool versions.
- Keep GitHub Actions and manual deploy scripts on the same contract so a service cannot have one image path in CI and another image path locally.
- Keep Docker available only as an explicit transitional fallback for unmigrated services.

## Rollout Sequence

1. PR 1: inventory/classification, guardrails, timing/cache metrics foundation, contract helper, tests, and docs. No service image migration.
2. PR 2: ARC runner toolchain speedup with pinned Nix, `skopeo`, `crane`, `cosign`, `jq`, `yq`, and `kustomize`. No storage changes.
3. PR 3: migrate clean simple build-owning apps first: `oirat`, `bumba`, and `froussard`.
4. PR 4: migrate enabled frontend/product build-owning apps: `docs`, `app`, `proompteng`, `olden`, and `synthesis`.
5. PR 5+: migrate complex build-owning apps only after service-specific derivations are proven. Completed examples include `symphony` and `sag`; remaining complex candidates include `agents`, `jangar`, and `arc`. `analysis` and `bilig` are manifest-only in this checkout until their owning source/build path is present here, and `autotrader` is a vendor-manifest app without a repo image build.
6. Defer Torghut-family image migration until live app health is clean.

## Test Plan

- Inventory tests prove disabled apps are excluded, `home-root` is represented separately, Helm/chart apps do not receive image-build migration state, and repo-image references are not automatically counted as early proof.
- Contract tests prove migrated services can share the same GitHub Actions and manual deploy metadata without Docker daemon assumptions.
- Workflow tests prove migrated Nix OCI workflows avoid Docker Buildx, `docker load`, `docker run`, and `docker push`.
- Performance proof records runner setup, Nix setup, dependency realization, app build, image assembly, image push, index creation, release PR, and rollout timing.
- Reproducibility proof requires pinned inputs, digest-pinned releases, stable output paths for same inputs, and network-free builds except declared fixed-output fetches/substituters.

## Acceptance

- No build is added for chart-only or vendor-only apps.
- Every migrated build-owning app works through both GitHub Actions and manual deploy script paths.
- Migrated workflows and scripts publish the same OCI digest/platform contract.
- Argo rollout proof is only counted for root-enabled live apps.
- No mandatory workflow regresses by more than 10%; target is at least 25% less repeated setup/dependency time for migrated image builds.
- No Ceph, Rook, ObjectBucketClaim, PVC, or storage changes are included.
