# 150. Torghut Repair Dividend Order Book And Capital Warrants (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting **a Torghut repair dividend order book that bids into Jangar capital warrants** as the next
profitability architecture step.

Torghut is safer than it was, but it is not making money. At `2026-05-07T12:23Z`, live `/trading/status` was
reachable, empirical jobs were fresh, Postgres and ClickHouse were healthy, Alpaca was active, and the live route was
running revision `torghut-00257`. The same payload correctly held capital at zero notional. The proof floor was
`repair_only`, live submit was disabled, execution TCA was stale from `2026-04-02`, average absolute slippage was
about `568.61` bps against an `8` bps guardrail, market context had no fresh timestamp, quant ingestion lag was more
than `18` hours, and all three hypotheses were shadow with `0` promotion eligible.

The simulation route was healthier at the HTTP layer but not capital-ready. Simulation `/readyz` returned HTTP `200`,
yet its proof floor was also `repair_only`, simulation quant latest metrics were empty, execution TCA exceeded the
slippage guardrail, and no hypothesis was promotion eligible.

The current proof floor already names repairs. That is necessary, but it is not enough. Torghut needs to price each
repair as a dividend: how much capital unlock it can plausibly create, which hypothesis benefits, which evidence will
prove closure, how long the repair remains fresh, and why the repair is safe at zero notional. Jangar then admits or
suppresses those bids as warrants.

The tradeoff is that Torghut gives up self-admission for repairs. I accept that. Profitability work should rank and
price the next repair, but the shared control plane should decide whether that repair is safe to run now.

## Runtime Objective And Success Metrics

Success means:

- Torghut emits a `repair_dividend_order_book` from `/trading/status` and `/trading/health`.
- Each `repair_dividend_quote` names `repair_code`, `repair_dimension`, `hypothesis_ids`, `account_label`,
  `torghut_revision`, `expected_capital_unlock`, `expected_after_cost_bps`, `confidence`, `fresh_until`,
  `zero_notional_required`, `validation_refs`, and `closure_receipt_requirements`.
- Quotes map directly to Jangar repair warrants.
- The order book distinguishes stale evidence from bad evidence. Stale TCA needs recomputation; TCA that breaches the
  guardrail needs hypothesis or execution policy repair.
- Paper stays closed until the corresponding Jangar warrant is closed and the proof floor moves out of `repair_only`.
- Live submit stays disabled until paper settlement, live gate, expected shortfall coverage, and rollback posture
  agree.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster Evidence

- `kubectl get pods -n torghut -o wide` showed `torghut-00257-deployment-5897cc7dc6-rgr4l` `2/2 Running` and
  `torghut-sim-00357-deployment-6d76597fff-wbsqg` `2/2 Running`.
- Torghut Postgres, both ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options enricher,
  websockets, exporters, Alloy, and Symphony were running.
- `kubectl get pods -n torghut --no-headers` counted `27 Running` and `5 Completed` pods.
- Recent Torghut events showed startup/readiness probe failures from older revisions that cleared.
- Recent Torghut events still showed duplicate ClickHouse PodDisruptionBudget matches, Keeper PDB `NoPods`, and
  FlinkDeployment status-modified warnings.
- Argo CD reported `torghut` as `Synced` and `Healthy` at revision `2d48027cca6e5d3f907222f129e38cff7617a9a9`.

### Trading Evidence

- Live `/readyz` returned HTTP 503 and `status=degraded`.
- Live `/db-check` returned HTTP 200 with current head `0029_whitepaper_embedding_dimension_4096`.
- Live `/trading/status` returned HTTP 200 with `mode=live`, `pipeline_mode=simple`, `running=true`,
  `submit_enabled=false`, active revision `torghut-00257`, and build commit
  `81b8231d014c94dc2c70173f35fb53bb279749cf`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, `capital_stage=shadow`.
- Live proof floor was `floor_state=repair_only`, `route_state=repair_only`, `capital_state=zero_notional`, and
  `max_notional=0`.
