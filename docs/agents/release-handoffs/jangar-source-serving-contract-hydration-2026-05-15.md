# Jangar Source-Serving Contract Hydration Handoff (2026-05-15)

Governing design:

- `docs/agents/designs/205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
- `docs/torghut/design-system/v6/211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`

Runtime requirement:

- Cross-swarm Jangar control-plane run for `codex/swarm-jangar-control-plane`, targeting reduced failed AgentRuns and
  shorter green PR-to-healthy GitOps rollout time.

## Business Evidence

Before implementation, read-only evidence from `http://agents.agents.svc.cluster.local/ready` and
`http://torghut.torghut.svc.cluster.local/trading/revenue-repair` showed:

- `business_state=repair_only`
- `revenue_ready=false`
- top repair queue item `repair_alpha_readiness`
- top repair reason `hypothesis_not_promotion_eligible`
- affected value gate `routeable_candidate_count`
- `execution_trust.status=degraded` because the Jangar verify stage was stale
- Jangar `controller_ingestion_settlement.decision=hold`
- source-serving evidence was still held by missing or unavailable contract evidence on the hot path
- Torghut no-delta reentry stayed denied and `max_notional=0`

After local implementation and validation, the live endpoints were intentionally unchanged because this is a PR-stage
change and has not been deployed. The same read-only checks on 2026-05-15T00:44Z still reported
`business_state=repair_only`, `revenue_ready=false`, top repair `repair_alpha_readiness`, and value gate
`routeable_candidate_count`. The smallest remaining live blocker before rollout is serving the updated Jangar adapter
so the controller-ingestion settlement can hydrate Torghut source-serving contract canaries from the full evidence
payload instead of reporting false missing-contract debt.

## What Changed

- Jangar now falls back from Torghut's compact `/trading/consumer-evidence?view=summary` response to the full
  `/trading/consumer-evidence` payload only when route-warrant source-serving evidence is absent from compact and
  revenue-repair payloads.
- Jangar hydrates `route_warrant_exchange`, `repair_bid_settlement_ledger`, and
  `source_serving_repair_receipt_ledger` from that full payload or the revenue-repair fallback before computing
  observed source-serving contracts.
- Controller-ingestion settlement now evaluates source-serving carry from material action classes
  (`dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready`) instead of treating a zero-notional
  `live_support` block as controller-ingestion source carry failure.
- Tests cover compact-summary contract fallback and the zero-notional live-support case.

## Validation

- `bun install --frozen-lockfile`: passed
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-controller-ingestion-settlement.test.ts src/server/__tests__/control-plane-source-serving-contract-verdict.test.ts`: passed, 28 tests
- `bun run --filter @proompteng/jangar tsc`: passed
- `bun run --filter @proompteng/jangar lint`: passed
- `bun run --filter @proompteng/jangar lint:oxlint`: passed with existing warnings, 0 errors
- `bun run --filter @proompteng/jangar lint:oxlint:type`: passed with existing warnings, 0 errors
- `bun run --filter @proompteng/jangar check:module-sizes`: passed
- `bun run --filter @proompteng/jangar docs:inventory:check`: passed
- `bun run --filter @proompteng/jangar build`: passed
- `git diff --check`: passed

Note: `bun run --filter @proompteng/jangar test -- <files>` runs the package `pretest` with forwarded file arguments
in this workspace and trips `@proompteng/temporal-bun-sdk build` with `TS5042`. The targeted Vitest command above was
used for the actual focused test run.

## Risk And Rollback

Risk:

- The fallback adds one full Torghut consumer-evidence request when compact and revenue-repair payloads do not expose
  route-warrant evidence. It is bounded by the existing Torghut status timeout and keeps the compact path when the
  compact or revenue payload already has the needed contract.
- The controller-ingestion settlement still holds broad work when material source-serving action classes are held or
  blocked; only zero-notional live-support block no longer poisons controller carry.

Rollback:

- Revert the Jangar adapter fallback and material-action source-serving decision change.
- Keep Torghut `max_notional=0`, live submit disabled, and existing source-serving verdict, repair-slot, and
  controller-ingestion settlement gates active.

## Owner Status

This change improves `ready_status_truth`, `manual_intervention_count`, and `handoff_evidence_quality` by removing a
false missing-contract interpretation from Jangar's Torghut evidence adapter. It does not authorize paper or live
capital. The release handoff should verify that the deployed `/ready` and full control-plane status no longer cite
`source_serving_contract_missing:route_warrant_exchange` or
`source_serving_contract_missing:repair_bid_settlement_ledger` when Torghut's full consumer evidence contains those
contracts.
