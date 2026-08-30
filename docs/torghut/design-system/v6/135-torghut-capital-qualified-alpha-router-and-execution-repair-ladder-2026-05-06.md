# 135. Torghut Capital-Qualified Alpha Router And Execution Repair Ladder (2026-05-06)

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

I am selecting a **capital-qualified alpha router with an execution repair ladder** as Torghut's next quant
architecture step.

The current system is producing useful observations, but it is not qualified to spend capital. On the read-only sample
from `2026-05-06T21:10Z`, live Torghut was serving revision `torghut-00244`, sim was serving `torghut-sim-00344`,
Postgres and ClickHouse route checks were OK, Alpaca broker status was OK, the schema was current at
`0029_whitepaper_embedding_dimension_4096`, and empirical jobs were fresh for
`chip-paper-microbar-composite@execution-proof`. Jangar dependency quorum was `allow`.

The profit blockers are specific. Live submission was closed with `simple_submit_disabled`, capital stage `shadow`,
and `promotion_eligible_total=0`. The hypothesis registry loaded three hypotheses; one was blocked and two were
shadow, with blocker reasons including `signal_lag_exceeded`, `market_context_stale`, `drift_checks_missing`,
`feature_rows_missing`, and `required_feature_set_unavailable`. Quant latest metrics were non-empty and compute was
fresh, but ingestion lag was about `12369` seconds and materialization was unhealthy. Market context was stale across
technicals, fundamentals, news, and regime. TCA settlement was stale from `2026-04-02T20:59:45Z`, with
`13775` orders and average absolute slippage around `568.6` bps. Recent decisions on `2026-05-06` were blocked before
submission, while sampled executions were from April.

The selected design refuses to choose a strategy by raw signal score until the strategy is capital-qualified for the
current account and market window. Torghut should rank alpha candidates by expected edge only after Jangar capital
qualification, quant ingestion freshness, market context freshness, execution/TCA recency, feature coverage, and
empirical proof all clear. Until then, the router emits zero-notional repair intents. The repair ladder ranks the next
work by expected unblock value: fix quant ingestion first when signal lag blocks every hypothesis, refresh market
context when event/reversal lanes are stale, replay TCA when execution proof is old, and backfill feature/drift proof
when one hypothesis is closest to promotion.

The tradeoff is slower paper reentry. I accept that because Torghut does not need more unqualified blocked decisions.
It needs a router that knows whether an alpha is allowed to receive capital at all.

## Runtime Objective And Success Metrics

This contract increases profitability by separating alpha discovery from capital qualification and by making execution
repair a first-class prerequisite for paper or live canaries.

Success means:

- Every candidate strategy receives a capital qualification state before paper or live sizing is considered.
- The alpha router can emit `observe_only`, `repair_only`, `paper_candidate`, `live_micro_candidate`, or
  `live_scale_candidate`.
- `repair_only` actions always carry max notional `0`.
- Quant ingestion lag, market-context staleness, stale TCA, missing feature rows, missing drift checks, and
  non-promotion-eligible hypotheses become ranked repair ladder rungs.
- Fresh empirical jobs can increase repair priority but cannot authorize paper or live capital without fresh execution
  settlement and market context.
- Paper canary admission requires current Jangar capital qualification receipt, quant ingestion under threshold,
  market-context freshness, TCA replay for the current session or previous full trading day, and at least one
  hypothesis with complete feature and drift proof.
- Live micro canary admission additionally requires paper outcome receipts, slippage within guardrail, active rollback
  target, and no open broker/account anomalies.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, ClickHouse tables, or empirical artifacts.

### Cluster And Runtime Evidence

- Torghut live `torghut-00244-deployment-556cc5c594-4kjls` was `2/2 Running`.
- Torghut sim `torghut-sim-00344-deployment-68787fcc66-rmdp5` was `2/2 Running`.
- TA, sim TA, options TA, options catalog, options enricher, websocket services, ClickHouse, Keeper, Postgres,
  guardrail exporters, Alloy, and Symphony were running.
- Jangar `jangar-54d5b66746-c28hw` was `2/2 Running`, and control-plane status reported controller and runtime quorum
  healthy.
- Recent Torghut events showed the live revision scaling from `torghut-00243` to `torghut-00244`, transient readiness
  failures on old or warming pods, and repeated ClickHouse `MultiplePodDisruptionBudgets` warnings.
- Agents events showed transient readiness timeouts on the agents API and both controller pods even though the pods
  were running at sample time.
- RBAC blocked node listing, Knative service listing, statefulset listing, Secret listing, and pod exec. Runtime
  validation must use routes and projected receipts, not privileged direct inspection.

### Route And Control-Plane Evidence

- Jangar `/health` returned HTTP `200`.
- Jangar `/api/agents/control-plane/status?namespace=agents` returned dependency quorum `allow` at
  `2026-05-06T21:10:58Z`.
