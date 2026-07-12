# Jangar Controller-Ingestion Settlement Release Handoff

## Design And Requirement Provenance

- Governing design:
  `docs/agents/designs/205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
- Companion Torghut contract:
  `docs/torghut/design-system/v6/211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
- Runtime requirement: implement stages must cite the governing requirement, ship production PRs with tests, and hand
  off the metric improved or the smallest blocker preventing improvement.

## What Shipped

This change adds the observe-mode `controller_ingestion_settlement` status projection to the Jangar control plane. The
projection joins controller witness quorum, AgentRun ingestion, database health, rollout health, execution trust,
source-serving verdicts, verify-trust foreclosure, repair-slot escrow, and Torghut no-delta carry evidence into one
decision:

- `allow` when controller ingestion, source-serving, verify-carry, database, rollout, execution trust, and notional
  evidence agree;
- `repair_only` with one zero-notional `controller_ingestion` ticket when AgentRun ingestion is the only missing
  witness;
- `hold` when source-to-live carry is missing, Torghut reports Jangar carry unavailable, or broad work would not repair
  the missing proof;
- `block` for contradictory carry evidence, blocked execution trust, controller witness block, or nonzero notional.

The first rollout is read-model only. No scheduler enforcement, database migration, paper submit, live submit, or
notional behavior changes are included.

## Business Evidence

Before code changes, `GET http://agents.agents.svc.cluster.local/ready` at 2026-05-14T17:03Z showed:

- `business_state=repair_only`
- `revenue_ready=false`
- top repair `repair_alpha_readiness`
- reason `hypothesis_not_promotion_eligible`
- value gate `routeable_candidate_count`
- required receipt `torghut.executable-alpha-receipts.v1`
- `max_notional=0`
- `execution_trust=healthy`

After implementation validation, the same endpoint at 2026-05-14T17:29Z still showed:

- `business_state=repair_only`
- `revenue_ready=false`
- top repair `repair_alpha_readiness`
- value gate `routeable_candidate_count`
- `max_notional=0`
- `execution_trust=degraded`

Torghut `/trading/revenue-repair` at 2026-05-14T17:29Z showed no-delta reentry denied with
`jangar_verification_carry_unavailable`, `routeable_candidate_count_before=0`, `routeable_candidate_count_after=0`,
`measured_delta=0`, and `max_notional=0`. The value gate targeted by this PR is `handoff_evidence_quality` with
supporting impact on `manual_intervention_count` and `ready_status_truth`; live revenue movement remains blocked until
the settlement is deployed and Torghut can import current Jangar carry.

## Validation

- `cd services/jangar && bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-controller-ingestion-settlement.test.ts src/server/__tests__/control-plane-status.test.ts`:
  pass, 2 files and 38 tests.
- `bun run --filter @proompteng/jangar lint`: pass.
- `bun run --filter @proompteng/jangar lint:oxlint`: pass with existing repository warnings, 0 errors.
- `bun run --filter @proompteng/jangar lint:oxlint:type`: pass with existing repository warnings, 0 errors.
- `bun run --filter @proompteng/jangar tsc`: pass.
- `bun run --filter @proompteng/jangar test`: pass, 196 files and 1236 tests.
- `bunx oxfmt --check services/jangar packages/scripts/src/jangar argocd/applications/jangar`: pass.
- `cd services/jangar && bun run test && bunx tsc --noEmit --project tsconfig.paths.json && bun run docs:inventory:check && bun run check:module-sizes`:
  pass.
- `bun run --cwd services/jangar build`: pass.
- `git diff --check`: pass.

## Risk And Rollback

- Risk: false holds could reduce useful repair throughput once consumers adopt the field. Current mitigation is
  observe-mode only; no launcher consumes this field in this PR.
- Risk: Torghut companion import may lag this source change. Missing or unavailable carry is classified as `hold`, not
  `allow`, and all selected repair tickets keep `max_notional=0`.
- Rollback: revert the PR or ignore `controller_ingestion_settlement` consumers. Existing ready truth, stage credit,
  source-serving verdicts, verify-trust foreclosure, material gate digest, and Torghut no-delta/max-notional guards
  remain authoritative.

## Owner-Facing Status

Ready for source review once CI is green. The smallest live blocker remains `jangar_verification_carry_unavailable`
with `routeable_candidate_count=0`; this PR gives deployers and the Torghut companion import a compact Jangar
settlement to prove whether the next repair is controller ingestion, source-to-live carry, or a true contradiction.
