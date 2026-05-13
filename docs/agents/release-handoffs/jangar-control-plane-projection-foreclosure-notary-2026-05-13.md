# Jangar Control Plane Projection Foreclosure Notary Handoff (2026-05-13)

## Design And Requirement Provenance

- Governing design: `docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md`
- Runtime requirement signal: current swarm implement stage held by `evidence_clock_custody_blocked`,
  `route_stability_hold`, `source_rollout_truth_hold`, and required repair action `settle Torghut stage-custody hold`.
- Business metric: reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time for the Jangar control
  plane.
- Value gates: `ready_status_truth`, `failed_agentrun_rate`, `manual_intervention_count`,
  `handoff_evidence_quality`.

## What Shipped

- Added `projection_foreclosure_notary` to the Jangar control-plane status contract.
- Added a read-only reducer that classifies stale AgentRun projections, market-context active rows, source-rollout
  truth, stage-clearance packets, and Torghut route-custody receipts.
- Preserved stale rows as audit-visible `stale_foreclosed` claims instead of mutating database or Kubernetes state.
- Represented missing Torghut custody receipts as `missing_receipt` with required
  `torghut.execution-tca-refresh-receipt.v1` and `torghut.market-context-freshness-receipt.v1` repair receipts.
- Wired stage credit and ready truth to consume the notary only when `JANGAR_PROJECTION_FORECLOSURE_CONSUME=true`.

## Validation

- `bun run --filter @proompteng/jangar pretest` passed.
- `bun run --filter @proompteng/jangar test` passed on rerun: 188 files, 1170 tests. First full-suite attempt hit a
  10s timeout in `src/routes/ready.test.ts`; the test passed alone and the full suite passed on rerun.
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-projection-foreclosure-notary.test.ts src/server/__tests__/control-plane-stage-credit-ledger.test.ts src/server/__tests__/control-plane-ready-truth-arbiter.test.ts src/server/__tests__/control-plane-authority-provenance-settlement.test.ts src/server/__tests__/control-plane-status.test.ts` passed: 5 files, 49 tests.
- `bun run --filter @proompteng/jangar tsc` passed.
- `bun run --filter @proompteng/jangar lint` passed.
- `bun run --filter @proompteng/jangar lint:oxlint` passed with pre-existing warnings and 0 errors.

## Risk And Rollback

- Risk: a legitimate long-running AgentRun could look stale if it cannot be matched to live Kubernetes authority.
  Mitigation: the classifier uses the larger of requested timeout, schedule interval, and a six-hour default before
  stale foreclosure.
- Risk: status consumers may read `stale_foreclosed` as cleanup. Mitigation: the notary preserves projection refs and
  foreclosure receipts and does not delete or rewrite source rows.
- Risk: Torghut route custody becomes stricter when consumption is enabled. Mitigation: default rollout is
  visibility-only; missing receipts keep max notional at zero and allow only repair-mode reasoning.
- Rollback: set `JANGAR_PROJECTION_FORECLOSURE_CONSUME=false` to disable consumer impact. Set
  `JANGAR_PROJECTION_FORECLOSURE_NOTARY_ENABLED=false` to remove the status payload if it destabilizes the route.

## Owner-Facing Status

The implementation improves ready-status truth and handoff evidence quality by separating stale projection authority
from live service health. The PR is intended to be merge-ready after CI proves the same TypeScript, formatting, lint,
and unit-test gates.