- Torghut `/healthz` returned HTTP `200`.
- Torghut `/readyz` returned a degraded payload: scheduler OK, Postgres OK, ClickHouse OK, Alpaca OK, database OK,
  universe OK, empirical jobs OK, but live submission gate not OK because `simple_submit_disabled`.
- Torghut `/trading/status` reported `mode=live`, active revision `torghut-00244`, capital stage `shadow`,
  `configured_live_promotion=false`, and no promotion-eligible hypotheses.
- Jangar quant health for `PA3SX7FYNUTF` and `15m` returned `latestMetricsCount=144`, latest metrics updated at
  `2026-05-06T21:10:46Z`, `missingUpdateAlarm=false`, compute lag `1` second, ingestion lag `12369` seconds, and
  materialization lag `17` seconds.
- Jangar market-context health was degraded with domain staleness across technicals, fundamentals, news, and regime.
- Torghut empirical jobs were healthy, truthful, and promotion-authority eligible for four jobs tied to dataset
  snapshot `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Torghut options catalog was ready and exposed `160` hot-set option instruments. This is useful for future hedged
  repair hypotheses, but it does not bypass stale alpha qualification.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, and current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready, but parent-fork warnings remained for the migration graph around `0010` and `0015`.
- Direct database reads were not available to this runtime: pod exec was forbidden and ClickHouse HTTP without
  credentials returned `401 REQUIRED_PASSWORD`.
- The application projections still gave enough evidence to separate schema health from data freshness.
- `/trading/tca` summary reported `order_count=13775`, `avg_abs_slippage_bps=568.6138848199565`, and
  `last_computed_at=2026-04-02T20:59:45.136640Z`.
- Recent `/trading/decisions` samples on `2026-05-06` were blocked with `trading_simple_submit_disabled`, while
  `/trading/executions` samples were April orders, many canceled or with stale TCA.

### Source Evidence

- `services/torghut/app/main.py` is `4051` lines and currently owns readiness, DB-check, trading status, empirical
  jobs, trading health, TCA, decisions, executions, and runtime projections.
- `services/torghut/app/trading/submission_council.py` is `1199` lines and already builds live-submission gate payloads
  from dependency quorum, empirical proof, quant evidence, toggle parity, promotion evidence, and TCA inputs.
- `services/torghut/app/trading/hypotheses.py` is `764` lines and already turns missing features, drift gaps, signal
  lag, and stale market context into hypothesis blocker reasons.
- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and verifies freshness, truthfulness, authority,
  candidate ids, dataset refs, and artifact refs.
- `services/torghut/app/trading/market_context.py` is `290` lines and already exposes market-context stale risk flags.
- Torghut has `151` test files, including targeted coverage for submission council, trading API, empirical jobs,
  hypotheses, market context, TCA policy, strategy runtime, and property/stateful trading helpers.
- The missing source layer is a small router/receipt reducer that chooses between capital-qualified alpha routing and
  zero-notional repair rather than scattering that decision across status, scheduler, and human interpretation.

## Problem

Torghut has enough evidence surfaces to prove why it should not trade, but not yet enough structure to choose the next
profitable repair.

The active failure modes are:

1. **Blocked decisions continue without capital qualification.** Recent decisions show meaningful signal payloads, but
   they are blocked by simple submit disablement and stale qualification evidence.
2. **Execution proof is stale.** TCA still reflects April executions and high absolute slippage, so the system cannot
   trust current fillability.
3. **Quant freshness is uneven.** Latest metrics and compute are fresh while ingestion is stale by hours.
4. **Market context is stale across every major domain.** Strategies that need regime, news, and fundamental context
   cannot be promoted on stale context.
5. **Empirical jobs are fresh but not sufficient.** Backtest and parity artifacts can fund repair priority, not capital
   admission.
6. **Options inventory is present but unqualified.** A 160-instrument hot set creates useful option value for hedged
   experimentation, but no options sleeve should receive capital until the same qualification receipt clears.

## Alternatives Considered

### Option A: Promote The Fresh Empirical Candidate To Paper

This option uses the current empirical jobs for `chip-paper-microbar-composite@execution-proof` as the primary paper
promotion signal.

Pros:

- Fastest route to new paper observations.
- Uses fresh empirical work instead of letting it decay.
- Keeps the pipeline moving.

Cons:

- Ignores stale TCA and high historical slippage.
- Ignores stale market context and stale quant ingestion.
- Ignores `simple_submit_disabled` and `promotion_eligible_total=0`.
- Confuses proof of a historical candidate with proof of current tradability.

Decision: reject.

### Option B: Freeze Strategy Work Until Every Health Surface Is Green

This option stops strategy routing and waits for all route, data, context, and execution health surfaces to become OK.

Pros:

- Strong capital safety.
- Simple to communicate during an incident.
- Avoids accidental paper or live admission.

Cons:

- Produces no repair ordering.
- Wastes fresh empirical evidence and a functioning Jangar control plane.
- Treats zero-notional repair as if it carries the same risk as capital deployment.
- Slows the learning loop that should improve profitability.

Decision: reject.

### Option C: Capital-Qualified Alpha Router With Execution Repair Ladder

This option lets Torghut route alphas only after capital qualification and otherwise emits ranked repair intents with
zero notional.

Pros:

- Keeps capital at zero until evidence is current.
- Converts blocker reasons into an ordered repair backlog.
- Separates historical empirical validity from current tradability.
- Gives execution/TCA proof equal weight with signal and context proof.
- Allows options and hedged experiments to enter as repair hypotheses without bypassing guardrails.

Cons:

- Requires a new reducer and receipt payload.
- Requires calibration of repair priority scoring.
- May delay paper reentry until TCA and context refresh paths are reliable.

Decision: select Option C.

## Architecture

Torghut produces an alpha route qualification for each strategy, account, revision, and market window.

```text
alpha_route_qualification
  qualification_id
  generated_at
  account_label
  torghut_revision
  strategy_id
  declared_strategy_id
  market_window
  jangar_capital_receipt_id
  route_state               # observe_only, repair_only, paper_candidate, live_micro_candidate, live_scale_candidate
  capital_state             # zero_notional, paper_hold, paper_allowed, live_hold, live_allowed
  max_notional
  proof_dimensions
  blocker_reasons
  repair_ladder_refs
  rollback_target
  fresh_until
