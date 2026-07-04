# Jangar Repair Slot Escrow Handoff (2026-05-14)

Status: Accepted for engineer and deployer handoff
Owner: Jangar Engineering
Related designs:

- `docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`
- `docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`

## Decision

Ship M1 of the receipt-settled repair slot design as a pure read model. Jangar now emits an additive
`jangar.repair-slot-escrow.v1` payload on control-plane status and `/ready`, in observe mode by default, so engineer
and deployer stages can cite one bounded zero-notional `dispatch_repair` slot without thawing normal dispatch,
deployment widening, merge readiness, paper, or live capital actions.

## Runtime Evidence

Before this change, `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`,
`business_state=repair_only`, `revenue_ready=false`, top repair `repair_alpha_readiness`, affected value gate
`routeable_candidate_count`, and execution trust `degraded` because the Jangar `plan` and `verify` stages had
consecutive failures.

The post-validation live business surface is intentionally unchanged until this PR rolls out:
`business_state=repair_only`, `revenue_ready=false`, top repair `repair_alpha_readiness`, affected value gate
`routeable_candidate_count`, Torghut consumer evidence `current`, and no live `/ready.repair_slot_escrow` field yet.

Torghut `/trading/revenue-repair` remained the source of truth for repair priority:

- top queue item: `repair_alpha_readiness`
- reason: `hypothesis_not_promotion_eligible`
- value gate: `routeable_candidate_count`
- required output: `torghut.executable-alpha-receipts.v1`
- selected receipt max notional: `0`
- capital rule: `zero_notional_repair_only`
- revenue ready: `false`

## Shipped Change

Jangar now has typed repair-slot escrow state, a dedicated reducer, status-route wiring, `/ready` exposure, and
coverage for the design acceptance gates. The reducer opens at most one observe-only `dispatch_repair` slot when the
top Torghut repair item is `repair_alpha_readiness`, the selected executable-alpha receipt is fresh and explicitly
zero-notional, material reentry and stage credit agree on the same receipt, evidence pressure has one dispatch budget,
and no matching no-delta debt is active.

The same reducer blocks stale receipts, nonzero or missing notional caps, missing material reentry, missing stage
credit, pressure budget exhaustion, source-ref mismatch, and matching no-delta relaunches. Handoffs include the slot
id, dedupe key, selected Torghut receipt, validation commands, max runtime, max notional `0`, settlement state, and
rollback target.

## Validation

- `bunx oxfmt --check services/jangar/src/server/control-plane-repair-slot-escrow.ts services/jangar/src/server/__tests__/control-plane-repair-slot-escrow.test.ts services/jangar/src/server/control-plane-status-types.ts services/jangar/src/routes/ready.tsx services/jangar/src/routes/ready.test.ts services/jangar/src/server/control-plane-status.ts services/jangar/src/server/control-plane-status-types.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-repair-slot-escrow.test.ts`
- `bun run --cwd services/jangar test -- src/routes/ready.test.ts`
- `bun run --cwd services/jangar check:module-sizes`
- `bun run --cwd services/jangar docs:inventory:check`
- `bun run --cwd services/jangar tsc`
- `bun run --cwd services/jangar lint:oxlint`
- `bun run --cwd services/jangar lint:oxlint:type`
- `bun run --cwd services/jangar build`
- `bun run --cwd services/jangar test`
- `git diff --check`

## Risk And Rollback

Risk is limited to additive status output. The PR does not create AgentRuns, mutate swarms, relax capital gates, enable
live submission, or widen deployment/merge admission. The `/ready` hot path intentionally emits a blocked escrow when
full status evidence such as material reentry or stage credit is not present locally.

Rollback is to set `JANGAR_REPAIR_SLOT_ESCROW_MODE=observe`, then set
`JANGAR_REPAIR_SLOT_ESCROW_ENABLED=false` if payload generation itself regresses. Keep Torghut max notional at `0`,
keep live submission disabled, and do not delete receipts, AgentRuns, jobs, or no-delta evidence.

## Next Action

After merge and GitOps rollout, verify Argo, workload readiness, `/ready.repair_slot_escrow`, full control-plane
status `.repair_slot_escrow`, and Torghut `/trading/revenue-repair`. The control-plane metric improved is
`failed_agentrun_rate`; the smallest remaining business blocker is still `routeable_candidate_count` until a selected
zero-notional repair produces settlement evidence that retires the current alpha-readiness blocker.
