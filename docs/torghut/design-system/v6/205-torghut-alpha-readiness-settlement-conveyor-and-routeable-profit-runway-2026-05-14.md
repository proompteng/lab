# 205. Torghut Alpha Readiness Settlement Conveyor And Routeable Profit Runway (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut alpha-readiness repair, routeable candidate recovery, empirical evidence settlement, zero-notional
capital safety, Jangar custody handoff, validation, rollout, rollback, and business evidence.

Companion Jangar contract:

- `docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`

Extends:

- `204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md`
- `203-torghut-alpha-closure-dividend-slo-and-consumer-evidence-carry-2026-05-14.md`
- `200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md`
- `198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`
- `197-torghut-alpha-readiness-strike-ledger-and-routeable-candidate-ladder-2026-05-13.md`

## Decision

I am selecting an **alpha-readiness settlement conveyor** as the next Torghut architecture increment.

The live business surface is not ambiguous. On 2026-05-14 at 08:40:57Z,
`GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned
`business_state=repair_only`, `revenue_ready=false`, `accepted_routeable_candidate_count=0`,
`zero_notional_or_stale_evidence_rate=1.0`, and `max_notional=0`. The top repair queue item was
`repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, priority `70`, value gate
`routeable_candidate_count`, and required output `torghut.executable-alpha-receipts.v1`.

The top repair should not be displaced by execution TCA repair or live-submit work. TCA is important, but the current
route evidence shows one probing symbol (`AAPL`), four blocked symbols (`AMD`, `AVGO`, `INTC`, `NVDA`), and three
missing symbols (`AMZN`, `GOOGL`, `ORCL`) while the routeable candidate count remains zero. The live submission gate
is closed by design (`simple_submit_disabled`), and capital remains shadow and zero notional. Spending the next
implementation run on submit enablement would weaken capital safety without improving revenue readiness.

The selected conveyor turns the alpha-readiness queue item into a bounded evidence-settlement lane. It chooses the
first hypothesis lane that can plausibly move `routeable_candidate_count` under zero notional, funds the missing
receipts, emits a settlement result, and carries a compact proof to Jangar. Based on current evidence, the first lane
is `H-MICRO-01`: it has strategy lineage ready, but it is blocked by stale hypothesis-window evidence, empirical jobs,
drift or forecast evidence, schema-lineage escrow, and no promotion certificate. `H-CONT-01` and `H-REV-01` remain
important, but both show missing strategy-hypothesis lineage and non-positive post-cost expectancy, so they should not
take the first repair slot.

The tradeoff is that the conveyor adds another Torghut proof object before Jangar launches or widens material work. I
accept that cost. The current failure mode is repeated evidence work that does not move `routeable_candidate_count`.
The next system-level improvement is to make alpha-readiness settlement accountable: every run either pays a routeable
candidate dividend, records no-delta debt with a release key, or is ineligible for another launch until the evidence
has changed.

## Governing Runtime Requirements

This design implements the active Torghut validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `routeable_candidate_count`: primary business metric. A conveyor settlement is successful only when the accepted
  routeable candidate count increases from zero or the receipt explains why it did not.
- `post_cost_daily_net_pnl`: post-cost expectancy remains a hard guardrail for `H-CONT-01` and `H-REV-01`; they cannot
  graduate before positive, source-bound expectancy evidence exists.
- `zero_notional_or_stale_evidence_rate`: stale empirical, schema-lineage, or hypothesis-window evidence keeps the
  rate at `1.0`; the conveyor must reduce stale/no-delta evidence before any capital change.
- `fill_tca_or_slippage_quality`: TCA route coverage remains a downstream guardrail. It does not override the alpha
  readiness queue while no hypothesis can graduate.
- `capital_gate_safety`: live submit remains disabled, capital stage remains `shadow`, and every conveyor action runs
  with `max_notional=0`.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, broker
state, trading flags, GitOps resources, AgentRuns, or market data.

### Cluster, Rollout, And Runtime

- Torghut, Torghut options, and Symphony Torghut were `Synced/Healthy`.
- Active live revision was `torghut-00382`, with image digest
  `sha256:bdc6463153c8ede2b46648596cc3c3f83dfdb5d572a1cd86dfbb93c51fbb5236`.
