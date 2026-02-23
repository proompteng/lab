# Jangar `jangar-build-push` Performance Investigation (2026-02-23)

## Scope

- Workflow: `.github/workflows/jangar-build-push.yaml`
- Primary complaint: end-to-end job frequently around 12 minutes; Nitro phase perceived as slow
- Objective: identify root cause with traces (not guesses), apply production-safe optimizations, and verify in CI

## Quick Answers

- `Turbopack` does not help here. This pipeline builds Jangar with `Vite + Nitro`, not Next.js/Turbopack.
- The slow compile section was mostly `CPU-bound` (Rollup + Nitro externals tracing).
- The long tail after compile is mostly `registry/image export + cache export` (IO/network bound).

## Baseline and Validation Runs

| Run | Context | Step 8 (`jangar`) | Step 9 (`control-plane`) | Notes |
| --- | --- | --- | --- | --- |
| `22287978059` | `main` baseline before this investigation | `4m59s` | `45s` | `jangar-build 6/6` was `165.8s` |
| `22288615602` | branch validation with `cache mode=max` | `5m46s` | `1m48s` | `jangar-build 6/6` improved to `139.6s`, but cache export cost was very high |
| `22288801350` | branch validation after reverting to `cache mode=min` | `3m33s` | `2m26s` | final validated config and successful run |

References:
- <https://github.com/proompteng/lab/actions/runs/22287978059>
- <https://github.com/proompteng/lab/actions/runs/22288615602>
- <https://github.com/proompteng/lab/actions/runs/22288801350>

## Investigation Method

### Local traced builds

Executed local profiled builds from `services/jangar` with:

- wall/user/system timing (`/usr/bin/time -l`)
- Vite/Nitro debug phase logs
- Bun CPU profiles (`--cpu-prof --cpu-prof-md`)

Representative command:

```bash
cd services/jangar
CI=true JANGAR_BUILD_MINIFY=0 JANGAR_BUILD_SOURCEMAP=0 bun --bun vite build --logLevel info
```

### CI log forensics

- Pulled full BuildKit logs for the workflow runs above
- Compared:
  - `jangar-build 6/6` duration
  - Nitro generation timestamps
  - image export/push timings
  - cache export timings (`mode=min` vs `mode=max`)

## Root Cause

### 1) Nitro externals tracing was expensive and CPU-heavy

The Bun CPU profile before optimization showed hot time in `nf3`/`@vercel/nft`/`acorn` code paths (Node file tracing + parse/bind work), alongside Rollup AST work.

Local before/after:

- Before:
  - client: `9.26s`
  - ssr: `11.87s`
  - nitro: `46.17s`
  - total: `69.18s`
- After disabling tracing:
  - client: `8.09s`
  - ssr: `11.06s`
  - nitro: `34.41s`
  - total: `59.75s`

### 2) `cache mode=max` increased overall CI time despite better reuse

`mode=max` exported a large cache payload and added significant overhead in this workflow (for example ~`83.5s` cache export on run `22288615602`), so it was reverted to `mode=min`.

### 3) Remaining tail is mostly artifact/image movement

Even when compile improved, large `exporting layers` and registry operations dominated parts of step 8/9, especially for control-plane image pushes.

## Production Changes Applied

### A) Disable Nitro node_modules tracing for container builds

File:

- `services/jangar/nitro.config.ts`

Change:

- Set `externals.noTrace = true`

Why safe:

- Runtime images already copy `/app/node_modules` from deps stage.
- We are not relying on Nitro to produce a tree-shaken standalone node_modules payload.

### B) Add regression test for this config

File:

- `services/jangar/src/server/__tests__/nitro-config.test.ts`

Change:

- Assert `nitroConfig.externals?.noTrace === true`

### C) Keep shared cache ref, but use `mode=min`

File:

- `.github/workflows/jangar-build-push.yaml`

Change:

- Use shared `JANGAR_BUILD_CACHE_REF` for both image build steps
- Keep `JANGAR_BUILD_CACHE_MODE=min` (not `max`)

## Additional Context (Runner/Cluster tuning)

Separate but related changes in branch history (already part of this optimization stream):

- `argocd/applications/arc/application.yaml`:
  - kept `maxRunners: 5`
  - increased dind CPU/memory requests/limits
  - set Docker daemon `--max-concurrent-uploads=8`

These target push throughput and runner stability under load.

## Verification Performed

1. Local unit test:

```bash
bun --bun vitest run src/server/__tests__/nitro-config.test.ts
```

2. Local lint:

```bash
bunx biome check services/jangar/nitro.config.ts services/jangar/src/server/__tests__/nitro-config.test.ts
```

3. Local runtime smoke (built output and container targets) to ensure no module-resolution regressions.

4. End-to-end CI validation on branch:
   - run `22288615602` (success, used to measure `mode=max` tradeoff)
   - run `22288801350` (success, final config)

## Conclusion

- The main Nitro compile slowdown was real and was traced to expensive externals tracing work.
- Disabling Nitro trace in this containerized build path is a safe, production-grade optimization with measurable build-time improvements.
- Cache strategy needed balancing: shared cache ref is useful, but `mode=max` was not worth its export overhead for this pipeline; `mode=min` is the final setting.
