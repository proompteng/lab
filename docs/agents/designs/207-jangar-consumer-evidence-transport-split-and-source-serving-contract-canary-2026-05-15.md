# 207. Jangar Consumer-Evidence Transport Split And Source-Serving Contract Canary (2026-05-15)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-15
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane evidence transport, source-serving contract canaries, controller-ingestion settlement,
Torghut no-delta alpha reentry, rollout evidence, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/213-torghut-consumer-evidence-contract-canary-and-alpha-reentry-transport-2026-05-15.md`

Extends:

- `206-jangar-route-adjacent-proof-custody-and-torghut-reentry-admission-2026-05-14.md`
- `206-jangar-consumer-evidence-parity-settlement-and-alpha-release-custody-2026-05-14.md`
- `205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
- `187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`

## Decision

I am selecting **a split consumer-evidence transport with source-serving contract canaries** as the next Jangar
control-plane architecture slice.

The live blocker is no longer simply "route proof missing." The evidence is sharper. Torghut's full
`/trading/consumer-evidence` payload contains `route_warrant_exchange` and `repair_bid_settlement_ledger`, but the
compact `?view=summary` payload intentionally omits both. Jangar currently rewrites the configured
`JANGAR_TORGHUT_STATUS_URL` from `/trading/consumer-evidence` to `/trading/consumer-evidence?view=summary` before it
normalizes Torghut evidence. That keeps the hot payload small, but it makes the source-serving contract verifier see
`source_serving_contract_missing:route_warrant_exchange` and
`source_serving_contract_missing:repair_bid_settlement_ledger` even while the full Torghut payload has those contracts.

Jangar should not solve this by making every hot-path readiness read pull the full Torghut evidence document. The full
payload is the correct authority for contract shape, but the summary route is the correct authority for cheap service
health and consumer-evidence freshness. The new contract splits those roles. Jangar keeps the summary fetch for hot
readiness, adds a bounded contract-canary fetch for full evidence only where source-serving and controller-ingestion
settlement need it, and records the transport decision as a first-class custody object. Torghut, in the companion
contract, publishes compact contract refs in the summary route so Jangar can stay correct even when the full fetch is
slow or rate-limited.

The tradeoff is another evidence layer. I accept that because the current alternative is worse: Jangar can mark a
healthy, source-bound Torghut payload as contract-missing and keep no-delta alpha reentry denied for a transport
artifact rather than a trading blocker. This design reduces a control-plane false negative without weakening capital
safety. Paper and live support remain held until routeable candidates, source-serving proof, and capital gates all
pass.

## Governing Runtime Requirements

This contract is a governing Jangar requirement for the next implementation stage:

- every code-changing run must cite this doc or the companion Torghut doc before changing Jangar or Torghut evidence
  transport;
- implementation PRs must improve readiness, profit evidence, data freshness, execution quality, or capital safety;
- verification must merge only green PRs and prove image promotion, Argo sync, live service health, and Torghut revenue
  or evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `ready_status_truth`: summary evidence remains the hot readiness input; contract evidence becomes a separate
  bounded lane.
- `pr_to_rollout_latency`: source, manifest, serving image, contract refs, and Argo sync are joined in one source-serving
  verdict.
- `handoff_evidence_quality`: handoffs cite whether a hold comes from transport, missing contract, stale contract, or
  real Torghut proof.
- `manual_intervention_count`: operators stop comparing summary payloads, full payloads, revenue-repair, and Jangar
  status by hand.
- `routeable_candidate_count`: Torghut no-delta H-MICRO-01 reentry can only proceed after contract canaries remove the
  false source-serving hold.
- `zero_notional_or_stale_evidence_rate`: stale or missing contract canaries keep zero-notional repair debt explicit.
- `capital_gate_safety`: all selected repairs remain `max_notional=0`; live support is still blocked unless capital
  gates release independently.

## Current Evidence

Evidence was collected read-only on 2026-05-15 between 00:26Z and 00:30Z. I did not mutate Kubernetes resources,
database records, AgentRuns, GitOps state, broker state, market data, or trading flags.

### Cluster And Rollout

- The working branch is `codex/swarm-torghut-quant-plan` based on `main` at
  `ff98e82146135c9a592eee4c3676da47c2e83477`.
- Argo reported `jangar` and `torghut` as `Synced/Healthy` at
  `ff98e82146135c9a592eee4c3676da47c2e83477`. `agents` was `Healthy/OutOfSync`; the out-of-sync resources were the
  `agents` and `agents-controllers` Deployments.