- Live proof blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`,
  and `simple_submit_disabled`.
- Live quant evidence was degraded: latest metrics were current, but ingestion lag was `67203` seconds and
  materialization was unhealthy.
- Live TCA had `13,775` orders, average absolute slippage `568.6138848199565249` bps, and stale
  `last_computed_at=2026-04-02T20:59:45.136640Z`.
- Empirical jobs were fresh and truthful for candidate `chip-paper-microbar-composite@execution-proof` on dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- The forecast service was degraded with `registry_empty`.
- Alpha readiness had `3` hypotheses, all `shadow`, `0` promotion eligible, and `3` rollback required.
- Simulation `/readyz` returned HTTP 200, but its proof floor was `repair_only`, simulation quant latest metrics were
  empty, and TCA average absolute slippage was `17.4301320928571429` bps against an `8` bps guardrail.

### Database And Data Evidence

- Runtime Postgres and ClickHouse dependency checks were `ok`.
- `/db-check` reported schema current, lineage ready, branch count `1`, and no duplicate revisions.
- `/db-check` retained historic parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Direct CNPG CRD listing for clusters, backups, and scheduled backups was RBAC-blocked in the `torghut` namespace.
- Because privileged database shell access is intentionally unavailable to this runner, capital-grade data validation
  should rely on typed runtime receipts plus migration/schema projections.

### Source Evidence

- `services/torghut/app/main.py` is `4145` lines and assembles route responses. New order-book logic should not live
  in this file.
- `services/torghut/app/trading/proof_floor.py` is `593` lines and already emits proof dimensions and a repair
  ladder.
- `services/torghut/app/trading/submission_council.py` is `1199` lines and owns live/paper admission checks.
- `services/torghut/app/trading/tca.py` is `815` lines and owns TCA metric persistence and aggregation.
- `services/torghut/app/trading/market_context.py` is `290` lines and owns market-context freshness evaluation.
- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and already enforces empirical freshness,
  truthfulness, dataset consistency, and candidate consistency.
- Focused tests already exist for proof floor, submission council, empirical jobs, feature quality, market context,
  forecast service, TCA adaptive policy, and strategy hypothesis governance.

## Problem

Torghut knows why capital is closed, but it does not yet rank repair work as a profit-seeking portfolio.

The failure modes are:

1. A repair ladder can name blockers without pricing which repair should run first.
2. Stale TCA and bad TCA require different work, but both currently appear as capital blockers.
3. Fresh empirical proof can coexist with stale market context, stale TCA, empty simulation latest metrics, and zero
   promotion-eligible hypotheses.
4. A repair can improve one surface without proving it unblocked any capital gate.
5. If Torghut self-admits repairs, it bypasses Jangar's view of schedule debt, watch health, runtime kits, rollout
   posture, and action SLO budgets.

## Alternatives Considered

### Option A: Keep The Current Proof-Floor Repair Ladder

Pros:

- Already visible in `/readyz`, `/trading/health`, and `/trading/status`.
- Keeps capital safe.
- Simple for operators to inspect.

Cons:

- Does not price expected after-cost dividend.
- Does not tell Jangar which repair to admit.
- Does not distinguish stale evidence repair from strategy rejection repair.

Decision: reject.

### Option B: Run All Repair Jobs On A Fixed Schedule

Pros:

- Easy to automate.
- Avoids ranking uncertainty.
- Can eventually refresh stale surfaces.

Cons:

- Adds schedule churn to an Agents namespace that already has Error history.
- Spends runtime on low-value repairs while high-value capital blockers remain.
- Produces evidence without a closure contract tied to capital gates.

Decision: reject.

### Option C: Emit A Repair Dividend Order Book

Pros:

- Converts every blocker into a priced repair quote.
- Keeps Torghut responsible for trading economics and Jangar responsible for control-plane admission.
- Gives engineer work a measurable expected capital unlock.
- Preserves zero-notional operation until the proof floor, observation epoch, and hypothesis readiness agree.
- Makes deployer gates auditable because a closed Jangar warrant can point back to a Torghut quote.

Cons:

- Requires careful calibration of `expected_after_cost_bps`.
- Requires a stable quote schema and test fixtures.
- Can still rank the wrong repair if evidence quality is poor.

Decision: select Option C.

## Architecture

Torghut adds a reducer outside `app/main.py`:

```text
repair_dividend_order_book
  generated_at
  account_label
  torghut_revision
  market_window
  proof_floor_ref
  convergence_epoch_ref
  quotes[]
  suppressed_quotes[]
