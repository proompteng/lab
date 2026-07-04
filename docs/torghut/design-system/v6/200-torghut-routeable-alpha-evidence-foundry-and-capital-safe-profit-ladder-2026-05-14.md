# 200. Torghut Routeable Alpha Evidence Foundry And Capital-Safe Profit Ladder (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut alpha-readiness repair, routeable candidate evidence, post-cost profit proof, execution-quality
guardrails, zero-notional capital safety, rollout, rollback, and Jangar handoff.

Companion Jangar contract:

- `docs/agents/designs/195-jangar-receipt-backed-alpha-foundry-and-rollout-safety-covenant-2026-05-14.md`

Extends:

- `198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`
- `199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`
- `docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`
- `197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`
- `197-torghut-alpha-readiness-strike-ledger-and-routeable-candidate-ladder-2026-05-13.md`
- `190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`
- `188-torghut-route-evidence-clearinghouse-and-execution-freshness-market-2026-05-12.md`
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

## Decision

I am selecting a **routeable alpha evidence foundry** as the next Torghut architecture increment.

The live business surface is specific. On 2026-05-14 at 00:25 UTC,
`GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned `revenue_ready=false`,
`business_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`, and top queue item
`repair_alpha_readiness`. That top item targets `routeable_candidate_count`, cites
`hypothesis_not_promotion_eligible`, has expected unblock value `4`, and requires
`torghut.executable-alpha-receipts.v1`.

The current evidence is not telling us to relax capital. It is telling us to make the alpha repair measurable enough
that one or more candidates can move from blocked evidence to routeable paper candidate while notional stays zero.
The foundry is the missing middle layer. It turns the three live hypothesis blockers into expiring
`torghut.alpha-evidence-window-receipt.v1` receipts, attaches post-cost proof and rejection-drag measurement, and
allows Jangar to deny duplicate or no-delta work until the receipt set changes.

The tradeoff is sharper scope. Generic feature, TCA, and quant repair lots remain useful, but they do not get to consume
the top revenue lane unless they retire a blocker on the selected alpha-readiness queue item. That is the right trade:
the business metric is routeable post-cost profit evidence and live readiness without weakening capital safety, not
repair throughput.

## Governing Runtime Requirements

This design is governed by the active swarm validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value gates:

- `routeable_candidate_count`: primary gate; move at least one alpha candidate from blocked/shadow to routeable paper
  candidate evidence, or emit no-delta debt.
- `post_cost_daily_net_pnl`: prove positive post-cost expectancy on the selected hypothesis window before promotion
  custody can settle.
- `zero_notional_or_stale_evidence_rate`: reduce stale or missing alpha evidence windows without opening notional.
- `fill_tca_or_slippage_quality`: keep route candidates excluded when active-session TCA, expected shortfall, or route
  universe proof is missing or stale.
- `capital_gate_safety`: preserve `max_notional=0`, `simple_submit_disabled`, and shadow capital stage until every
  required receipt settles.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading
flags, broker state, or GitOps objects.

### Cluster And Rollout

- Branch: `codex/swarm-torghut-quant-discover`, based on `origin/main` at
  `c7f5dbf32 docs(jangar): define cross-plane closure board (#6510)`.
- Torghut namespace pods were mostly healthy: active live revision `torghut-00371` was `2/2 Running`; active sim
  revision `torghut-sim-00469` was `2/2 Running`; ClickHouse, Keeper, Postgres, TA, TA sim, WebSocket, and exporters
  were running.
- Recent Torghut events showed normal revision creation and scale-down after rollout, transient startup/readiness probe
  failures during replacement, and `torghut-db-migrations` completing.
- Options catalog was reachable but not ready: `/healthz` returned `status=ok`, `ready=false`, and
  `last_error_code=catalog_cycle_failed` after a PostgreSQL deadlock while upserting
  `torghut_options_subscription_state`. Options enricher was ready.
- Jangar was serving image `202dcaf1`, `deployment/jangar` was `1/1`, and `agents` plus `agents-controllers` were
  healthy. Recent events still showed rollout-start readiness probe failures, and the agents namespace retained many
  completed/error/OOMKilled AgentRun pods. That supports receipt-backed admission rather than broad dispatch.

### Source And Runtime Contracts

- `services/torghut/app/trading/revenue_repair.py` already ranks the live queue and gives
  `repair_alpha_readiness` precedence when the selected value gate is `routeable_candidate_count`.
- `services/torghut/app/trading/executable_alpha_receipts.py` emits three selected zero-notional repair receipts for
  `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`.
- `services/torghut/app/trading/proof_floor.py` keeps capital at zero and reports `alpha_readiness`,
  `execution_tca`, `empirical`, `market_context`, and live-submission dimensions from one proof-floor receipt.
- `services/torghut/app/trading/route_evidence_clearinghouse.py` separates source freshness, execution freshness,
  rollout-image proof, profit-window custody, and capital-hold books. Its active execution book held on stale active
  session samples and missing expected-shortfall coverage.
- `services/torghut/tests/test_build_revenue_repair_digest.py`,
  `test_executable_alpha_repair_receipts.py`, `test_route_evidence_clearinghouse.py`,
  `test_repair_bid_settlement.py`, and `test_profitability_proof_floor.py` cover the current reducers. The missing
  test family is end-to-end alpha evidence windows: given the live top queue item, the system should produce one
  receipt per hypothesis and a deterministic routeable-candidate delta or no-delta reason.

### Database And Data Quality

- Direct CNPG reads, secret reads, and pod exec were forbidden for this service account. The accepted database witness
  for this lane is Torghut's application-level read surface.
- `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, lineage ready, and
  account scope ready. Known parent-fork warnings remain documented for historical migration branches under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/trading/profitability/runtime` reported a 72 hour window with `68` decisions, `0` executions, and `6250` TCA
  samples. Realized PnL proxy was `-1726.06230727` notional, and all recent decisions were blocked.
- `/trading/status` reported three hypotheses loaded, `promotion_eligible_total=0`, `rollback_required_total=2`, and
  alpha readiness failed with blockers:
  `post_cost_expectancy_non_positive`, `drift_checks_missing`, `feature_rows_missing`,
  `required_feature_set_unavailable`, closed-session signal/TCA holds, and closed-session market-context hold.
- Route/TCA proof had `7334` order rows and `7245` filled executions, but active execution samples were old. The route
  universe had one probing candidate (`AAPL`), four blocked symbols (`AMD`, `AVGO`, `INTC`, `NVDA`), and three missing
  symbols (`AMZN`, `GOOGL`, `ORCL`).
- `routeability_repair_acceptance_ledger` reported `aggregate_state=blocked`,
  `accepted_routeable_candidate_count=0`, and `zero_notional_or_stale_evidence_rate=1.0`.

## Problem

Torghut now has the correct business queue, but it still lacks a dedicated evidence producer that can retire the top
alpha-readiness blocker. That creates five concrete failure modes.

1. `repair_alpha_readiness` can be dispatchable while its output remains a generic executable-alpha receipt instead of
   a hypothesis-scoped evidence window with a measured before/after delta.
2. The same three hypotheses can be repaired repeatedly without proving whether feature coverage, drift checks,
   post-cost expectancy, or rejection-drag measurement changed.
3. TCA and route-universe blockers are correctly conservative, but they are not linked to a hypothesis-level routeable
   candidate ladder that explains which route can advance next and why the rest stay excluded.
4. Runtime profitability is visible, but negative realized PnL proxy and zero executions do not feed a compact
   promotion-custody denial receipt.
5. An options catalog deadlock can reduce source freshness or market surface quality without being priced into the
   alpha evidence window.

The design must convert the top queue item into a small set of receipts with exact acceptance gates. Anything else is
evidence churn.

## Alternatives Considered

### Option A: Continue With Existing Executable Alpha Receipts

Keep emitting `torghut.executable-alpha-repair-receipts.v1` and let Jangar dispatch the selected receipts.

Advantages:

- No new schema.
- Already live in `/trading/revenue-repair` and `/trading/consumer-evidence`.
- Keeps alpha repair zero-notional.

Disadvantages:

- The receipts are repair instructions, not after-state evidence.
- No measured delta for `routeable_candidate_count`.
- Does not close `post_cost_expectancy_non_positive`, `feature_rows_missing`, or rejection-drag proof by itself.

Decision: reject as the next increment. Keep the existing receipts as inputs.

### Option B: Prioritize Execution TCA Repair First

Use the route universe and TCA repair lots as the first system-level lane.

Advantages:

- TCA evidence is stale and expected-shortfall coverage is missing.
- Route quality directly protects capital.
- Improves `fill_tca_or_slippage_quality`.

Disadvantages:

- It does not clear the top `/trading/revenue-repair` queue item.
- Current proof floor already enforces route-symbol exclusions and keeps capital zero.
- Without hypothesis evidence windows, fresher TCA still leaves alpha readiness not promotion eligible.

Decision: reject as the primary lane. TCA remains a required guardrail and after-receipt input.

### Option C: Treat Options Catalog Recovery As The First Profit Lane

Focus on the options catalog deadlock and source freshness before alpha readiness.

Advantages:

- The deadlock is a real data-plane reliability issue.
- Options can expand opportunity surfaces.
- Single-writer catalog repair may reduce future stale evidence.

Disadvantages:

- The live route claims currently have `options_route_claim_count=0`.
- It does not move the current top `routeable_candidate_count` blocker.
- It risks broadening the opportunity surface before the existing equity alpha candidates have settled proof.

Decision: reject as the first lane, but include the catalog deadlock as a data freshness guardrail and follow-up.

### Option D: Routeable Alpha Evidence Foundry

Build a bounded evidence producer that consumes the existing top queue item and emits one receipt per blocked
hypothesis with feature, drift, post-cost, TCA, market-context, rejection-drag, and capital-safety fields.

Advantages:

- Directly targets the live business blocker.
- Gives Jangar one receipt class to require before another alpha repair run.
- Makes no-delta outcomes explicit.
- Keeps capital at zero until routeability, profit, TCA, and capital gate receipts all pass.
- Creates the implementation ladder engineers can build without debating the architecture again.

Disadvantages:

- Adds one more Torghut contract and reducer.
- Requires careful tests so the receipt cannot imply capital authority.
- Needs Jangar to consume and settle the new receipt class before enforcement.

Decision: select Option D.

## Architecture

The foundry is a read-model and receipt producer. It does not submit orders, enable paper/live capital, or mutate
broker state.

```text
alpha_evidence_foundry
  schema_version = torghut.alpha-evidence-foundry.v1
  foundry_id
  generated_at
  fresh_until
  account
  window
  source_revenue_repair_ref
  selected_queue_code = repair_alpha_readiness
  selected_value_gate = routeable_candidate_count
  routeable_candidate_count_before
  zero_notional_or_stale_evidence_rate_before
  tca_quality_ref
  runtime_profitability_ref
  options_catalog_ref
  capital_state = zero_notional
  receipts[]
  no_delta_debt[]
  next_implementation_milestone
```

Each receipt is hypothesis scoped:

```text
alpha_evidence_window_receipt
  schema_version = torghut.alpha-evidence-window-receipt.v1
  receipt_id
  hypothesis_id
  candidate_id
  strategy_id
  lane_id
  strategy_family
  before_reason_codes[]
  retired_reason_codes[]
  preserved_reason_codes[]
  new_reason_codes[]
  feature_coverage_state
  drift_check_state
  post_cost_expectancy_state
  post_cost_daily_net_pnl_estimate
  rejection_drag_state
  market_context_state
  tca_state
  route_universe_state
  expected_routeable_candidate_delta
  measured_routeable_candidate_delta
  max_notional = 0
  capital_rule = zero_notional_repair_only
  validation_commands[]
  rollback_target
```

The first live receipts map to current hypotheses:

- `H-CONT-01`: continuation lane. Required repair is positive post-cost expectancy plus fresh signal/TCA evidence.
  Expected routeable delta is `+1` only if the receipt retires `post_cost_expectancy_non_positive` and no TCA guardrail
  blocks the selected symbol.
- `H-MICRO-01`: microstructure-breakout lane. Required repair is feature coverage plus drift checks. Expected
  routeable delta is `+1` only if `feature_rows_missing`, `required_feature_set_unavailable`, and
  `drift_checks_missing` are retired.
- `H-REV-01`: event-reversion lane. Required repair is positive post-cost expectancy plus market-context evidence.
  Expected routeable delta is `+1` only if `post_cost_expectancy_non_positive` and market-context hold reasons clear.

The ladder has four states:

```text
blocked_evidence -> evidence_window_current -> promotion_candidate -> routeable_paper_candidate
```

Promotion to `routeable_paper_candidate` requires all of:

1. receipt freshness within the foundry TTL;
2. `measured_routeable_candidate_delta > 0` or a named no-delta reason;
3. post-cost daily net PnL estimate positive after costs and rejection drag;
4. TCA state not stale and expected-shortfall sample coverage present;
5. route universe admits at least one symbol and excludes missing/high-slippage symbols;
6. capital state remains `zero_notional`, live submit remains disabled, and max notional stays `0`;
7. source-serving and rollout-image proof are current enough for Jangar to trust the receipt.

## Failure-Mode Reduction

- **Duplicate repair loops:** the foundry emits a dedupe key per account/window/hypothesis/reason set. Jangar denies
  duplicate runs until the top queue item, blocker set, or after receipt changes.
- **No-delta ambiguity:** a run that does not retire a reason code emits `no_delta_debt` and cannot be counted as
  improving `routeable_candidate_count`.
- **Capital leakage:** all receipts carry `max_notional=0`; any nonzero notional, live submit enablement, or missing
  rollback target blocks settlement.
- **Rollout ambiguity:** a receipt cannot graduate without source-serving and rollout-image refs, so a green pod alone
  cannot clear the lane.
- **Data freshness gaps:** options catalog deadlocks, stale active-session execution samples, and missing expected
  shortfall coverage are recorded as guardrail holds rather than ignored.

## Implementation Scope

Engineer stage should build the first production slice in `services/torghut`:

- Add `app/trading/alpha_evidence_foundry.py` as a pure reducer.
- Consume existing proof-floor, revenue-repair, routeability, runtime-profitability, and executable-alpha receipt
  payloads.
- Expose `alpha_evidence_foundry` from `/trading/revenue-repair` and `/trading/consumer-evidence`.
- Add focused tests:
  - `tests/test_alpha_evidence_foundry.py`
  - extend `tests/test_build_revenue_repair_digest.py`
  - extend `tests/test_executable_alpha_repair_receipts.py`
- Preserve all current zero-notional fields and prove nonzero notional blocks settlement.

Target validation commands:

```bash
cd services/torghut
uv run --frozen pytest tests/test_alpha_evidence_foundry.py tests/test_build_revenue_repair_digest.py tests/test_executable_alpha_repair_receipts.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Deployer stage should promote only after CI is green and then verify:

```bash
kubectl get pods -n torghut -o wide
curl -fsS http://torghut.torghut.svc.cluster.local/db-check
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.alpha_evidence_foundry'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.alpha_evidence_foundry'
curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.torghut_consumer_evidence'
```

## Rollout

1. Ship the reducer in observe mode. It must not affect `/readyz`, live submission, or order execution.
2. Add the foundry object to `/trading/revenue-repair` first, then mirror it to `/trading/consumer-evidence` after
   tests prove schema stability.
3. Let Jangar consume the object in shadow mode and compare selected receipts against the current repair queue.
4. Enable duplicate/no-delta denial for alpha-readiness repair only after at least one green deployer check proves the
   object is present in the live service.
5. Keep paper/live capital gates unchanged until routeability acceptance and proof floor move out of repair-only with
   independent approval.

## Rollback

Rollback is to stop emitting `alpha_evidence_foundry` and keep the existing executable-alpha receipts, proof floor, and
capital holds in force. If a rollout causes `/trading/revenue-repair` or `/trading/consumer-evidence` failures, revert
the code PR, promote the previous image through GitOps, and verify:

- `/db-check` remains schema-current;
- `/trading/revenue-repair` still reports `business_state=repair_only`;
- `max_notional` remains `0`;
- `simple_submit_disabled` remains active;
- Jangar falls back to the prior alpha-readiness strike and closure board contracts.

## Risks

- A receipt can be overfit to the current three hypotheses. Mitigation: keep the schema generic and make hypothesis
  rows data-driven from the proof floor.
- Negative post-cost evidence may keep every candidate blocked. That is acceptable; the result is a no-delta or denial
  receipt, not a capital release.
- Jangar may admit the old executable-alpha receipt before it understands the foundry. Mitigation: companion contract
  194 requires shadow comparison before enforcement.
- Options catalog deadlocks can recur. Mitigation: record catalog state as a guardrail and create a follow-up
  single-writer catalog repair if it blocks selected evidence windows.

## Handoff

Engineer next action: implement the foundry reducer and tests, then open a production PR that proves
`alpha_evidence_foundry.receipts` exists for `H-CONT-01`, `H-MICRO-01`, and `H-REV-01` while `max_notional=0`.

Deployer next action: after the engineer PR merges and image promotion lands, prove the live endpoints expose the
foundry and that Jangar reads it without changing paper/live capital authority.

Smallest blocker preventing revenue impact today: `routeable_candidate_count` remains `0` because the top
`repair_alpha_readiness` queue item lacks settled alpha evidence-window receipts that retire post-cost, feature, drift,
and market-context blockers.