- The live `agents-controllers` Deployment itself had `2/2` available replicas, observed generation `339`, and image
  `registry.ide-newton.ts.net/lab/jangar:4947b00e@sha256:03bcb2e644758aa745117dd70e94293c4c11ff64b64febc098a87727a2aad44b`.
- Torghut live revision `torghut-00433` and sim revision `torghut-sim-00518` were running with `2/2` containers ready.
  Options catalog, options enricher, TA, websocket, ClickHouse, and guardrail exporters were running.
- Recent Torghut events showed a successful rollout followed by execution TCA refresh jobs every five minutes. One
  refresh job exceeded its active deadline, then later refresh jobs completed. This is a reliability signal, not a
  capital-release signal.
- Recent agents namespace AgentRuns included successful implement and discover runs, failed verify runs, and current
  running plan/verify runs. This supports bounded repair dispatch, not broad normal dispatch.

### Jangar Control-Plane Evidence

- Jangar `/ready` returned `status=ok`, leader election healthy, and `execution_trust.status=healthy`, but its hot-path
  `controller_ingestion_settlement.decision=hold` cited controller deployment, self-report, source-serving, rollout,
  and database projection reasons.
- Jangar full control-plane status at `2026-05-15T00:28:34.090Z` reported a clearer picture:
  - `database.status=healthy`, `registered_count=29`, `applied_count=29`, latest applied migration
    `20260508_torghut_quant_pipeline_health_account_window_created_at_index`;
  - `rollout_health.status=healthy`, two configured deployments healthy;
  - `control_plane_controller_witness.decision=allow_with_split`, with controller heartbeat authoritative while the
    serving process is not the controller;
  - `agentrun_ingestion.status=unknown`, message `agents controller not started`;
  - `source_serving_contract_verdict_exchange.status=block`, missing `route_warrant_exchange` and
    `repair_bid_settlement_ledger`;
  - `controller_ingestion_settlement.decision=hold`, reasons including `source_serving_block`,
    `torghut_route_warrant_missing`, `repair_bid_settlement_ledger_missing`, and `torghut_verification_carry_stale`;
  - `material_evidence_settlement_spine.decision=hold`, with Torghut evidence and transport unavailable reasons.
- The difference between `/ready` and full status is itself a design signal. Jangar needs separate hot summary,
  contract-canary, and full-status authorities instead of collapsing every failure into controller-ingestion lag.

### Torghut Business Evidence

- `/trading/revenue-repair` returned `schema_version=torghut.revenue-repair-digest.v1`, `business_state=repair_only`,
  and `revenue_ready=false`.
- The top repair queue item was `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, value gate
  `routeable_candidate_count`, required output `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- Torghut `jangar_controller_ingestion_carry.carry_state=lagging` with reasons including
  `source_serving_contract_unavailable_on_ready_hot_path`, `rollout_health_unknown`, and
  `jangar_controller_ingestion_lagging` on the hot read; later full Jangar status narrowed the cause to source-serving
  contract transport.
- Torghut `no_delta_repair_reentry_auction.reentry_decision=deny`, selected no ticket, preserved H-MICRO-01, and kept
  `max_notional=0`.
- `/trading/consumer-evidence?view=summary` returned a current consumer evidence receipt and a current route-proven
  profit receipt, but `has_route_warrant=false` and `has_repair_bid=false`.
- Full `/trading/consumer-evidence` returned `has_route_warrant=true` with
  `route_warrant_id=route-warrant-exchange:989878b5ceeabaa4e08f` and `has_repair_bid=true` with
  `repair_bid_ledger_id=repair-bid-settlement-ledger:db2cfac92bf7ccfe808c`.
- `/trading/revenue-repair` carried `repair_bid_settlement_ledger` but not `route_warrant_exchange`. It is useful as a
  business queue and repair-bid fallback, not as the complete source-serving contract authority.

### Database And Data Evidence

- Torghut `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- Jangar full status reported its database connected and migration-consistent.
- Direct CNPG cluster reads were blocked by RBAC:
  `clusters.postgresql.cnpg.io is forbidden` for `system:serviceaccount:agents:agents-sa`.
- Direct Postgres exec into `torghut-db-1` was blocked by RBAC:
  `pods/exec` forbidden for the same service account.
- This is the correct access boundary for this lane. Jangar should consume typed service evidence and contract canaries,
  not direct database reads.

### Source And Test Surface

- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts` rewrites
  `/trading/consumer-evidence` to `/trading/consumer-evidence?view=summary` through `compactConsumerEvidenceEndpoint`.