```

Each quote has:

```text
repair_dividend_quote
  quote_id
  repair_code
  repair_dimension
  hypothesis_ids[]
  account_label
  torghut_revision
  source_receipts[]
  expected_capital_unlock
  expected_after_cost_bps
  confidence
  zero_notional_required
  max_runtime_seconds
  fresh_until
  validation_refs[]
  closure_receipt_requirements[]
  capital_gate_unblocked[]
```

Initial quote mappings:

- `repair_execution_tca_stale`: recompute TCA when `last_computed_at` is older than the proof threshold. Closure
  requires a fresh TCA timestamp, order count, average absolute slippage, and guardrail comparison.
- `repair_execution_tca_guardrail`: when TCA is fresh but slippage exceeds the guardrail, propose strategy,
  execution policy, or allocator repair instead of recomputation.
- `repair_market_context`: refresh market-context domains or emit a closed-session deferral receipt with the next
  market-open validation window.
- `repair_quant_ingestion`: repair ingestion lag for the live account before paper can open.
- `repair_quant_materialization`: repair latest-metric materialization for live metrics.
- `repair_quant_latest_store`: restore simulation latest metrics and stage rows before simulation paper receipts can
  be trusted.
- `repair_alpha_readiness`: clear hypothesis blockers only after required TCA, market-context, quant, and signal
  continuity receipts are current.
- `repair_forecast_registry`: load a calibrated forecast registry before forecast authority can influence capital.

The order book sorts by:

1. Capital gate unblocked: paper before live, live micro before live scale.
2. Expected after-cost dividend.
3. Evidence confidence.
4. Runtime budget.
5. Staleness age.

The first implementation may use deterministic scoring. A later implementation can learn the weights from realized
repair outcomes, but it must not let learned weights override hard guardrails.

## Validation Gates

Engineer acceptance gates:

- Add a pure `repair_dividend_order_book` reducer and keep route assembly in `app/main.py` thin.
- Add tests for stale live TCA, fresh-but-bad TCA, stale market context, empty simulation latest store, live quant
  ingestion lag, fresh empirical jobs, and zero promotion-eligible hypotheses.
- Add a fixture where the best quote is not the highest-priority proof-floor item because expected capital unlock is
  lower.
- Add a fixture where no quote is emitted because the source evidence is too stale or contradictory.
- `/trading/status` and `/trading/health` must expose quote IDs that Jangar can use as source refs.

Deployer acceptance gates:

- Do not use a quote as capital authority.
- Require a Jangar warrant before running repair work generated from a quote.
- Require the matching Jangar warrant closure and a fresh proof floor before paper opens.
- Keep live submit disabled until paper settlement and live gate validation pass.
- Roll back by hiding the order book and returning to the existing proof-floor repair ladder.

Suggested local validation:

```bash
cd services/torghut
uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_submission_council.py tests/test_empirical_jobs.py tests/test_market_context.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

## Rollout

Roll out in three phases:

1. `observe`: emit the order book without changing submission or repair scheduling.
2. `bid`: let Jangar ingest quotes and issue zero-notional repair warrants.
3. `settle`: require closed Jangar warrants and refreshed proof-floor receipts before paper exits `shadow_only`.

Live capital remains unchanged. The order book can prioritize live-readiness repairs, but it cannot open live submit.

## Rollback

Rollback is to stop emitting the order book and continue using the current proof floor, live submission gate,
empirical job health, market-context state, and submission council checks. Existing Jangar warrants sourced from
quotes should expire naturally. No broker state, Kubernetes object, or database row needs manual mutation for
rollback.

## Risks

- Dividend scoring can be wrong. Mitigation: use quotes only for repair priority, not capital authority.
- A stale quote can admit stale repair work. Mitigation: every quote has `fresh_until` and source receipt timestamps.
- TCA recomputation can hide a bad execution policy. Mitigation: distinguish stale TCA from fresh guardrail breach.
- Market-closed expected staleness can hide a real data gap. Mitigation: require an explicit closed-session deferral
  receipt and next-open validation.

## Handoff

Engineer handoff: implement the order-book reducer, quote schema, route exposure, and tests without growing
`app/main.py`. Use deterministic scoring first and keep quote IDs stable enough for Jangar warrant refs.

Deployer handoff: treat quotes as economic priority only. Capital remains zero notional until Jangar closes the
matching warrant, Torghut proof floor exits `repair_only`, paper settlement exists, live submit remains gated, and
expected shortfall evidence is current.