- Active sim revision was `torghut-sim-00480`.
- Torghut DB, ClickHouse shards, Keeper, TA, TA sim, options catalog, options enricher, WebSocket services, and
  guardrail exporters were running.
- Recent Torghut namespace events showed normal Knative rollout to `00382`, transient startup/readiness probe failures
  during revision replacement, completed post-sync jobs, and recurring ClickHouse PodDisruptionBudget ambiguity.
- Jangar and agents Argo applications were `Synced/Progressing`, and the `torghut-quant` swarm was `Active` but
  degraded on implement and verify stage health.
- The current plan run had already retried after one OOMKilled attempt, which reinforces that the next implementation
  milestone must be small, proof-carrying, and bounded.

### Database And Data Quality

- Direct CNPG psql was blocked by least-privilege RBAC:
  `pods "torghut-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`.
- Listing Torghut secrets and cluster-scoped CNPG resources was also forbidden. I treat that as correct separation of
  duties for this architecture lane.
- The application database witness was healthy. `GET /db-check` returned `ok=true`, `schema_current=true`, current and
  expected Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`, one schema graph branch, no missing heads,
  no unexpected heads, no duplicate revisions, no orphan parents, and `schema_graph_lineage_ready=true`.
- The schema witness still reports historical parent-fork warnings under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`. They are not current-head
  blockers, but they explain why the conveyor must carry a schema-lineage settlement receipt instead of assuming that
  current DB head means every strategy lineage is funded.
- `/readyz` returned HTTP 503 with `status=degraded`, while Postgres, ClickHouse, Alpaca, database schema, static
  universe, and optional quant evidence were healthy. The degradation was the correct business hold: live submission
  was closed and profitability proof floor was `repair_only`.

### Revenue, Alpha, And Routeability

- Top repair queue item: `repair_alpha_readiness`.
- Top repair reason: `hypothesis_not_promotion_eligible`.
- Required output receipt: `torghut.executable-alpha-receipts.v1`.
- Capital rule: `zero_notional_repair_only`.
- Capital state: `shadow`, `zero_notional`, `max_notional=0`, `live_submission_allowed=false`.
- Routeability acceptance: aggregate state `blocked`, accepted routeable candidate count `0`,
  `zero_notional_or_stale_evidence_rate=1.0`.
- Repair bid settlement: `42` raw repair bids, `6` compacted lots, `5` selected lots, `3` dispatchable lots, and
  routeable candidate count `0`.
- Alpha readiness: `3` hypotheses, `0` promotion eligible, `2` rollback required, and `3` repair targets.
- `H-CONT-01`: shadow, blocked by `post_cost_expectancy_non_positive`, with closed-session signal and TCA holds.
- `H-MICRO-01`: shadow, lineage ready, blocked by `drift_checks_missing` and stale hypothesis-window evidence.
- `H-REV-01`: shadow, blocked by `post_cost_expectancy_non_positive`, market-context hold, signal hold, and TCA hold.
- Profit lease provenance showed `autoresearch_candidate_specs=2070`, `autoresearch_proposal_scores=2070`,
  `autoresearch_portfolio_candidates=5`, `autoresearch_portfolio_ready=0`, `autoresearch_portfolio_blocked=5`,
  `trade_decisions:7d=111`, and rejection drag `10000.0` bps.
- Route reacquisition showed `0` capital-eligible symbols, `8` zero-notional rows, expected unblock value `14`, and
  repair candidates split across TCA-blocked and TCA-missing symbols.

### Source And Test Surface

- `services/torghut/app/main.py` is 6,938 lines and is the high-risk integration surface for `/readyz`,
  `/trading/status`, `/trading/revenue-repair`, `/trading/health`, and `/trading/consumer-evidence`.
