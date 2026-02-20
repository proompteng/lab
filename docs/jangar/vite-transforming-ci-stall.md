# Jangar CI `vite ... transforming...` stall (2026-02-20)

## Incident

- GitHub Actions run: `22211750152`
- Job: `64247366876` (`build-and-push`)
- Start: `2026-02-20T04:50:47Z`
- Canceled: `2026-02-20T09:07:48Z`
- Symptom: build logs stopped at:

```text
vite v7.3.1 building nitro environment for production...
transforming...
```

The step kept running for ~4 hours with no forward progress.

## Why this happens

Upstream reports match this pattern:

- Vite CI builds can appear stuck on `transforming...` when Tailwind processing hits CSS recursion or expensive scanning:
  - `vitejs/vite#20910`
  - `vitejs/vite#15076` and fix `vitejs/vite#15093`
- Tailwind maintainers identified source scanning explosions in CI (for example `.pnpm-store`) and recommend excluding paths with `@source not` or using explicit sources:
  - `tailwindlabs/tailwindcss#18148`
  - Tailwind docs: Detecting classes in source files (`@source`, `@source not`, `source(none)`)

## Production fix applied in this repo

1. Added explicit scan roots in each consumer stylesheet:
   - `services/jangar/src/styles.css`
   - `apps/app/src/styles.css`
   - `apps/landing/src/app/globals.css`
   - `apps/docs/app/global.css`
2. Added explicit scan exclusions (`@source not`) for heavy CI paths (`node_modules`, build output dirs, workspace package stores) in those same stylesheets.
3. Disabled Tailwind auto-discovery at the shared import entrypoint:
   - `packages/design/src/styles/tailwind.css`
   - `@import "tailwindcss" source(none);`
4. Added CI guardrail:
   - `.github/workflows/jangar-build-push.yaml`
   - `timeout-minutes: 20` on the `build-and-push` job

## Why this fix is preferred

- It removes auto-discovery variance between local and containerized CI environments.
- It prevents Tailwind from scanning unrelated filesystem trees.
- It limits blast radius if a future plugin/version regression reappears.
- It keeps normal successful builds unchanged while failing fast instead of hanging for hours.

## Validation checklist

1. Run `bun run --cwd services/jangar build` locally.
2. Confirm classes from Jangar routes render correctly (no missing utilities).
3. Trigger `jangar-build-push` workflow and verify build duration returns to normal range.
4. If a stall reappears, rerun with `DEBUG=*` to capture Tailwind scan diagnostics and compare scanned paths.

## References

- <https://github.com/vitejs/vite/issues/20910>
- <https://github.com/vitejs/vite/issues/15076>
- <https://github.com/vitejs/vite/pull/15093>
- <https://github.com/tailwindlabs/tailwindcss/issues/18148>
- <https://tailwindcss.com/docs/detecting-classes-in-source-files>
