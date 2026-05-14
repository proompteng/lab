# Jangar Revenue-Repair Settlement Custody Handoff (2026-05-14)

Governing design:
`docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`.
Producer contract:
`docs/torghut/design-system/v6/205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`.

## Runtime Evidence

Before this change, `GET http://agents.agents.svc.cluster.local/ready` returned `business_state=repair_only`,
`revenue_ready=false`, top repair `repair_alpha_readiness`, affected value gate `routeable_candidate_count`, and
`max_notional=0`.

After local validation, the live business state is still intentionally repair-only until this PR rolls out:
`business_state=repair_only`, `revenue_ready=false`, top repair `repair_alpha_readiness`, affected value gate
`routeable_candidate_count`, and `routeable_candidate_count=0`.

Torghut is now emitting the compact producer ref on
`GET http://torghut.torghut.svc.cluster.local/trading/consumer-evidence`:

- schema: `torghut.alpha-readiness-settlement-conveyor-ref.v1`
- status: `no_delta`
- selected hypothesis: `H-MICRO-01`
- selected value gate: `routeable_candidate_count`
- active no-delta leases: `3`
- repeat launch decision: `deny`
- max notional: `0`

## Shipped Change

Jangar now parses the compact Torghut conveyor ref and emits
`jangar.revenue-repair-settlement-custody.v1` as an additive status object. Ready truth carries the custody ref,
decision, and reasons, and `dispatch_repair` is held or blocked from this custody decision without changing
`serve_readonly` or `torghut_observe`.

The custody reducer allows a current zero-notional alpha-readiness conveyor, holds missing refs, stage-health debt, and
incomplete rollout proof, and denies stale refs, nonzero notional, non-alpha top repair, non-`repair_only` business
state, or unchanged active no-delta leases.

## Validation

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-revenue-repair-settlement-custody.test.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-ready-truth-arbiter.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-authority-provenance-settlement.test.ts src/server/__tests__/control-plane-material-reentry-clearinghouse.test.ts src/server/__tests__/control-plane-rollout-proof-passport.test.ts`
- `bun run --cwd services/jangar tsc`
- `bun run --cwd services/jangar lint`
- `bunx oxlint --config ../../.oxlintrc.json <touched files>`
- `bunx oxlint --config ../../.oxlintrc.json --type-aware --tsconfig ./tsconfig.oxlint.json <touched files>`

Full Jangar Oxlint and type-aware Oxlint currently exit `0` with existing warnings outside this change. The touched
files are clean.

## Risk And Rollback

Risk is limited to additive status output and ready-truth dispatch repair classification. The reducer does not create
AgentRuns, mutate swarms, edit Kubernetes resources, relax paper/live capital gates, or enable live submission.

Rollback is to revert the Jangar PR or run with `JANGAR_REVENUE_REPAIR_SETTLEMENT_CUSTODY_MODE=observe`, ignore the
custody fields, and keep Torghut `max_notional=0`. Existing ready truth, stage credit, repair-bid admission, and
consumer evidence leases remain in place.