```

Qualification dimensions:

```text
alpha_route_dimension
  dimension                 # jangar_receipt, quant_ingestion, market_context, empirical, execution_tca, features, drift
  state                     # pass, degraded, stale, missing, fail
  source_ref
  observed_at
  freshness_seconds
  threshold_seconds
  guardrail
  capital_effect            # observe_only, repair_only, paper_hold, live_hold
```

The router chooses one of five states:

- `observe_only`: collect signals and decisions, no submissions, max notional `0`.
- `repair_only`: dispatch or request a repair job, no submissions, max notional `0`.
- `paper_candidate`: qualified for paper canary sizing after all proof dimensions pass.
- `live_micro_candidate`: qualified for small live canary only after paper outcome and rollback receipts pass.
- `live_scale_candidate`: qualified for scale only after live micro outcome, slippage, and drawdown guardrails pass.

Repair ladder:

```text
execution_repair_ladder
  ladder_id
  generated_at
  account_label
  market_window
  ranked_repairs
  selected_repair
```

```text
ranked_repair
  repair_kind               # quant_ingestion, market_context, tca_replay, feature_backfill, drift_check, options_hedge_eval
  blocker_reason
  affected_hypotheses
  expected_unblock_value
  evidence_age_penalty
  cost_budget
  validation_gate
  rollback_condition
  priority_score
```

Initial priority scoring:

```text
priority_score =
  blocker_severity
  * affected_hypothesis_count
  * empirical_candidate_weight
  * evidence_age_penalty
  / max(cost_budget, 1)