- `services/jangar/src/server/control-plane-source-serving-contract-verdict.ts` requires
  `route_warrant_exchange` and `repair_bid_settlement_ledger` in `observed_contracts`, and holds dispatch repair when
  either is missing.
- `services/torghut/app/main.py` already builds both contracts in the full consumer-evidence path, but the summary path
  returns only the receipt, route-proven receipt, proof floor, and coarse status.
- Existing tests cover source-serving missing-contract behavior and Torghut full/summary consumer evidence shape. The
  missing regression family is the transport split: summary current with full contracts present must not be classified
  as source-serving contract missing, and summary current with full contracts unavailable must become a transport hold
  rather than a false contract absence.

## Problem

Jangar is conflating three different facts:

1. The cheap Torghut summary route is current.
2. The full Torghut contract payload has source-serving contracts.
3. Jangar is allowed to use those contracts for material action decisions.

When those facts are collapsed, a transport optimization becomes a source-serving blocker. That has three production
risks:

- false holds: Jangar blocks repair dispatch even though Torghut already produced the required contracts;
- false confidence: a future summary may claim freshness while the full contract payload is stale or schema-mismatched;
- noisy handoffs: deployers see controller-ingestion lag when the actual blocker is contract transport authority.

The architecture must keep summary evidence cheap, make full contract evidence authoritative, and keep capital locked
unless both agree.

## Alternatives Considered

### Option A: Configure Jangar To Read Full Consumer Evidence Everywhere

Jangar would stop rewriting the Torghut status URL and would always fetch full `/trading/consumer-evidence`.

Advantages:

- Small code change.
- Uses the canonical Torghut payload directly.
- Immediately exposes route warrant and repair-bid contracts.

Disadvantages:

- Makes the hot control-plane path depend on the largest Torghut payload.
- Increases latency and failure blast radius for `/ready` and status refresh.
- Does not distinguish transport failure from true contract absence.
- Makes it harder to keep service health separate from material trading proof.

Decision: reject as the primary architecture.

### Option B: Put Every Required Contract Into The Summary Payload

Torghut would expand `?view=summary` until it contains every source-serving contract Jangar may need.

Advantages:

- Keeps Jangar to one Torghut fetch.
- Moves contract ownership close to the producer.
- Reduces status resolver complexity.

Disadvantages:

- The summary route stops being a summary.
- Every new material contract risks growing the hot payload.
- Jangar still lacks a clear record of whether it used summary, full, or fallback authority.

Decision: reject as the primary architecture. Keep compact refs in summary, not whole contracts.

### Option C: Split Summary, Contract Canary, And Full Evidence Authority

Jangar reads summary evidence for hot readiness, reads compact contract refs when available, and performs a bounded full
contract-canary fetch when source-serving, controller-ingestion settlement, or material evidence settlement needs
route-warrant and repair-bid authority. Torghut emits compact contract refs in summary so Jangar can avoid full reads
for steady-state verification.

Advantages:

- Preserves hot-path performance.
- Eliminates the current false missing-contract hold.
- Gives operators explicit transport reasons.
- Supports fallback from compact refs to full payload and then to revenue-repair repair-bid evidence.
- Keeps paper and live support held unless route warrant, repair bids, source-serving proof, and capital gates all pass.

Disadvantages:

- Adds a transport reducer and tests on both sides.
- Requires careful cache and timeout behavior.
- Temporarily creates two contract paths until compact summary refs are deployed.

Decision: select Option C.

## Architecture

Jangar adds `jangar.torghut-contract-canary-transport.v1`.

```yaml
schema_version: jangar.torghut-contract-canary-transport.v1
transport_id: torghut-contract-canary-transport:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
namespace: agents
summary:
  endpoint: /trading/consumer-evidence?view=summary
  status: current|stale|unavailable|schema_mismatch
  receipt_ref: <torghut-route-proven-profit:*|null>
  observed_contract_refs:
    route_warrant_exchange: <id|null>
    repair_bid_settlement_ledger: <id|null>
full:
  endpoint: /trading/consumer-evidence
  status: current|stale|unavailable|schema_mismatch|not_required
  route_warrant_ref: <id|null>
  repair_bid_settlement_ref: <id|null>
fallbacks:
  revenue_repair_repair_bid_ref: <id|null>
decision: allow|repair_only|hold|block
reason_codes: []
selected_authority: summary_contract_refs|full_payload|revenue_repair_fallback|none
max_notional: '0'
validation_commands: []
rollback_target: ignore contract-canary transport and keep source-serving verdicts in observe mode
```

Rules:

