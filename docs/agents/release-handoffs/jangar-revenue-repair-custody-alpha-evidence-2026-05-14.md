# Jangar revenue-repair custody alpha evidence handoff - 2026-05-14

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane`
Governing designs:

- `docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md`

## Owner update message

I shipped a Jangar ready-truth cleanup in source: revenue-repair custody now understands the current Torghut alpha
evidence shapes instead of treating newer closure-board and executable-alpha receipt evidence as missing. The runtime
decision stays conservative: active no-delta closure-board evidence still denies duplicate `dispatch_repair`, and
Torghut remains zero-notional.

The selected value gates are `ready_status_truth`, `failed_agentrun_rate`, and `handoff_evidence_quality`. The change
reduces false missing-evidence reasons in Jangar status and keeps duplicate no-delta repair launches blocked with the
specific release key and rollback target.

## Runtime evidence

Before local implementation, `GET http://agents.agents.svc.cluster.local/ready` returned:

- `status=ok`
- `business_state=repair_only`
- `revenue_ready=false`
- top queue item `repair_alpha_readiness`
- top queue reason `hypothesis_not_promotion_eligible`
- affected value gate `routeable_candidate_count`
- `execution_trust.status=degraded`
- blocker `jangar-control-plane:verify` consecutive failures
- `material_evidence_settlement_spine.business_truth.selected_value_gate=routeable_candidate_count`
- `material_evidence_settlement_spine.business_truth.max_notional=0`

Full status in the same window still reported revenue-repair custody reasons such as `business_state_missing`,
`revenue_repair_top_item_missing`, and `alpha_readiness_settlement_conveyor_missing` on paths where newer alpha
closure-board or executable-alpha evidence was available. This PR fixes that reducer-level mismatch.

After local implementation, the live deployed service is unchanged until image promotion. A later read still returned
`status=ok`, `business_state=repair_only`, `revenue_ready=false`, top repair `repair_alpha_readiness`, affected value
gate `routeable_candidate_count`, material settlement `decision=hold`, and `max_notional=0`. Execution trust remained
degraded, with current evidence naming stale Jangar verify and Torghut verify consecutive failures. Source-level tests
prove the reducer now classifies executable-alpha receipts as current alpha evidence and closure-board no-delta
evidence as a denial instead of missing evidence.

## What changed

- `buildRevenueRepairSettlementCustody` now resolves alpha settlement evidence from the legacy conveyor, the alpha
  repair closure board, or the selected executable-alpha repair receipt.
- Custody derives `repair_only` from the live queue head when top-level Torghut business fields are absent but the
  queue carries `repair_alpha_readiness`.
- Active closure-board no-delta state now produces a denial with `active_no_delta_lease` and closure-board reason
  codes, not a missing-conveyor hold.
- Regression tests cover queue-only executable-alpha evidence and active no-delta closure-board evidence.

## Validation

- `bun install --frozen-lockfile --ignore-scripts`: pass
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-revenue-repair-settlement-custody.test.ts`:
  pass, 9 tests
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-revenue-repair-settlement-custody.test.ts src/server/__tests__/control-plane-status.test.ts src/routes/ready.test.ts`:
  pass, 57 tests
- `bun run --cwd services/jangar test`: pass, 199 files, 1254 tests
- `bun run --cwd services/jangar check:module-sizes`: pass
- `bun run --cwd services/jangar lint`: pass
- `bunx oxlint --config .oxlintrc.json services/jangar/src/server/control-plane-revenue-repair-settlement-custody.ts services/jangar/src/server/__tests__/control-plane-revenue-repair-settlement-custody.test.ts`:
  pass, 0 warnings and 0 errors
- `bun run --cwd services/jangar lint:oxlint`: pass with existing repository warning-only baseline and 0 errors
- `bun run --cwd services/jangar lint:oxlint:type`: pass with existing repository warning-only baseline and 0 errors
- `bun run --cwd services/jangar tsc`: pass
- `bun run --cwd services/jangar build`: pass
- `bunx oxfmt --check services/jangar/src/server/control-plane-revenue-repair-settlement-custody.ts services/jangar/src/server/__tests__/control-plane-revenue-repair-settlement-custody.test.ts`:
  pass
- `bunx oxfmt --check services/jangar/src/server/control-plane-revenue-repair-settlement-custody.ts services/jangar/src/server/__tests__/control-plane-revenue-repair-settlement-custody.test.ts docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md docs/agents/release-handoffs/jangar-revenue-repair-custody-alpha-evidence-2026-05-14.md`:
  pass
- `git diff --check`: pass

## Risks and rollback

- Risk: `torghut_conveyor_ref` can now hold a closure-board id or executable-alpha receipt id for compatibility with
  existing custody consumers. Mitigation: governing design refs and reason codes identify the source evidence.
- Risk: treating executable-alpha receipts as settlement evidence could look like dispatch approval. Mitigation:
  stage credit, source-serving proof, material gate digest, no-delta state, and zero-notional checks still participate
  in the custody decision.
- Rollback: revert this PR or ignore `revenue_repair_settlement_custody` for alpha closure-board/executable-alpha
  evidence; ready truth, material evidence settlement spine, repair-slot escrow, and Torghut `max_notional=0` remain
  authoritative.

## Deployer proof after rollout

- Confirm Argo `agents` and `jangar` are `Synced/Healthy`.
- Confirm `agents` and `agents-controllers` deployments are ready.
- Confirm `/ready.status=ok`, `business_state=repair_only`, and `revenue_ready=false`.
- Confirm full status no longer reports `business_state_missing` or `alpha_readiness_settlement_conveyor_missing`
  when current alpha closure-board or selected executable-alpha evidence is present.
- Confirm active no-delta closure-board evidence still denies duplicate `dispatch_repair` and keeps capital at
  `max_notional=0`.
