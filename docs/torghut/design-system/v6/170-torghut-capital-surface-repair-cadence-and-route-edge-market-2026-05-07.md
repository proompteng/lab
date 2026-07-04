# 170. Torghut Capital Surface Repair Cadence And Route Edge Market (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting a capital-surface repair cadence and route edge market as Torghut's next profitability architecture
step.

The current runtime is safer than the initial NATS soak, but it is not capital-ready. Torghut live and sim pods are
running on the promoted image, database schema is current, Postgres and ClickHouse health checks pass, Alpaca reports
the live account active, and empirical jobs are now fresh. At the same time, `/readyz` and `/trading/health` are
degraded, live submission is disabled, proof floor is `repair_only`, capital is `zero_notional`, quant stage receipts
are missing, market context is stale, alpha readiness has zero promotion-eligible hypotheses, and execution TCA still
shows the route universe is incomplete.

The next profitable step is not to open paper faster. It is to price and sequence the repairs that can create a
routeable edge while capital stays closed. Torghut should publish a `capital_surface_repair_cadence` and a
`route_edge_market`. These objects rank no-notional repair work by expected unblock value, require before/after
receipts, and keep paper/live surfaces closed until the route edge, stage receipts, market context, alpha readiness,
and Jangar authority-surface all converge.

The tradeoff is that some repairs may make the system visibly healthier without opening paper. That is deliberate.
Profitability requires a verified edge, not a prettier degraded status page.

## Runtime Objective And Success Metrics

Success means:

- `/readyz`, `/trading/health`, and `/trading/status` expose `capital_surface_repair_cadence` and
  `route_edge_market`.
- Every repair candidate has a capital surface, expected unblock value, receipt requirements, cooldown policy, and
  rollback target.
- Fresh empirical jobs and fresh latest metrics can improve a repair score, but they cannot grant paper when stage
  receipts, route edge, market context, alpha readiness, or live-submit gates are missing.
- A route edge is not `routeable` until the symbol has current TCA under the active guardrail, non-stale market
  context where required, matching stage receipts, and a Jangar-admitted capital surface.
- Symbols with TCA above guardrail can enter `probe_repair`; symbols missing TCA enter `data_bootstrap`; neither can
  receive paper or live notional.
- Paper candidate requires at least two route-edge symbols, stage coverage, fresh market context, promotion-eligible
  alpha readiness, empirical truthfulness, and no unresolved Jangar repair-cadence hold.
- Live micro candidate additionally requires live submit enabled, zero rollback-required alpha hypotheses, current
  TCA, route provenance coverage at or above 95 percent, and a successful paper receipt window.
- Deployer output can explain any no-go with one repair cadence ID, one route edge market ID, and finite reason codes.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 between 22:08Z and 22:11Z. I did not mutate Kubernetes resources,
database records, ClickHouse tables, GitOps resources, AgentRun objects, broker state, empirical artifacts, or trading
flags.

### Cluster And Rollout Evidence

- The branch was `codex/swarm-torghut-quant-discover`, based on `main` at
  `068aec918 chore(torghut): promote image 70b00284 (#5971)`.
- Torghut live revision `torghut-00285` and simulation revision `torghut-sim-00385` were `2/2 Running`.
- `torghut-options-catalog`, `torghut-options-enricher`, `torghut-ta`, `torghut-ta-sim`, options TA, ClickHouse,
  Keeper, Postgres, guardrail exporters, websocket services, and Symphony Torghut were running.
- Recent Torghut events still showed startup and readiness probe failures during rollout, options readiness probe
  failures during replacement, an etcd status update timeout, and a retained
  `torghut-whitepaper-autoresearch-profit-target-8r6w6` Error pod.
- The latest Torghut deployment image observed in Kubernetes was
  `registry.ide-newton.ts.net/lab/torghut@sha256:65eed94f51fc8aa5159d52a424413188e63a14fcc217a5307b73f9a625a4d7a4`.
- Jangar and Agents were serving. Agents controllers were `2/2` ready, but recent readiness probe timeouts were still
  visible in Agents events.

### Database And Data Evidence

- `/db-check` returned `ok=true` at `2026-05-07T22:10:45.734973+00:00`.
- Current and expected Alembic heads were both `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready with one graph root, no duplicate revisions, no orphan parents, and known parent-fork
  warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Account-scope checks were bypassed because `trading_multi_account_enabled` is false.
- Direct database inspection was blocked by RBAC:
  `clusters.postgresql.cnpg.io is forbidden` and `pods/exec is forbidden` for the `agents-sa` service account.
- Torghut typed health endpoints therefore act as the database and data witnesses for this pass.
- `/readyz` reported Postgres `ok`, ClickHouse `ok`, Alpaca live account `PA3SX7FYNUTF` active, and Jangar universe
  fresh with eight symbols.
- Jangar quant evidence had `latest_metrics_count=144`, updated at `2026-05-07T22:10:25.550Z`, with
  `metrics_pipeline_lag_seconds=6`, but `stage_count=0` and reason `quant_pipeline_stages_missing`.
- Empirical jobs were healthy with all four required job types eligible and fresh:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.

### Trading Evidence

- `/readyz` and `/trading/health` returned `status=degraded`.
- Scheduler was running and startup grace was inactive.
- Live submission gate was closed with `simple_submit_disabled`.
- Proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Blocking reasons were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`,
  `market_context_stale`, and `simple_submit_disabled`.
