# 126. Torghut Hypothesis Custody Ledger And Data-Cost Profit Reserve (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

Torghut will publish a **hypothesis custody ledger** and **data-cost profit reserve** before Jangar spends repair
capacity on Torghut profit proof or allows capital to move out of shadow.

The current runtime is operational but not capital-ready. At `2026-05-06T15:30Z`, `/healthz` returned OK, Postgres,
ClickHouse, Alpaca, and the Jangar universe dependency were healthy, and the scheduler was running. The database
schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`. The options lane was active, with about
`2.39M` option contracts, `6028` subscription rows, and watermarks updated within the sample window.

The profitable path is still blocked. `/trading/health` was degraded, live submission was blocked by
`simple_submit_disabled`, capital stage was `shadow`, empirical jobs were stale from `2026-03-21`, and typed quant
health was not configured. Direct bounded database reads showed `147606` trade decisions through
`2026-05-04T17:25:57.901Z` and `13778` executions through `2026-04-02T20:59:45.104Z`, but the governance tables that
should bind hypotheses to promotion state were empty: `strategy_hypotheses=0`,
`strategy_hypothesis_metric_windows=0`, `strategy_promotion_decisions=0`, and `autoresearch_epochs=0`. Only
`vnext_empirical_job_runs` had rows, with `16`.

The selected design makes Torghut prove custody before it bids for repair capacity. A hypothesis can be attractive in
runtime config or historical reports, but Jangar should not admit capital repair unless Torghut can name the
hypothesis, account, proof window, data cost, stale proof, execution/TCA recency, and rollback state in one compact
ledger entry.

The tradeoff is slower paper reentry. I accept that. Profit improves when Torghut spends scarce repair and data-plane
capacity on the next measured edge, not when stale or split-brain evidence is treated as fresh authority.

## Runtime Objective And Success Metrics

This contract increases Torghut profitability by making profit work measurable and accountable before it consumes
Jangar control-plane capacity.

Success means:

- Every active runtime hypothesis has a current custody-ledger row or is explicitly excluded from capital repair.
- Data-cost reserve bids include options catalog pressure, query cost, empirical freshness, execution/TCA recency, and
  expected post-cost profit unlock.
- Jangar can consume one bounded Torghut projection instead of scanning Torghut tables or calling heavy status routes.
- Capital remains shadow-only until custody parity, Jangar pressure, Jangar material-action verdict, empirical proof,
  local submission gate, and execution realism agree.
- Engineer and deployer stages have concrete tests for the current degraded state.

## Evidence Snapshot

All evidence was collected read-only with respect to database records, trading flags, broker state, Kubernetes
resources, and GitOps resources.

### Cluster And Runtime Evidence

- The active Torghut live revision was serving and `/healthz` returned `{"status":"ok","service":"torghut"}`.
- Torghut deployments for live/sim, live TA, sim TA, options TA, options catalog, options enricher, websocket
  services, ClickHouse guardrails, LLM guardrails, Alloy, and Symphony were available during the sample.
- Recent events still showed readiness/startup churn on live/sim revisions, options catalog/enricher, and
  `torghut-ws-options`.
- Recent events also showed duplicate ClickHouse PDB matches and Flink status conflicts on live and options TA.
- `/trading/health` returned `status=degraded`; Postgres, ClickHouse, Alpaca, universe, and readiness cache were OK.
- Live submission gate was blocked with `reason=simple_submit_disabled`, `capital_stage=shadow`,
  `configured_live_promotion=false`, and `promotion_eligible_total=0`.
- Empirical jobs dependency was degraded with authority `blocked`.
- Quant evidence was not configured for the live submission path.

### Database And Schema Evidence

- Direct Torghut SQL connected to `current_database=torghut` as `torghut_app`, with `pg_is_in_recovery=false`.
- Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- Exact bounded counts showed:
  - `trade_decisions=147606`, latest decision `2026-05-04T17:25:57.901Z`;
  - `executions=13778`, latest execution `2026-04-02T20:59:45.104Z`;
  - `strategy_hypotheses=0`;
  - `strategy_hypothesis_metric_windows=0`;
  - `strategy_promotion_decisions=0`;
  - `autoresearch_epochs=0`;
  - `vnext_empirical_job_runs=16`.
- PostgreSQL stats for `trade_decisions` and `executions` reported `n_live_tup=0` and no analyze timestamps despite
  exact nonzero counts. Runtime proof should not rely on stale catalog stats for capital decisions.
- Options tables were active:
  - `torghut_options_contract_catalog` estimated `2388490` rows;
  - `torghut_options_subscription_state` estimated `6028` rows;
  - `max(last_ranked_ts)=2026-05-06T15:27:13.809Z`;
  - `max(last_success_ts)` in options watermarks was `2026-05-06T15:28:51.219Z`.

### Source Evidence

- `services/torghut/app/main.py` is `4051` lines and owns status, health, empirical jobs, runtime profitability, and
  submission surfaces.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already combines empirical readiness,
  dependency quorum, hypothesis runtime state, typed quant health, capital stage, and trading toggles.
- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and represents empirical job truthfulness, freshness,
  candidate ids, dataset refs, artifacts, and promotion authority eligibility.
- `services/torghut/app/options_lane/catalog_service.py` is `334` lines and is now part of the profit runway because
  options data freshness and route cost affect repair priority.
- Tests exist for empirical jobs, submission council, options lane, hypothesis governance migration, profitability
  evidence, order firewall, and runtime windows. The missing regression is custody parity: runtime hypotheses, DB
  governance rows, empirical jobs, and capital bids must agree before paper or live repair is admitted.

## Problem

Torghut has three evidence planes that do not yet settle into one custody record:

1. runtime status and config can describe trading mode and submission gates;
2. PostgreSQL contains decisions, executions, empirical job rows, and empty governance ledgers;
3. options and market data planes produce fresh operational data with real query and route cost.

Those surfaces are useful individually. They are not sufficient for capital reentry. The current state proves the
point: the system has many historical decisions and executions, fresh options data, and current schema, but no
populated hypothesis-governance ledger and no fresh empirical proof. Capital should remain shadow-only, and the next
repair should be selected by custody-confirmed expected value rather than by local optimism.

## Alternatives Considered

### Option A: Use Runtime Hypothesis Registry As Authority

Torghut treats the runtime registry and submission council output as the active hypothesis authority. Database rows are
supporting evidence only.

Pros:

- Fastest path to bid generation.
- Avoids backfilling empty governance tables.
- Keeps logic close to the current submission council.

Cons:

- Does not resolve DB/runtime split brain.
- Makes audits depend on ephemeral config and route output.
- Lets capital repair proceed while promotion tables are empty.
- Forces Jangar to trust a local surface it cannot independently reconcile.

Decision: reject as authority.

### Option B: Require Full Database Governance Before Any Repair

Torghut blocks all proof-renewal and paper-reentry work until the governance tables are fully populated and backfilled.

Pros:

- Strong audit posture.
- Clear database source of truth.
- Easy fail-closed behavior.

Cons:

- Delays zero-notional proof renewal even when repair would be safe.
- Treats all missing governance rows as equally blocking.
- Does not use current runtime evidence or data-cost facts to rank backfill.

Decision: reject as too blunt. It blocks useful shadow repair that could produce the evidence needed for governance.

### Option C: Hypothesis Custody Ledger And Data-Cost Profit Reserve

Torghut emits a compact custody ledger that binds runtime hypotheses to database evidence and names whether each
hypothesis is eligible for repair, paper measurement, live micro-canary, or exclusion. It also emits a data-cost profit
reserve bid that prices stale proof, options data pressure, query cost, and expected profit unlock. Jangar consumes the
reserve through the companion pressure governor.

Pros:

- Settles runtime and database authority before capital moves.
- Lets zero-notional repair proceed without pretending capital is ready.
- Gives Jangar one bounded projection to consume.
- Prices options and database cost alongside profit.
- Creates clear rollback and audit records.

Cons:

- Adds two projections.
- Requires a first backfill or runtime-to-ledger materialization step.
- Makes paper reentry wait for custody parity even when local scores look attractive.

Decision: select Option C.

## Architecture

Torghut adds a `hypothesis_custody_ledger` projection.

```text
hypothesis_custody_ledger
  ledger_id
  generated_at
  expires_at
  schema_head
  runtime_registry_digest
  db_governance_digest
  custody_decision                 # current, shadow_only, repair_only, excluded, blocked
  hypotheses
