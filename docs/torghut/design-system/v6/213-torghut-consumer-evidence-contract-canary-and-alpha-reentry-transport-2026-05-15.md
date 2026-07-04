# 213. Torghut Consumer-Evidence Contract Canary And Alpha Reentry Transport (2026-05-15)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-15
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut consumer-evidence summary/full transport, contract-canary refs, revenue-repair source authority,
no-delta alpha reentry, validation gates, rollout, rollback, and cross-swarm handoff.

Companion Jangar contract:

- `docs/agents/designs/207-jangar-consumer-evidence-transport-split-and-source-serving-contract-canary-2026-05-15.md`

Extends:

- `212-torghut-route-adjacent-proof-and-execution-freshness-reentry-2026-05-14.md`
- `212-torghut-consumer-evidence-parity-and-alpha-release-freshness-2026-05-14.md`
- `211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
- `210-torghut-source-bound-verification-carry-import-and-no-delta-release-2026-05-14.md`
- `191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md`

## Decision

I am selecting **consumer-evidence contract canaries with alpha-reentry transport separation** as Torghut's next
architecture slice.

The live business surface is still `repair_only`, not revenue-ready. The top queue item is
`repair_alpha_readiness`, with value gate `routeable_candidate_count`, required output
`torghut.executable-alpha-receipts.v1`, and `max_notional=0`. The no-delta auction correctly denies another H-MICRO-01
reentry because the active release key has not changed and Jangar controller-ingestion carry is still lagging.

The new evidence says part of that lag is self-inflicted by transport shape. Full `/trading/consumer-evidence` carries
the route warrant and repair-bid settlement ledger that Jangar requires, but `?view=summary` omits them. Jangar reads the
summary route for status, then marks `route_warrant_exchange` and `repair_bid_settlement_ledger` missing. Torghut should
not force Jangar to choose between a cheap summary and correct source-serving contracts. Torghut should publish compact
contract-canary refs in summary and keep the full contract bodies in the full payload.

The tradeoff is that Torghut will duplicate small refs across payloads. I accept that. It is lower risk than widening
the summary into another full payload, and it gives Jangar enough proof to avoid false missing-contract holds while
capital remains locked.

## Governing Runtime Requirements

This design is the governing Torghut requirement for the next implementation stage:

- code-changing runs must cite this doc or the companion Jangar doc;
- implementation PRs must improve readiness, profit evidence, data freshness, execution quality, or capital safety;
- verification must prove image promotion, Argo sync, live service health, and revenue-repair status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `routeable_candidate_count`: the top repair queue remains H-MICRO-01 alpha readiness; contract canaries remove a false
  source-serving blocker before another reentry attempt.
- `zero_notional_or_stale_evidence_rate`: compact refs make stale or hidden contracts measurable instead of invisible.
- `fill_tca_or_slippage_quality`: execution TCA stays a separate receipt; this transport fix must not claim TCA quality
  movement by itself.
- `post_cost_daily_net_pnl`: no direct movement until routeable candidates and capital gates pass.
- `capital_gate_safety`: all summary refs, full contracts, and reentry tickets in this slice carry `max_notional=0`.

## Current Assessment

Evidence was collected read-only on 2026-05-15 between 00:26Z and 00:30Z.

### Cluster Assessment

- Torghut Argo app was `Synced/Healthy` at `ff98e82146135c9a592eee4c3676da47c2e83477`.
- Torghut live revision `torghut-00433` and sim revision `torghut-sim-00518` were running and ready.
- Options catalog, options enricher, TA, websocket, ClickHouse, and guardrail exporters were running.
- Execution TCA refresh had one active-deadline failure in recent events and later successful completions. That means
  completed cron runs should remain evidence inputs, not capital-release proof.
- Agents Argo was `Healthy/OutOfSync`; Jangar was `Synced/Healthy`. The control-plane source-serving contract should
  carry this distinction explicitly instead of burying it in Torghut no-delta reasons.

### Source Assessment

- Torghut full consumer evidence builds:
  - `route_warrant_exchange`;
  - `repair_bid_settlement_ledger`;
  - `source_serving_repair_receipt_ledger`;
  - `freshness_carry_ledger`;
  - `no_delta_repair_reentry_auction`;
  - alpha readiness, repair, and dividend receipts.
- The summary path in `services/torghut/app/main.py` returns only the lightweight receipt, route-proven receipt, proof
  floor, live gate, market context, quant evidence, and coarse dependency status. It does not expose route warrant or
  repair-bid compact refs.
- Jangar's consumer-evidence resolver intentionally appends `view=summary` to `/trading/consumer-evidence`, then asks
  source-serving verdict code for contracts that summary does not contain.
- Existing tests cover full payload contract presence and summary payload exclusion, but they do not assert a compact
  contract-canary surface for summary.

### Database And Data Assessment

- `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- Direct CNPG and Postgres exec checks are blocked for the agents service account. That is acceptable for this lane;
  the deployer should verify typed service evidence, not direct database mutation or privileged reads.