- `services/torghut/app/trading/revenue_repair.py` is 1,111 lines and owns the live repair digest.
- `services/torghut/app/trading/alpha_repair_closure_board.py` is 820 lines and owns selected closure boards.
- `services/torghut/app/trading/alpha_evidence_foundry.py` is 608 lines and owns evidence-window receipts.
- `services/torghut/app/trading/submission_council.py` is 1,527 lines and owns live submission gate synthesis.
- Existing tests cover revenue repair, alpha evidence foundry, alpha repair closure, route reacquisition, repair-bid
  settlement, consumer evidence, and executable alpha receipts.
- The missing test family is conveyor settlement: lane selection, paid routeable-candidate dividend, no-delta lease,
  stale evidence rejection, schema-lineage escrow funding, zero-notional enforcement, and compact Jangar export parity.

## Problem

Torghut has many proof objects, but it still lacks one bounded lane that says which alpha-readiness blocker will be
settled next and how success will be measured.

The concrete failure modes are:

1. The live queue can keep returning `repair_alpha_readiness` while implementation runs chase lower-order route or
   submit-gate work.
2. `H-MICRO-01` is the only lineage-ready lane, but it competes with `H-CONT-01` and `H-REV-01` in generic alpha
   readiness language.
3. Schema head is current, yet individual strategy-hypothesis lineage can still be missing or underfunded.
4. Empirical jobs can be stale or ineligible while source tables contain thousands of candidate specs and scores.
5. No-delta outcomes are visible in detailed receipts, but they are not the primary launch deny key for the next
   implementation run.
6. Deployer and verifier stages cannot prove revenue progress without reading several broad payloads by hand.

The system needs a conveyor that picks the next alpha lane, funds its missing receipts, records the business dividend,
and keeps capital at zero notional until the receipt is accepted.

## Alternatives Considered

### Option A: Repair Execution TCA And Route Universe First

This option would prioritize blocked and missing symbols from route reacquisition: repair NVDA, AMD, INTC, AVGO, then
create simulation probes for AMZN, GOOGL, and ORCL.

Advantages:

- Directly improves `fill_tca_or_slippage_quality`.
- Uses concrete route evidence with known blocked and missing symbols.
- Could increase the downstream route universe once alpha is eligible.

Disadvantages:

- It does not clear the top repair queue item.
- It cannot promote any route while alpha readiness has zero promotion-eligible hypotheses.
- It risks spending proof capacity on execution quality before a profitable hypothesis is eligible to route.
- It does not reduce `zero_notional_or_stale_evidence_rate` for the current alpha blocker.

Decision: reject as the next milestone. Keep it as the second lane after one alpha settlement receipt is accepted.

### Option B: Open Paper Or Live Submit Behind The Current Proof Floor

This option would treat `simple_submit_disabled` as the main blocker and focus on enabling paper canary or live
micro-canary once service dependencies are healthy.

Advantages:

- Shortens the path to observable trading execution.
- Tests capital controls end to end.
- Could surface execution slippage sooner.

Disadvantages:

- It weakens capital safety because proof floor is still `repair_only`.
- The accepted routeable candidate count is zero.
- Profitability evidence is stale or blocked, and two hypotheses have non-positive expectancy.
- The live business surface explicitly says `operating_rule=keep_live_submit_disabled_until_repair_queue_clears`.

Decision: reject. Capital remains zero until proof-floor and routeability receipts pass.

### Option C: Alpha-Readiness Settlement Conveyor

This option builds a Torghut-owned reducer and receipt family that converts the live alpha-readiness queue item into
one selected zero-notional settlement lane.

Advantages:

- Directly targets `routeable_candidate_count`, the live top value gate.
- Keeps trading-specific lane selection inside Torghut.
- Makes no-delta debt launch-deniable without hiding full diagnostic context.
- Gives engineer, verifier, and deployer stages a compact receipt to cite.
- Preserves capital safety because every settlement action carries `max_notional=0`.

Disadvantages:

- Adds a schema and tests.
- Can hold useful execution-quality work while alpha settlement is stale.
- Requires Jangar to consume a new compact proof reference.

Decision: select Option C.

## Architecture

Torghut emits `torghut.alpha-readiness-settlement-conveyor.v1` and
`torghut.alpha-readiness-settlement-receipt.v1`.