```

Each hypothesis custody item is explicit.

```text
hypothesis_custody_item
  hypothesis_id
  strategy_family
  candidate_id
  account
  active_in_runtime
  present_in_db
  latest_metric_window_ref
  latest_promotion_decision_ref
  latest_empirical_job_refs
  latest_decision_at
  latest_execution_at
  latest_tca_at
  capital_stage
  custody_decision                 # current, shadow_only, repair_only, excluded, blocked
  reason_codes
  rollback_required
```

Torghut also adds a `data_cost_profit_reserve` projection.

```text
data_cost_profit_reserve
  reserve_id
  generated_at
  expires_at
  jangar_pressure_epoch_ref
  custody_ledger_ref
  options_data_state_ref
  empirical_jobs_ref
  execution_realism_ref
  query_cost_budget
  route_cost_budget
  bids
```

Each bid is a repair request, not capital permission.

```text
data_cost_profit_reserve_bid
  bid_id
  hypothesis_id
  requested_action_class           # proof_repair, paper_canary, live_micro_canary, live_scale
  missing_or_stale_proof_refs
  options_data_required
  expected_profit_unlock_bps
  expected_profit_confidence
  estimated_query_cost_units
  estimated_route_cost_units
  max_artifact_cost_usd
  required_sample_count
  max_allowed_slippage_bps
  decision                         # propose, hold, withdraw
  reason_codes