- Alpha readiness had three hypotheses: one blocked, two shadow, zero promotion eligible, and three rollback required.
- Market context state was stale with no last freshness seconds or domain states in the proof-floor source reference.
- Execution TCA had 7334 orders and 7245 filled executions.
- TCA was recomputed at `2026-05-07T14:23:43.480686Z`, but the latest execution base was
  `2026-04-02T19:00:29.586040Z`.
- Average absolute slippage was `13.8203637593029676` bps against an `8` bps guardrail.
- The route book listed AAPL as probing because it passed one route check but still lacked dependency receipts.
- AMD, AVGO, INTC, and NVDA were blocked by route universe incompleteness. AMZN, GOOGL, and ORCL were missing TCA
  symbol evidence.
- TCA detail showed AAPL at `9.2512103573044345` bps, AMD at `14.933309365549806` bps, AVGO at
  `21.8582812794280608` bps, INTC at `20.5710872857575758` bps, and NVDA at `13.4758535356493902` bps.

### Source Evidence

- `services/torghut/app/main.py` is 4188 lines and assembles readiness, health, trading status, proof floor, metrics,
  whitepaper, and API surfaces.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4413 lines and remains the high-risk decision pipeline.
- `services/torghut/app/trading/proof_floor.py` is 701 lines, `route_reacquisition.py` is 374 lines, and `tca.py` is
  972 lines.
- The trading package has 127 Python modules and the service has 145 test files.
- Existing tests cover proof-floor blockers, empirical jobs, hypothesis readiness, promotion truthfulness, TCA, and
  route metadata. The missing contract is the market that reconciles a probing symbol, missing symbols, fresh
  empirical jobs, stale market context, empty stage receipts, and no-notional capital into one repair cadence.

## Problem

Torghut now has a mixed state that is easy to misread:

1. The latest rollout is healthy enough to serve requests.
2. Database schema is current.
3. Empirical jobs are fresh.
4. Latest quant metrics are fresh.
5. Capital is still zero notional because route edge, market context, alpha readiness, stage receipts, and live submit
   do not pass.

If Torghut treats the first four facts as a paper candidate, it will trade without a verified route edge. If it treats
all degraded states as the same, it will waste repair work. The missing object is a repair market that says which
evidence debt is worth paying first and what receipt is required before the next surface opens.

## Alternatives Considered

### Option A: Refresh Market Context And Recheck Existing Gates

Pros:

- Directly addresses one current blocker.
- Smallest operational action.
- Keeps capital closed during refresh.

Cons:

- It does not repair missing quant stage receipts.
- It does not create TCA for AMZN, GOOGL, or ORCL.
- It does not bring blocked symbols under the slippage guardrail.
- It does not clear alpha readiness rollback requirements.

Decision: reject as the architecture default. It remains one repair class in the selected market.

### Option B: Open Paper On The AAPL Probe

Pros:

- AAPL has the strongest route evidence in the current book.
- Paper feedback would create fresher execution observations.
- It would make the system feel closer to profit generation.

Cons:

- AAPL average absolute slippage is still above the 8 bps guardrail.
- Market context and quant stage receipts are missing.
- Alpha readiness has no promotion-eligible hypothesis.
- Live submit is disabled and capital is explicitly zero notional.

Decision: reject. A probing symbol is not a paper symbol.

### Option C: Rank No-Notional Repairs By Expected Route Edge

Pros:

- Keeps capital closed while producing useful before/after evidence.
- Separates route-edge repair from generic freshness repair.
- Gives each repair a measurable expected unblock value.
- Aligns Torghut output with Jangar capital-surface admission.

Cons:

- Adds a reducer and status schema.
- Requires repair jobs to return structured receipts.
- May leave capital closed after apparently successful repairs.

Decision: select Option C.

## Architecture

Add a pure `capital_surface_repair_cadence` reducer and a `route_edge_market` reducer under
`services/torghut/app/trading/`. The reducers must not perform network calls or database writes. The HTTP assembly
layer passes in already collected proof-floor, route-reacquisition, TCA, empirical, quant-evidence, market-context,
alpha-readiness, submission-gate, and Jangar repair-cadence evidence.

`CapitalSurfaceRepairCadence` fields:

- `cadence_id`
- `generated_at`
- `fresh_until`
- `account_label`
- `trading_mode`
- `active_revision`
- `jangar_repair_cadence_ledger_id`
- `capital_surface`
- `admission_decision`
- `reason_codes`
- `repair_candidates`
- `cooldown_until`
- `next_widening_gate`
- `rollback_target`