```text
torghut.alpha-readiness-settlement-conveyor.v1
  conveyor_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  source_commit
  active_revision
  account_id
  window
  trading_mode
  business_state
  selected_value_gate: routeable_candidate_count
  routeable_candidate_count_before
  accepted_routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  capital_rule: zero_notional_repair_only
  max_notional: "0"
  selected_lane
  lane_scores[]
  active_no_delta_leases[]
  required_receipts[]
  validation_commands[]
  rollback_target
```

```text
torghut.alpha-readiness-settlement-receipt.v1
  receipt_id
  conveyor_id
  hypothesis_id
  candidate_id
  strategy_id
  lane_id
  strategy_family
  settlement_state: paid | no_delta | blocked | stale | invalid
  routeable_candidate_count_before
  routeable_candidate_count_after
  measured_routeable_candidate_delta
  retired_reason_codes[]
  preserved_reason_codes[]
  new_reason_codes[]
  funded_receipts[]
  missing_receipts[]
  evidence_window_id
  evidence_window_state
  schema_lineage_state
  empirical_jobs_state
  post_cost_expectancy_state
  drift_state
  rejection_drag_state
  no_delta_release_key
  no_delta_release_conditions[]
  max_notional: "0"
```

The emitted `torghut.alpha-readiness-settlement-receipt.v1` is its own output receipt. When the receipt is present, its
schema is included in `funded_receipts[]` and must not appear in `missing_receipts[]`; otherwise the conveyor would
create an impossible self-dependency while real upstream receipts such as drift checks, feature replay, hypothesis
promotion, and capital replay remain unsettled.

### Conveyor State Machine

- `observing`: revenue repair is available, but the top queue item is not alpha readiness.
- `selecting`: top queue item is alpha readiness and a lane score can be computed.
- `settling`: the selected lane has missing receipts that can be produced under zero notional.
- `paid`: routeable candidate count increased or a selected hypothesis moved to promotion eligible.
- `no_delta`: the receipt preserved blockers and measured zero routeable-candidate delta.
- `quarantined`: evidence is stale, schema lineage is missing, no-delta lease is active, or capital notional is
  nonzero.

### Lane Scoring

The conveyor ranks lanes by expected revenue leverage and implementation safety:

1. Lineage-ready hypothesis before missing-lineage hypothesis.
2. Drift or feature evidence repair before post-cost non-positive repair.
3. Current TCA and market-session-compatible evidence before closed-session holds.
4. No active no-delta lease for the same release key.
5. Zero-notional repair action only.

Current evidence therefore selects `H-MICRO-01` first. It is the only lane with strategy-hypothesis lineage ready.
The implementation target is to settle drift or forecast evidence, schema-lineage escrow, stale empirical job
receipts, and promotion certificate state for `H-MICRO-01`, then re-evaluate routeable candidate count.

### Jangar Export

Torghut exposes a compact `torghut.alpha-readiness-settlement-conveyor-ref.v1` through
`/trading/consumer-evidence` and mirrors the full conveyor in `/trading/revenue-repair`.

The compact ref contains:

- `conveyor_id`
- `selected_hypothesis_id`
- `selected_value_gate`
- `settlement_state`
- `routeable_candidate_count_before`
- `routeable_candidate_count_after`
- `measured_routeable_candidate_delta`
- `active_no_delta_lease_count`
- `required_receipt`
- `validation_command`
- `max_notional`
- `rollback_target`

Jangar must treat a missing, stale, nonzero-notional, or unchanged no-delta ref as launch-deny evidence for material
Torghut repair dispatch.

## Implementation Scope

The next engineer milestone is bounded and production-grade:

1. Add `services/torghut/app/trading/alpha_readiness_settlement_conveyor.py`.
2. Consume the existing revenue-repair digest, alpha evidence foundry, alpha repair closure board, profit lease
   projection, routeability acceptance ledger, and route reacquisition board.
3. Emit full `torghut.alpha-readiness-settlement-conveyor.v1` on `/trading/revenue-repair`.
4. Emit compact `torghut.alpha-readiness-settlement-conveyor-ref.v1` on `/trading/consumer-evidence`, `/readyz`, and
   `/trading/health` where existing compact Torghut proof refs are mirrored.