```

## Capital Guardrails

Torghut paper or live capital remains shadow-only until all of these are true:

- Jangar material-action verdict allows the matching action class.
- Jangar pressure epoch is no worse than `throttle` for Torghut profit proof and `allow` for the capital rung.
- `hypothesis_custody_ledger` is current and the target hypothesis is present in runtime and DB custody.
- Empirical jobs are fresh or have a current Jangar-admitted renewal settlement.
- Typed quant health is configured when required for the account/window.
- Latest decisions, executions, and TCA samples are inside the configured freshness window.
- Live submission is not blocked by `simple_submit_disabled`.
- Options data cost is accounted for when the strategy depends on options data.
- No rollback-required state is active for the target capital rung.

## Implementation Scope

Engineer stage:

1. Add a pure custody compiler that reads runtime hypothesis summaries, DB governance rows, empirical jobs, recent
   decisions/executions, and options data state.
2. Add a bounded `/trading/hypothesis-custody` or equivalent projection route for Jangar.
3. Add data-cost profit reserve generation from custody items, empirical stale proof, options freshness, and route cost.
4. Keep the reserve in shadow until Jangar pressure epochs are available.
5. Add tests for the current state:
   - decisions and executions exist but governance tables are empty;
   - empirical jobs are stale;
   - options watermarks are fresh but startup/readiness churn exists;
   - live submission is disabled;
   - reserve bids are `hold` or `proof_repair`, never paper/live capital.

Deployer stage:

1. Roll out custody ledger in observe mode.
2. Verify runtime and DB custody parity for at least one scheduling cycle.
3. Enable proof-repair reserve bids only after Jangar pressure governor shadow output is stable.
4. Keep paper/live capital blocked until the full guardrail list passes.

## Validation Gates

Local validation before merge:

- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pytest services/torghut/tests/test_empirical_jobs.py`
- `uv run --frozen pytest services/torghut/tests/test_options_lane.py`
- `uv run --frozen pytest services/torghut/tests/test_strategy_hypothesis_governance_migration.py`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.alpha.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.scripts.json`

Runtime validation after rollout:

- Custody route returns current schema head and a non-empty `reason_codes` list when DB governance rows are absent.
- Current state produces `shadow_only` or `repair_only`, not paper/live allow.
- Reserve bids name expected query cost, route cost, stale proof refs, and Jangar pressure refs.
- Options data freshness is visible without scanning the full options catalog from Jangar.
- Live submission remains blocked while `simple_submit_disabled` is present.

## Rollout Plan

1. Add custody ledger projection in observe mode.
2. Add data-cost reserve projection in observe mode.
3. Teach Jangar pressure governor to read the projection without enforcing it.
4. Enable proof-repair reserve bids after one stable cycle.
5. Enable paper canary only after custody parity, fresh empirical proof, execution realism, and Jangar pressure gates
   pass.

## Rollback Plan

- If custody projection fails, keep Torghut capital in shadow and fall back to current empirical-job degraded status.
- If reserve bids overstate profit, mark bids `withdraw` and keep proof repair manual.
- If the route is slow or costly, disable Jangar consumption and keep local projection for debugging.
- If paper/live capital is accidentally admitted, immediately force custody decision to `blocked`, leave
  `simple_submit_disabled` in place, and revert the reserve consumer PR.
- Do not mutate or drop governance tables during incident rollback.

## Risks

- Custody materialization can expose drift between runtime registry and database state. Treat that as useful evidence,
  not as a reason to bypass custody.
- Options data can look fresh while strategy-specific proof is stale. Reserve bids must distinguish data freshness from
  profit authority.
- Stale PostgreSQL statistics can mislead dashboards. Use exact bounded counts or ledger-maintained counters for
  capital gates.
- Jangar pressure can throttle profitable repairs during platform churn. That is intentional; capital safety depends on
  control-plane stability.

## Handoff

Engineer acceptance gates:

- Current-state fixture with `147606` decisions, `13778` executions, empty hypothesis governance tables, and stale
  empirical jobs emits custody decision `shadow_only` or `repair_only`.
- A fixture with fresh empirical jobs but missing DB custody still does not allow paper/live capital.
- A fixture with options freshness but high query-cost reserve holds broad options-dependent repair.
- Reserve tests prove every bid includes expected profit, query cost, route cost, stale proof refs, and rollback target.

Deployer acceptance gates:

- Custody projection is current for one scheduling cycle.
- Jangar pressure projection cites the Torghut custody/reserve refs before any enforcement.
- Paper canary remains blocked until custody parity and empirical proof freshness are both present.
- Live capital remains blocked while `simple_submit_disabled` or rollback-required state is present.