- Full consumer evidence at 00:29Z had `route_warrant_id=route-warrant-exchange:989878b5ceeabaa4e08f` and
  `repair_bid_ledger_id=repair-bid-settlement-ledger:db2cfac92bf7ccfe808c`.
- Summary consumer evidence at 00:29Z had current `torghut.consumer-evidence-receipt.v1` and
  `torghut.route-proven-profit-receipt.v1`, but no route warrant and no repair-bid ledger.
- Revenue repair at 00:27Z had `repair_bid_settlement_ledger` but not route warrant. It remains the business queue
  authority, not the complete contract transport authority.

### Business Evidence

- `/trading/revenue-repair` returned `business_state=repair_only` and `revenue_ready=false`.
- Top queue:
  - `code=repair_alpha_readiness`;
  - `reason=hypothesis_not_promotion_eligible`;
  - `value_gate=routeable_candidate_count`;
  - `required_output_receipt=torghut.executable-alpha-receipts.v1`;
  - `max_notional=0`.
- `jangar_controller_ingestion_carry.carry_state=lagging`.
- `no_delta_repair_reentry_auction.reentry_decision=deny`, selected ticket `null`, selected hypothesis `H-MICRO-01`,
  routeable candidates before and after `0`, and active no-delta release key present.

## Problem

Torghut is producing the contracts Jangar needs, but it does not expose compact evidence of those contracts on the
summary path that Jangar uses for its control-plane status. That creates four bad interpretations:

1. A current summary route can look like a missing route warrant.
2. A current full route warrant can be ignored because the summary route hides it.
3. No-delta reentry can stay denied for `jangar_controller_ingestion_lagging` without naming the transport artifact.
4. Deployer handoff can mistake a source-serving transport miss for a trading-model defect.

The next Torghut slice must make contract transport explicit while keeping the hot summary bounded.

## Alternatives Considered

### Option A: Make Summary Equal Full Consumer Evidence

Torghut would remove the summary/full distinction.

Advantages:

- No duplicated refs.
- Jangar sees all contracts with one request.
- Simpler to reason about in tests.

Disadvantages:

- Summary loses its latency and payload-budget purpose.
- Any future contract growth increases hot-path risk.
- A full-payload failure becomes harder to distinguish from service-health failure.

Decision: reject.

### Option B: Keep Summary Minimal And Require Jangar To Fetch Full Evidence

Torghut would leave summary unchanged and make Jangar always perform a second full fetch for contract checks.

Advantages:

- No Torghut payload change.
- Keeps full payload as sole contract body authority.
- Fastest Torghut implementation.

Disadvantages:

- Jangar still has no cheap steady-state proof that full contracts exist.
- Full fetch failures would remain common during status refreshes.
- Summary can be current while contract authority is unknown.

Decision: reject as the sole architecture.

### Option C: Add Compact Contract-Canary Refs To Summary And Keep Full Bodies Authoritative

Torghut adds small contract refs to summary. Jangar uses those refs for cheap presence and freshness checks, and uses
full payload only when it needs body-level proof or compact refs are absent.

Advantages:

- Preserves summary latency.
- Makes source-serving contract presence visible.
- Lets Jangar distinguish missing, stale, schema-mismatched, and transport-unavailable contracts.
- Keeps full payload as the source of truth for body-level validation.
- Keeps capital locked.

Disadvantages:

- Adds a compact schema and dual-path tests.
- Requires ref/full consistency checks.
- Does not by itself create routeable candidates.

Decision: select Option C.

## Architecture

Torghut adds `torghut.consumer-evidence-contract-canary.v1` to `/trading/consumer-evidence?view=summary`.

```yaml
schema_version: torghut.consumer-evidence-contract-canary.v1
canary_id: consumer-evidence-contract-canary:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
source_commit: <sha>
serving_revision: <revision>
image_digest: <digest>
summary_route_ref: /trading/consumer-evidence?view=summary
full_route_ref: /trading/consumer-evidence
observed_contracts:
  - route_warrant_exchange
  - repair_bid_settlement_ledger
contract_refs:
  route_warrant_exchange:
    schema_version: torghut.route-warrant-exchange.v1
    ref: <route-warrant-exchange:*|null>
    fresh_until: <iso8601|null>
    state: current|stale|missing|schema_mismatch
    max_notional: '0'
  repair_bid_settlement_ledger:
    schema_version: torghut.repair-bid-settlement-ledger.v1
    ref: <repair-bid-settlement-ledger:*|null>
    fresh_until: <iso8601|null>
    state: current|stale|missing|schema_mismatch
    max_notional: '0'
decision: current|hold|block
reason_codes: []
rollback_target: omit contract_canary_refs from summary and keep full consumer evidence as authority
```