- Summary current plus compact contract refs current can satisfy source-serving contract presence for `dispatch_repair`.
- Summary current without compact refs triggers a bounded full fetch before Jangar declares contracts missing.
- Full payload current with route warrant and repair-bid contracts converts missing-contract reasons into an allow or
  repair-only source-serving verdict, subject to source CI, digest, Argo, and capital gates.
- Full payload unavailable while summary is current yields `torghut_contract_transport_unavailable`, not
  `source_serving_contract_missing`.
- Revenue-repair may supply a repair-bid fallback, but it cannot satisfy route-warrant authority because the live
  revenue-repair payload does not carry `route_warrant_exchange`.
- Any schema mismatch, stale fresh-until, nonzero notional, or contradictory source-serving digest keeps dispatch held.
- Live support remains blocked until full source-serving convergence and independent Torghut capital release.

## Implementation Scope

Engineer stage should make one production PR with these changes:

- Jangar:
  - add the transport reducer near `control-plane-torghut-consumer-evidence.ts`;
  - stop treating summary-only evidence as proof that required full contracts are absent;
  - feed transport output into `buildSourceServingContractVerdictExchange`;
  - keep `/ready` summary-first and bounded by the existing timeout budget;
  - add tests for summary-current/full-contracts-present, summary-current/full-unavailable, compact-ref success,
    stale full payload, schema mismatch, and revenue-repair repair-bid fallback.
- Torghut:
  - add compact `contract_canary_refs` to summary consumer evidence with route warrant and repair-bid ids,
    schema versions, fresh-until values, statuses, and max notional;
  - preserve full payload authority for the complete contract bodies;
  - add tests that summary stays under the canary payload budget and includes the compact refs.

No implementation in this contract may widen Torghut paper or live notional. The expected first metric movement is a
lower false `zero_notional_or_stale_evidence_rate` caused by stale or hidden proof transport. `routeable_candidate_count`
may remain zero until no-delta reentry receives a changed or repairable release condition.

## Validation Gates

Local validation for the engineer PR:

- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-source-serving-contract-verdict.test.ts`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k consumer_evidence`
- `uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Post-deploy validation:

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
- Jangar full control-plane status shows `torghut_contract_canary_transport.decision` is not `block`.
- Source-serving verdict no longer reports `source_serving_contract_missing:route_warrant_exchange` when full Torghut
  consumer evidence has a current route warrant.
- Torghut `/trading/consumer-evidence?view=summary` includes compact contract refs.
- Torghut `/trading/revenue-repair` remains `business_state=repair_only`, `max_notional=0`, and no-delta reentry remains
  denied unless a zero-notional repair ticket is selected.

## Rollout

1. Ship Jangar transport reducer in observe mode and log both summary and full authority without changing decisions.
2. Ship Torghut compact summary contract refs.
3. Enable Jangar source-serving to use compact refs or full contract canary for `dispatch_repair` only.
4. Keep `dispatch_normal`, `paper_support`, `live_support`, and all capital-bearing actions on the stricter existing
   source-serving and Torghut capital gates.
5. Promote images through normal GitOps and verify Jangar/Torghut status surfaces after Argo convergence.

## Rollback

Rollback is safe because the contract is additive and observe-first:

- disable Jangar contract-canary consumption and return source-serving verdicts to summary-only behavior;
- keep Torghut compact summary refs present because they are additive and non-authoritative without Jangar consumption;
- revert the PR if compact refs or full-fetch caching increase latency beyond the control-plane budget;
- keep Torghut `max_notional=0` and no-delta duplicate reentry denial active throughout rollback.

## Risks

- A full payload fetch could exceed the existing Jangar timeout. Mitigation: summary remains authoritative for service
  health; full payload failure produces a transport hold, not readiness failure.
- Compact refs could drift from full payload contracts. Mitigation: include schema version, fresh-until, and ids in the
  summary ref and compare them with full payload when both are available.
- This fix may reveal the next blocker rather than immediately raising `routeable_candidate_count`. That is acceptable;
  the current blocker is false contract transport, and routeability should only move after that is retired.

## Handoff

Engineer acceptance gate: a Jangar/Torghut implementation PR makes current summary evidence plus full contract payload
produce a source-serving transport hold or repair-only verdict for the right reason, never a false missing-contract
verdict.

Deployer acceptance gate: after image promotion, live Jangar status can name the selected Torghut contract authority,
Torghut summary exposes compact contract refs, revenue repair remains zero-notional, and no-delta reentry either stays
denied with a transport reason retired or selects exactly one zero-notional repair ticket.
