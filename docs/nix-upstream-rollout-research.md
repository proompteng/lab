# Nix Upstream Rollout Research

## Scope

This note records the upstream source read used for the enabled-app Nix rollout. It is intentionally limited to build performance, cache correctness, OCI image determinism, and rollout gates.

Local read-only references:

- `~/github.com/nix`: `NixOS/nix` at `b41781e`.
- `~/github.com/nixpkgs`: `NixOS/nixpkgs` at `975c7c0e`.

No Ceph, Rook, ObjectBucketClaim, PVC, Talos, node, or storage state is part of this rollout.

## Nix Cache Behavior

- Use `substituters = http://attic.attic.svc.cluster.local/lab https://cache.nixos.org/` in ARC Nix image workflows so Attic is tried first and upstream Nix cache remains the fallback.
- Use `extra-trusted-public-keys = $ATTIC_PUBLIC_KEY` for the Attic cache key. The Nix source rejects unsigned substitutes that do not match trusted keys.
- Use `max-jobs = 0` only for substitute-only proofs. The Nix source surfaces this as a no-local-build mode; it should fail if required outputs cannot be substituted.
- Use `builders-use-substitutes = true` later if remote builders are added, so remote builders can pull warmed paths directly instead of receiving every input from the coordinator.

## Post-Build Hook Decision

Do not use synchronous `post-build-hook` for CI cache push.

The Nix manual/source path shows post-build hooks run as part of the build goal. Even the upcoming async work still keeps waiting goals dependent on hook completion. For this repo, cache upload must stay an explicit main-only step after the build completes, using `nix/cache-push.sh` and real output paths. Network slowness or Attic issues must not block unrelated build scheduling through a global hook.

## DockerTools Image Rules

Use `pkgs.dockerTools.buildLayeredImage` or a service-specific derivation around it. Do not emulate Dockerfiles.

Rules from `nixpkgs/pkgs/build-support/docker/default.nix` and examples:

- `created` defaults to a stable timestamp. Do not use `created = "now"`; that selects an impure path and breaks digest reproducibility.
- Layer tar creation uses sorted names and `SOURCE_DATE_EPOCH`, so deterministic inputs can produce deterministic archives.
- Tune `maxLayers` per service. Stable dependency/runtime closures should sit in reusable lower layers, while app source/output should be the smallest changing layer.
- Use `buildLayeredImage` for application images and keep registry push/index creation outside the derivation with `skopeo` and `crane`.

## Determinism Proof

Each migrated enabled repo-owned image must emit or preserve:

- source SHA
- lockfile hashes
- Nix package attr
- Nix output path
- OCI image digest
- platforms
- builder versions
- cache provenance
- phase timings

Same commit plus same lockfiles should reproduce the same Nix output path and OCI digest. Use `nix build --rebuild` where practical for drift checks, and use `max-jobs = 0` for warmed substitute-only proof.

## Performance Gates

Each real migrated image workflow needs phase timings for:

- checkout
- Nix setup
- dependency realization/helper priming
- app image build
- image inspection
- platform push
- OCI index creation
- release contract/PR handoff

Acceptance is correctness first, then speed: no migrated mandatory workflow may regress more than 10%, and warm runs target at least 25% less repeated setup/dependency time.
