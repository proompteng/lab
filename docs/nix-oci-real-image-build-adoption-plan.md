# Real Nix OCI Image Build Adoption

## Summary

This rollout replaces synthetic Nix cache jobs with real image builds. The first live rollout target is Attic because it is already deployed through Argo CD and can prove the full path from Nix derivation to OCI registry to GitOps digest rollout.

Attic accelerates Nix store realization. It does not cache Docker layers. Migrated image workflows must build image tarballs from Nix derivations, push with Skopeo, publish multi-arch OCI indexes with crane, and verify the final registry digest before GitOps promotion.

Public references:

- [Nixpkgs dockerTools](https://nixos.org/manual/nixpkgs/stable/#sec-pkgs-dockerTools)
- [OCI Image Spec](https://github.com/opencontainers/image-spec)
- [Skopeo copy](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md)
- [crane](https://github.com/google/go-containerregistry/tree/main/cmd/crane)
- [Attic](https://docs.attic.rs/tutorial.html)

## Implemented PR Scope

- Remove synthetic jobs: `nix-cache-smoke`, `nix-cache-warm`, and `nix-toolchain`.
- Remove the Docker-backed `oci-native-build-common` workflow and the old benchmark workflow.
- Add Nix image package:
  - `.#atticd-image`
- Add `nix/oci-push.sh`, a daemonless Skopeo push helper that accepts only explicit Nix image tarball paths.
- Add `.github/workflows/nix-oci-build-common.yml` for real multi-arch Nix image builds on ARC runners.
- Migrate the live Attic image workflow off Docker Buildx.
- Add `attic-release` to pin `argocd/applications/attic/deployment.yaml` and `gc-cronjob.yaml` to the built digest.
- Keep release-only manifest PRs from retriggering full image builds.
- Prefer Attic before `cache.nixos.org` for Nix OCI jobs while keeping
  `cache.nixos.org` as fallback.
- Push real OCI helper closures from trusted `main` runs and emit cache/timing
  summaries from the real image workflow.
- Do not migrate disabled or non-live application image workflows in this PR.

## Rollout

1. Merge the implementation PR after local and GitHub checks pass.
2. Wait for `attic-build-push` on `main`.
3. Confirm the workflow produced a release contract whose builder is `nix-dockerTools-skopeo`.
4. Wait for `attic-release` to open the digest promotion PR.
5. Merge the release PR only after the promoted digest passes `assert-oci-platforms` for `linux/amd64` and `linux/arm64`.
6. Let Argo CD roll out Attic normally.

Do not apply cluster resources directly for this rollout. Do not touch Ceph, Rook, ObjectBucketClaims, CNPG clusters, private DNS, or storage configuration.

## Smoke Test

Run after the release PR is merged and Argo reconciles:

```bash
kubectl -n argocd get application attic -o json \
  | jq '{sync:.status.sync.status, health:.status.health.status, revision:.status.sync.revision}'
kubectl -n attic rollout status deploy/attic
kubectl -n attic get deploy attic -o json | jq '.spec.template.spec.containers[].image'
kubectl -n attic run attic-cache-smoke \
  --rm -i \
  --restart=Never \
  --image=curlimages/curl \
  -- curl -fsSL http://attic.attic.svc.cluster.local/lab/nix-cache-info
curl -fsSL https://attic.ide-newton.ts.net/lab/nix-cache-info
```

Pass criteria:

- Attic Argo app is `Synced` and `Healthy`.
- Attic deployment rolls out successfully.
- Attic deployment and GC CronJob reference the Nix-built digest.
- Cache endpoint works from the cluster and from the host.
- Migrated workflows contain no Docker Buildx, `docker load`, `docker run`, `docker tag`, or `docker push`.
- Attic release-only manifest PRs do not retrigger `attic-build-push`.
- The real image workflow summary reports cache-hit counts and phase timings.

## Next Phases

- Build and roll out custom ARC runner images with Nix and base tools preinstalled.
  This is a separate runner-image rollout, not an Attic service or storage change.
- Migrate additional enabled simple static Go services after the Attic rollout proves the full path.
- Migrate Torghut only after its current app health/drift is clean and a uv/Nix packaging path is proven.
- Migrate Bun/Turbo and Headlamp images only after dedicated Nix derivations exist.
- Retire `docker-build-common.yaml` only when every real caller has moved to the Nix OCI builder.