```

This starts as deterministic policy, not ML. Learned weights can come later after repair closure and paper outcome data
exist.

## Measurable Trading Hypotheses

H-CQ-01, quant ingestion repair:

- Hypothesis: reducing scoped quant ingestion lag below `120` seconds during market hours will remove
  `signal_lag_exceeded` from at least one shadow hypothesis and move quant evidence from degraded to OK.
- Guardrail: no paper or live notional while ingestion lag is above threshold.
- Measurement: Jangar quant health stage lag and Torghut hypothesis blocker counts over one full market session.
- Rollback: if ingestion repair increases missing-update alarms or route latency, return the route state to
  `observe_only`.

H-CQ-02, market-context refresh:

- Hypothesis: refreshing technicals below `60` seconds, regime below `120` seconds, news below `300` seconds, and
  fundamentals below `86400` seconds will remove `market_context_stale` from the reversal/event hypothesis path.
- Guardrail: event/reversal lanes cannot become paper candidates while any required context domain is stale.
- Measurement: Jangar market-context domain health and Torghut hypothesis reasons.
- Rollback: if provider failures or quality score below `0.70` persist, keep the affected lanes in `repair_only`.

H-CQ-03, execution/TCA replay:

- Hypothesis: replaying TCA for the current session or prior complete trading day will either prove slippage below
  `25` bps p95 for the candidate route or keep it in repair-only before capital is spent.
- Guardrail: stale TCA or `avg_abs_slippage_bps > 50` holds paper and live capital.
- Measurement: `/trading/tca` recency, expected shortfall coverage, p95 slippage, and churn ratio.
- Rollback: if replay cannot produce current settlement, downgrade every candidate route to `observe_only`.

H-CQ-04, feature and drift closure:

- Hypothesis: backfilling required feature rows and drift checks for the blocked microbar lane will create the fastest
  path from `blocked` to `shadow` or `paper_candidate`.
- Guardrail: missing required features or drift checks hold capital regardless of signal score.
- Measurement: Torghut hypothesis registry blocker reasons and feature snapshot hashes.
- Rollback: if backfill produces inconsistent feature hashes across live and sim, quarantine the route.

H-CQ-05, options hedge evaluation:

- Hypothesis: the ready 160-instrument options hot set can reduce tail risk for a future paper canary only after the
  underlying equity alpha is capital-qualified.
- Guardrail: options evaluation remains zero-notional until equity route qualification is at least `paper_candidate`.
- Measurement: options catalog readiness, option spread/fillability diagnostics, and simulated hedge PnL attribution.
- Rollback: if options data freshness or fillability is stale, remove options hedge from the repair ladder.

## Implementation Scope

Engineer stage:

- Add an `alpha_route_qualification` reducer near the submission council boundary.
- Consume the Jangar capital qualification receipt from the companion contract.
- Build repair ladder entries from existing blocker reasons: quant evidence, market context, TCA, feature rows, drift
  checks, empirical jobs, and options readiness.
- Emit route qualification in `/trading/status` and `/trading/health` without changing order submission in the first
  implementation.
- Add tests that prove fresh empirical jobs do not authorize paper capital when TCA is stale or quant ingestion is
  stale.
- Add tests that prove repair-only routes have max notional `0` and preserve the current live submission fail-closed
  behavior.

Deployer stage:

- Ship route qualification in observe-only mode first.
- Compare qualification output against existing live submission gate and hypothesis blockers for one full market
  session.
- Enable paper candidate gating only after the reducer has no false positive paper candidates in shadow.
- Keep live submit disabled until paper outcome, TCA, and rollback receipts are current.

## Validation Gates

Local/source gates:

- `cd services/torghut && uv run --frozen pytest tests/test_submission_council.py tests/test_trading_api.py tests/test_hypotheses.py tests/test_empirical_jobs.py tests/test_market_context.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`

Read-only runtime gates:

- `/trading/status` shows `route_state=repair_only` or `observe_only` while `simple_submit_disabled` is active.
- `/trading/health` shows quant ingestion and market context dimensions with source refs.
- `/trading/tca` has a current `last_computed_at` before any paper candidate is emitted.
- `/trading/empirical-jobs` remains fresh and truthful but is not sufficient alone.
- Jangar capital qualification receipt is current for the same account, revision, and window.

Production acceptance:

- In the current evidence state, no route is `paper_candidate`.
- The selected repair is one of `quant_ingestion`, `market_context`, or `tca_replay`, with max notional `0`.
- A route cannot become `live_micro_candidate` unless paper outcome and rollback receipts are current.
- Rollback returns all routes to `observe_only` without toggling broker credentials or deleting data.

## Rollout Plan

1. Implement qualification and repair ladder in shadow mode.
2. Expose route qualification in status and health payloads.
3. Run one market session with no behavioral order-submission change.
4. Enable paper canary gating through the qualification reducer after shadow validation.
5. Enable live micro gating only after paper outcome receipts and TCA recency are proven.

## Rollback Plan

- Disable the qualification reducer flag and fall back to existing live submission gate behavior.
- Preserve emitted qualifications as audit evidence.
- Keep `simple_submit_disabled` and current capital stage controls unchanged during rollback.
- If route qualification causes latency or status payload errors, remove it from `/trading/status` first while keeping
  `/trading/health` diagnostic output available.

## Risks And Mitigations

- Risk: repair scoring becomes arbitrary. Mitigation: start with deterministic weights and record every selected repair
  with blocker, expected unblock value, and outcome.
- Risk: stale execution proof blocks too long. Mitigation: make TCA replay the highest priority when TCA is older than
  one full trading day.
- Risk: options hedge work distracts from core alpha repair. Mitigation: options evaluation cannot outrank quant
  ingestion, market context, or TCA repair until the underlying equity alpha is paper-qualified.
- Risk: status payloads become too large. Mitigation: expose summary dimensions in `/trading/status` and detailed
  receipts through a dedicated route if needed.

## Handoff Contract

Engineer acceptance:

- Implement route qualification and repair ladder behind a feature flag.
- Add regression tests for fresh empirical proof plus stale TCA, stale quant ingestion, and stale market context.
- Prove current evidence emits zero paper/live candidates and at least one zero-notional repair action.

Deployer acceptance:

- Roll out shadow qualification with no order-submission behavior change.
- Capture one market session of route qualification, Jangar capital receipts, and existing live submission gate output.
- Do not enable paper or live capital until qualification dimensions are current and rollback evidence is explicit.
