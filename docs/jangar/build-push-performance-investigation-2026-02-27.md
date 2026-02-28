# Jangar `jangar-build-push` Performance Investigation (2026-02-27)

## Objective

- User target: production-grade build performance; current runtime around 7 minutes is too slow.
- Scope: identify real bottlenecks in current pipeline (not theory), test optimizations empirically, and keep an audit trail of each experiment.

## Baseline Inputs

- Workflow: `.github/workflows/jangar-build-push.yaml`
- Build stack: `TanStack Start + Vite + Nitro` inside Docker Buildx on ARC arm64 runners.
- Existing prior investigation: `docs/jangar/build-push-performance-investigation-2026-02-23.md`

## Initial Observations (Repo State)

- Build job performs two sequential image builds:
  - `Build and push jangar image`
  - `Build and push jangar control-plane image`
- Compile path is `TanStack Start (client + ssr + nitro)` within Docker target `jangar-build 6/6`.
- Control-plane build usually reuses the compile cache; it still pays image export/push cost.

## Experiment Log

### E0: Re-validate historical `cache mode=max` claim

Status: Complete

- Confirmed from git history and prior run documentation that `cache mode=max` increased total runtime due cache export overhead.
- Evidence:
  - commit `9854d227` and documentation in `docs/jangar/build-push-performance-investigation-2026-02-23.md`
  - run references in that doc show `max` slower overall than `min` despite better reuse on one stage.

### E1: Dagger vs Docker buildx empirical benchmark (cluster)

Status: Complete

- Attempted benchmark in `default` namespace first (as requested).
- `default` policy prevented privileged dind; rootless dind also failed due `user.max_user_namespaces` constraint.
- Benchmarks were run in `arc` namespace (same cluster, privileged PodSecurity).

Raw timing summary:

- Docker buildx, cold, no output (`--load/--push` omitted): `282s`
- Dagger, cold, materialized via `dockerBuild -> file(...).contents`: `317s`
- Docker buildx, cold, `--load`: `584s`

Interpretation:

- On comparable non-exporting builds, Dagger did **not** outperform Docker buildx in this environment (about 12% slower in this sample).
- A large fraction of slow runs is output/export overhead (`--load` path adds significant time), separate from Vite/Nitro compile cost.

### E2: Current production runs decomposition (GitHub Actions, 2026-02-27)

Status: Complete

Latest 5 successful `jangar-build-push` runs:

- `22505380198`: total `11m09s` (step8 `445s`, step9 `137s`)
- `22503219243`: total `7m42s` (step8 `282s`, step9 `80s`)
- `22502446656`: total `10m15s` (step8 `423s`, step9 `115s`)
- `22476510815`: total `7m12s` (step8 `288s`, step9 `74s`)
- `22469488792`: total `6m57s` (step8 `272s`, step9 `82s`)

BuildKit phase extraction (representative runs):

- Slow run `22505380198`
  - `jangar-build 6/6` (compile): `245.5s`
  - runtime image export/push: `86.8s` (`74.0s` export + `11.4s` push)
  - control-plane image export/push: `80.6s` (`69.6s` export + `9.7s` push)
- Faster run `22503219243`
  - `jangar-build 6/6` (compile): `144.3s`
  - runtime image export/push: `49.8s` (`35.4s` export + `12.8s` push)
  - control-plane image export/push: `49.0s` (`35.9s` export + `11.7s` push)

Finding:

- Build time is dominated by two buckets:
  - `Vite/Nitro compile` in `jangar-build 6/6` (high variance)
  - `image export/push` for both targets
- This is not a “TanStack Start only” issue; export/push regularly accounts for ~100–170s on its own.

### E3: TanStack route ignore cleanup impact

Status: Complete

Change tested:

- Renamed route-adjacent test file:
  - `services/jangar/src/routes/library/whitepapers/search.test.tsx`
  - -> `services/jangar/src/routes/library/whitepapers/-search.test.tsx`

Local timed build comparison (`CI=true`, `JANGAR_BUILD_MINIFY=0`, `JANGAR_BUILD_SOURCEMAP=0`):

- Before rename: `real 58.02s`
- After rename: `real 57.43s`

Finding:

- Improvement is minor (~`0.59s`, ~1%) but removes noisy route warning and avoids accidental route scanning drift.

### E4: Prebuilt `.output` vs in-Docker compile (controlled benchmark)

Status: Complete

Method:

- Same builder (`docker-container`), same target (`runtime`), same args, same `--no-cache-filter jangar-build`.
- Compared Docker phase with and without prebuilt `services/jangar/.output` copied into pruned context.

Results:

- No prebuilt `.output`:
  - Docker phase wall time: `89.61s`
  - `jangar-build 6/6`: `68.3s`
- Prebuilt `.output` in context:
  - Docker phase wall time: `21.14s`
  - `jangar-build 6/6`: skipped (`0s` for compile step)

Finding:

- Skipping in-Docker compile cuts the Docker runtime-target phase by ~`76%` in this controlled test.
- Accounting for host prebuild (~`57s` local), total path is still better than in-Docker compile in this sample.
- In CI, where `jangar-build 6/6` has been `144–245s`, this optimization has higher headroom.

### E5: Workflow changes applied in this branch

Status: Complete

1. Added explicit prebuild step against the pruned context:
   - runs `bun install` in `$PRUNE_DIR` for required workspaces
   - runs `bun --cwd "$PRUNE_DIR/full/services/jangar" --bun vite build --logLevel warn`
   - runs `bun --cwd "$PRUNE_DIR/full/services/jangar" run copy:grpc-proto`
   - wraps Vite prebuild with `timeout 20m` to fail fast on rare transform stalls.
2. Prebuilt `.output` now remains in the pruned context directly (no copy from repository workspace needed).
3. Removed remote cache export/import env from control-plane build step (it can reuse local builder cache from prior step in the same job).
4. Renamed unignored route test file to `-search.test.tsx`.

### E6: CI validation adjustment (workflow-dispatch on PR branch)

Status: In progress

- First validation run (`22511412766`) showed the original prebuild implementation (running from full repo context) taking unexpectedly long in CI.
- Workflow was adjusted to prebuild from the pruned context instead, then rerun.

## Internet Research (Primary Sources)

- Vite performance guidance: <https://main.vitejs.dev/guide/performance.html>
- TanStack file-based routing ignore controls (`routeFileIgnorePrefix`, `routeFileIgnorePattern`): <https://tanstack.com/router/latest/docs/framework/react/start/file-based-routing>
- Docker build cache backends (`min` vs `max` behavior and tradeoffs): <https://docs.docker.com/build/cache/backends/>
- Docker cache optimization patterns (cache mounts, layer strategy): <https://docs.docker.com/build/cache/optimize/>

## Next Validation

- Trigger `jangar-build-push` on this branch and compare against the five-run baseline above.
- Confirm:
  - step8 decrease from baseline band (`272–445s`)
  - step9 decrease from baseline band (`74–137s`)
  - no regressions in runtime startup (`.output` completeness, including copied proto).