Summary payload additions:

- `contract_canary_refs`: the canary object above.
- `observed_contracts`: compact normalized names.
- `contract_schema_mismatches`: compact normalized mismatches.
- `route_warrant_id`, `route_warrant_fresh_until`, `route_warrant_state`, and route-warrant value-gate fields.
- `repair_bid_settlement_ledger_id`, `repair_bid_settlement_fresh_until`,
  `repair_bid_settlement_routeable_candidate_count`, selected lot ids, held lot ids, dispatchable lot ids, and
  `max_notional`.

Full payload remains authoritative for:

- complete route warrant body;
- complete repair-bid settlement body;
- source-serving repair receipt ledger;
- route evidence clearinghouse;
- no-delta reentry auction;
- alpha readiness, executable-alpha, and dividend receipts.

Revenue repair remains authoritative for:

- current business state;
- top repair queue;
- required output receipt;
- no-delta reentry decision;
- Jangar controller-ingestion carry imported into Torghut;
- the smallest blocker preventing revenue impact.

## No-Delta Reentry Rules

The contract canary does not release capital and does not automatically select a no-delta reentry ticket.

No-delta reentry may select a `jangar_verify_carry` or successor ticket only when all of these are true:

- revenue repair top queue is still `repair_alpha_readiness`;
- selected value gate is `routeable_candidate_count`;
- contract canary says route warrant and repair-bid settlement are current or repairable;
- Jangar controller-ingestion carry is `repairable` or `current`;
- active no-delta release key has a changed release condition or the selected ticket is explicitly a bounded
  controller-ingestion repair;
- required output receipt and validation commands are present;
- `max_notional=0`.

If any condition fails, Torghut keeps `reentry_decision=deny` or `hold` and preserves the reason codes.

## Implementation Scope

Engineer stage should make one bounded implementation PR:

- add `build_consumer_evidence_contract_canary` in `services/torghut/app/trading/consumer_evidence.py`;
- populate summary `contract_canary_refs`, `observed_contracts`, and compact contract fields from the already-built
  full payload contracts in `services/torghut/app/main.py`;
- add tests in `services/torghut/tests/test_consumer_evidence.py` and
  `services/torghut/tests/test_trading_api.py -k consumer_evidence`;
- update Jangar consumer-evidence normalization to read compact refs and fall back to full payload;
- update Jangar source-serving tests so summary-current/full-contracts-present clears false contract-missing reasons.

Do not touch order submission, notional limits, live submit flags, or capital gates in this milestone.

## Validation Gates

Local validation for the engineer PR:

- `uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k consumer_evidence`
- `uv run --frozen pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-source-serving-contract-verdict.test.ts`

Post-deploy validation:

- `/trading/consumer-evidence?view=summary` includes `contract_canary_refs` and stays within the existing summary
  latency and payload budget.
- Full `/trading/consumer-evidence` still includes the complete route warrant and repair-bid settlement bodies.
- `/trading/revenue-repair` remains `repair_only`, `revenue_ready=false`, and `max_notional=0` until a later repair
  actually creates routeable candidates.
- Jangar source-serving no longer reports route warrant or repair-bid contract missing when the compact refs or full
  payload prove them current.

## Rollout

1. Ship compact refs in Torghut summary with no Jangar decision change.
2. Promote Torghut and verify summary/full consistency.
3. Ship Jangar transport split and consume compact refs in observe mode.
4. Allow source-serving `dispatch_repair` to use the contract canary only after both summary and full consistency tests
   are green.
5. Keep normal dispatch, paper canary, live micro canary, and live scale held by existing gates.

## Rollback

Rollback is additive:

- remove or ignore `contract_canary_refs` from summary;
- keep full `/trading/consumer-evidence` unchanged;
- keep `/trading/revenue-repair` as business queue authority;
- keep no-delta duplicate reentry denial and `max_notional=0`;
- revert the implementation PR if summary latency or payload size breaches the canary budget.

## Risks

- Compact refs can drift from full contracts. Mitigation: compare ids, schema versions, fresh-until values, and
  `max_notional` during Jangar full-fetch validation.
- Summary may grow too large. Mitigation: refs only, no contract bodies, and keep existing canary payload budget.
- The next blocker may become empirical jobs or alpha evidence rather than routeable candidates. Mitigation: keep value
  gates explicit; the first expected improvement is retiring false stale-evidence transport, not positive PnL.

## Handoff

Engineer acceptance gate: summary consumer evidence proves route warrant and repair-bid contract refs without carrying
their full bodies, and Jangar can consume those refs without declaring false missing-contract blockers.

Deployer acceptance gate: after promotion, Torghut summary/full contract refs match, Jangar source-serving cites the
selected transport authority, revenue repair stays zero-notional, and H-MICRO-01 no-delta reentry remains denied unless
one bounded zero-notional repair ticket is selected with validation commands.