`RouteEdgeMarket` fields:

- `market_id`
- `generated_at`
- `account_label`
- `scope_symbols`
- `route_edge_state`
- `symbol_books`
- `portfolio_candidate_count`
- `expected_unblock_value`
- `required_receipts`
- `paper_candidate_symbols`
- `blocked_symbols`
- `missing_symbols`

Symbol states:

- `route_edge`: TCA current, slippage under guardrail, required market context fresh, stage receipt present, and
  Jangar capital surface at least `paper_candidate`.
- `probe_repair`: partial evidence exists, but one or more route-edge conditions are missing.
- `data_bootstrap`: no usable TCA or route provenance exists for the symbol.
- `blocked`: a hard blocker exists, such as slippage above guardrail or alpha readiness unavailable.
- `retired`: the symbol should be removed from the active proof universe until a future candidate review.

Initial repair scoring for the current state:

- `materialize_quant_stage_receipts`: high priority because latest metrics are fresh but stage count is zero.
- `refresh_market_context_domains`: high priority because market-context stale blocks proof floor and event-reversion.
- `route_edge_probe:AAPL`: bounded probe repair only, because AAPL has evidence but remains above guardrail and lacks
  dependency receipts.
- `route_edge_bootstrap:AMZN,GOOGL,ORCL`: data bootstrap, because TCA symbol evidence is missing.
- `slippage_repair:NVDA,AMD,INTC,AVGO`: blocked-to-probe repair, because evidence exists but slippage is above
  guardrail.
- `alpha_readiness_clearance:H-CONT-01,H-MICRO-01,H-REV-01`: required before any paper surface.

## Validation Gates

Engineer acceptance:

- Unit tests cover the current evidence shape: fresh empirical jobs, fresh latest metrics, empty stage receipts,
  stale market context, zero promotion-eligible hypotheses, AAPL probing, four blocked symbols, three missing symbols,
  live submit disabled, and zero-notional capital.
- The reducers are pure and deterministic.
- Fresh empirical jobs never override route-edge or stage receipt blockers.
- A probing symbol never appears in `paper_candidate_symbols`.
- Any routeable/probing contradiction creates a finite reason code.
- Missing direct DB access is represented as an evidence-access warning, not as a capital pass.

Deployer acceptance:

- `/readyz`, `/trading/health`, and `/trading/status` return the new objects after rollout.
- Current production state still reports `capital_surface=no_notional_repair` or stricter.
- Paper and live remain held until all acceptance gates in this document pass.
- Every admitted repair job emits before/after receipts and a next action.
- If a repair job fails, the cadence enters cooldown instead of immediate repeat dispatch.

Suggested local checks for the implementation PR:

- `uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_route_reacquisition.py`
- `uv run --frozen pytest tests/test_empirical_jobs.py tests/test_hypotheses.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

## Rollout Plan

1. Add reducers and tests without changing capital decisions.
2. Expose the objects as additive fields on status and readiness.
3. Observe one repair cadence with paper/live still held.
4. Allow no-notional repair jobs only when Jangar admits the matching repair class.
5. Require before/after receipts before changing any symbol from `probe_repair` or `data_bootstrap` to `route_edge`.
6. Open paper only through a later PR after the paper candidate gates pass and deployer evidence is current.

## Rollback Plan

Rollback is source/GitOps based.

- If the new objects misclassify capital as wider than current proof floor, disable their consumers and keep existing
  proof-floor decisions authoritative.
- If status latency or payload size regresses, remove the additive fields while leaving proof-floor and route book
  output unchanged.
- If a repair class runs without receipts, turn off repair admission and keep all surfaces at observe or hold.
- Capital rollback target remains `capital_state=zero_notional`, `live_submit_enabled=false`, and no paper notional.

## Risks

- Direct table-level inspection is blocked by RBAC. The smallest unblocker is read-only CNPG and ClickHouse access or
  a typed data-witness endpoint that returns table freshness, row counts, and consistency checks.
- Fresh empirical jobs can create false confidence if stage receipts stay empty.
- TCA was recomputed today, but the latest execution base is from 2026-04-02. The market must distinguish computed
  freshness from source-event freshness.
- AAPL is tempting because it is closest to repair, but it is still above the active slippage guardrail.
- More status fields can become noise unless deployer output cites one cadence ID and finite reason codes.

## Handoff Contract

Engineer stage:

- Implement `capital_surface_repair_cadence` and `route_edge_market` as pure reducers.
- Add focused tests for the exact current evidence shape.
- Expose additive status fields without widening capital.
- Add typed reason codes for missing quant stages, market-context stale, route-edge probe, route-edge bootstrap,
  slippage above guardrail, alpha readiness blocked, live submit disabled, and database witness access unavailable.

Deployer stage:

- Verify current rollout remains zero notional after the additive fields ship.
- Verify no-notional repair can run only with Jangar repair-cadence admission.
- Verify paper/live are still held in the current state.
- Roll back by source/GitOps revert if any capital surface is wider than this document allows.