5. Select `H-MICRO-01` first when the live evidence shape matches this document: lineage ready, drift/forecast or
   schema-lineage missing, zero promotion eligible, and `max_notional=0`.
6. Deny repeated settlement when the same no-delta release key is active and the source ref, evidence window, blocker
   set, and required receipt set are unchanged.
7. Add tests for paid dividend, no-delta dividend, stale conveyor, nonzero notional rejection, lane scoring, compact
   consumer evidence parity, and revenue-repair integration.

The implementation must not enable paper or live submission. It must not change broker credentials, Kubernetes
resources, database records, or capital limits outside the code path required to emit the receipt.

## Validation Gates

Local validation for the implementation PR:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
uv run --frozen pytest tests/test_alpha_evidence_foundry.py tests/test_alpha_repair_closure_board.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py -k "alpha or revenue_repair or consumer_evidence"
uv run --frozen python scripts/check_migration_graph.py
```

Post-merge verifier gates:

- Torghut image promotion PR merged with green `torghut-ci`.
- Argo `torghut`, `torghut-options`, and `symphony-torghut` are `Synced/Healthy`.
- Active `/trading/revenue-repair` includes `torghut.alpha-readiness-settlement-conveyor.v1`.
- `/trading/consumer-evidence` includes current compact conveyor ref.
- `max_notional` remains `0` and `live_submission_allowed=false`.
- The handoff names one of:
  - `routeable_candidate_count` increased above zero;
  - `zero_notional_or_stale_evidence_rate` reduced below `1.0`;
  - no-delta lease active with unchanged release key;
  - the smallest blocker preventing revenue impact.

## Rollout

1. Ship the reducer and compact export behind additive schema fields. No existing field is removed or renamed.
2. Keep capital and live submission unchanged.
3. Promote the Torghut image through the normal GitOps release flow.
4. Verify service health with `/db-check`, `/readyz`, `/trading/status`, `/trading/consumer-evidence`, and
   `/trading/revenue-repair`.
5. Publish the compact conveyor id and settlement state to the swarm ledger and NATS handoff.

## Rollback

Rollback is a source or image revert. The safety posture is simple:

- stop emitting `torghut.alpha-readiness-settlement-conveyor.v1`;
- remove the compact Jangar ref;
- keep `max_notional=0`;
- keep `simple_submit_disabled`;
- keep proof floor `repair_only`;
- continue using the existing revenue-repair digest and alpha evidence foundry.

Rollback is required if the conveyor emits nonzero notional, selects a lane when the top queue item is not alpha
readiness, hides an active no-delta lease, or makes `/trading/consumer-evidence` unavailable.

## Risks

- The conveyor can become another stale proof surface if freshness is not enforced. Mitigation: compact ref carries
  `fresh_until`, and Jangar denies stale refs.
- H-MICRO-01 may still settle no-delta because empirical and schema-lineage evidence remain underfunded. Mitigation:
  no-delta is a valid outcome and must block duplicate launch until the release key changes.
- Route TCA can still block capital after alpha readiness improves. Mitigation: the design names route repair as the
  second lane, not a discarded lane.
- Direct DB inspection is unavailable to this worker identity. Mitigation: implementation and verification use
  application-level database witnesses and schema-lineage receipts.
- Large integration files increase regression risk. Mitigation: implement the reducer in a new focused module and
  keep endpoint changes additive.

## Engineer Handoff

Build the conveyor first, not a submit-gate change. Use this design and the Jangar companion as the governing
requirement. The first production PR should make `H-MICRO-01` settlement explicit and testable under zero notional.
Acceptance is a current compact conveyor ref that selects `H-MICRO-01`, carries a required settlement receipt, and
does not change live submission or capital limits.

## Deployer Handoff

Do not claim revenue readiness from Argo health alone. After image promotion, prove:

- Argo and workloads are healthy;
- `/db-check` is current;
- `/readyz` remains degraded if proof floor is still repair-only;
- `/trading/revenue-repair` exposes the full conveyor;
- `/trading/consumer-evidence` exposes the compact conveyor ref;
- `max_notional=0` and live submit remains disabled unless a later design explicitly changes the capital gate.
