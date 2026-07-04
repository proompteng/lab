# 123. Torghut Empirical Profit Claims And Shadow Capital Settlement (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and changed: empirical status/proof concepts remain in code, but old empirical job scripts and Argo workflow templates were removed.
- Matched implementation area: Empirical jobs and promotion evidence.
- Current source evidence:
  - `services/torghut/app/trading/empirical_jobs.py`
  - `services/torghut/app/api/health_checks/shared_context.py`
  - `services/torghut/app/trading/profit_windows.py`
  - `services/torghut/app/trading/profit_leases.py`
  - `services/torghut/scripts/build_historical_profitability_proof.py`
- Design drift note: Old empirical-promotion scripts/templates must not be cited as live source authority.


## Decision

Torghut will emit **empirical profit claims** and settle them through a **shadow capital settlement ledger** before it
asks Jangar to clear merge, paper, or live capital gates.

The current runtime is alive but not profitable enough to promote. In the read-only sample at `2026-05-06T14:08Z`,
Torghut live revision `torghut-00238` was running, Postgres and ClickHouse were healthy through `/readyz`, Alpaca
reported `broker_ok`, and database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
Torghut `/trading/status` showed the live scheduler running, live submission disabled, signal continuity present, and
critical toggles aligned.

That does not make capital safe. `/readyz` returned HTTP `503` because `live_submission_gate.allowed=false` with
`reason=simple_submit_disabled` in `capital_stage=shadow`. Jangar dependency quorum blocked on
`empirical_jobs_degraded`. Torghut `/trading/autonomy` reported stale empirical jobs for `benchmark_parity`,
`foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all tied to candidate
`intraday_tsmom_v1@prod` and dataset `torghut-full-day-20260318-884bec35`. The hypothesis ledger showed `3`
hypotheses, `0` promotion eligible, and `3` rollback required. Jangar typed quant health scoped to
`account=paper&window=1d` was degraded with an empty latest store. Market context for `NVDA` was degraded by stale
fundamentals and stale news. `torghut-ta-sim` was in `ImagePullBackOff`, so one sim proof lane was also unable to
renew technical-analysis evidence.

The selected design turns Torghut's proof debt into claims. A claim is not permission to trade. It is a structured
request that says: this hypothesis, candidate, dataset, account, and evidence set can become more decidable if Jangar
admits this zero-notional repair. A closed claim records whether the repair actually renewed profit proof, what capital
state it would have affected, and why any remaining block stays in shadow.

The tradeoff is that Torghut must do more accounting before paper reentry. I accept that. The current bottleneck is not
route availability. It is stale empirical truth and empty/scoped proof. Profitability improves when scarce repair work
is directed at the proof most likely to unlock safe paper measurement, not when degraded readiness is converted into an
exception.

## Evidence Snapshot

All checks were read-only.

### Runtime Evidence

- Torghut namespace services included current live revision `torghut-00238`, sim revision `torghut-sim-00329`,
  ClickHouse, Keeper, Postgres, TA, options TA, options catalog, options enricher, websockets, and guardrail exporters.
- Live pod `torghut-00238-deployment-7978dfb475-gx5s5` was `2/2 Running`.
- Sim pod `torghut-sim-00329-deployment-7646fb8f5b-7gxww` was `2/2 Running`.
- `torghut-ta` was running, but `torghut-ta-sim` was `0/1 ImagePullBackOff` because its image digest did not contain a
  matching platform manifest.
- Recent Torghut events showed transient readiness/startup probe failures during Knative revision replacement and
  duplicate ClickHouse PodDisruptionBudget matches.
- The runtime service account could not exec into Torghut Postgres; service-owned health projections are therefore the
  routine database evidence surface for this lane.

### Data And Profit Evidence

- `/readyz` returned HTTP `503` with `status=degraded`.
- `/readyz` reported scheduler, Postgres, ClickHouse, Alpaca, database schema, and Jangar universe healthy.
- `/readyz` reported database schema current at `0029_whitepaper_embedding_dimension_4096`,
  `schema_graph_lineage_ready=true`, and `account_scope_ready=true`.
- `/readyz` retained schema graph warnings for historical parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/readyz` reported `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`,
  `capital_stage=shadow`, `promotion_eligible_total=0`, and `dependency_quorum_decision=informational_only`.
- `/trading/status` reported `promotion_eligible_total=0`, `rollback_required_total=3`,
  `capital_stage_totals.shadow=3`, and dependency quorum `block`.
- `/trading/status` reported `strategy_events_total` for the two enabled microbar strategies, but no submitted
  orders, no decisions, and no live promotion.
- `/trading/autonomy` reported `forecast_service.status=degraded` with `registry_empty`, `lean_authority.status=disabled`,
  and `empirical_jobs.status=degraded`.
- The stale empirical jobs were `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`; each was marked `truthful=true` but `stale=true`.
- The stale jobs referenced candidate `intraday_tsmom_v1@prod`, dataset `torghut-full-day-20260318-884bec35`, and S3
  artifact refs under `s3://torghut-empirical-artifacts/empirical/sim-proof-884bec35-march18-refresh-20260319-080910`.
- Jangar market-context health for `NVDA` returned `overallState=degraded`, technicals and regime fresh, fundamentals
  stale by `4753521` seconds, and news stale by `1516` seconds.
- Jangar quant health scoped to `account=paper&window=1d` returned `status=degraded`, empty latest metrics, and
  `emptyLatestStoreAlarm=true`.

### Source Evidence

- `services/torghut/app/main.py` remains the broad Torghut runtime assembly point for readiness, status, decisions,
  executions, autonomy, and database checks.
- `services/torghut/app/trading/empirical_jobs.py` already tracks job truthfulness, freshness, candidate ids, dataset
  snapshot refs, artifact refs, and promotion authority eligibility.
- `services/torghut/app/trading/hypotheses.py` already records hypothesis state, capital stage, promotion eligibility,
  rollback requirement, feature dependencies, and observed blockers.
- `services/torghut/app/trading/submission_council.py` already consumes Jangar dependency quorum and typed quant
  health before live submission.
- `services/torghut/app/trading/scheduler/pipeline.py` owns signal continuity, market-context observation, rejection
  accounting, LLM decision context, and order preparation.
- Existing tests cover empirical jobs, trading readiness, database schema, market-context evaluation, quant evidence,
  and submission-council gates. The missing system test is claim settlement: a stale empirical job can become a fresh
  profit claim only when the closure receipt matches the active hypothesis, candidate, dataset, account/window, and
  Jangar settlement.

## Problem

Torghut knows that capital is blocked. It does not yet publish a claim that is precise enough for Jangar to settle.

The current stale proof is not a generic defect. It has dimensions:

- candidate: `intraday_tsmom_v1@prod`;
- dataset: `torghut-full-day-20260318-884bec35`;
- jobs: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, `janus_hgrm_reward`;
- hypotheses: continuation, microstructure breakout, and event reversion;
- capital state: all shadow or blocked, zero promotion eligible, all rollback required;
- account/window proof: paper latest store empty for the sampled window;
- market context: stale fundamentals and news for the active chip universe;
- runtime proof: sim TA image pull debt may prevent a required proof lane from renewing.

If Torghut only reports "empirical jobs are stale" and then later reports "empirical jobs are fresh," Jangar still has
to infer whether the fresh proof is the right proof for merge readiness, paper canary, live micro canary, or live
scale. That inference should be explicit and auditable.

## Alternatives Considered

### Option A: Empirical Jobs Endpoint As The Capital Contract

Use `/trading/autonomy` or a dedicated empirical jobs endpoint as the sole proof source. If required jobs are fresh,
paper canary can advance.

Pros:

- Reuses current Torghut data.
- Easy to implement.
- Directly targets the known dependency-quorum block.

Cons:

- Does not bind jobs to active hypotheses, accounts, windows, market context, or quant health.
- Cannot explain which capital gate a job actually unlocks.
- Does not produce Jangar closure receipts.
- Risks treating truthful but stale or irrelevant artifacts as sufficient.

Decision: reject as the authority contract.

### Option B: Hypothesis Ledger Self-Promotion

Let the Torghut hypothesis ledger change state from shadow or blocked to paper-eligible when empirical and quant data
look fresh.

Pros:

- Keeps trading state in the trading service.
- Makes profitability posture easy to show in one route.
- Can evolve quickly with quant-team scoring.

Cons:

- Hypothesis state is not Jangar action authority.
- It cannot see Jangar watch reliability, repair admission, source-schema projection, and rollout settlement.
- It cannot safely grant merge or deployer decisions.

Decision: reject as the control-plane handoff. Keep it as an input.

### Option C: Empirical Profit Claims With Shadow Capital Settlement

Torghut emits claims and receipts that Jangar settles. The shadow capital ledger records what would be eligible if the
claim closes, while live notional stays at zero until Jangar action settlement and Torghut submission gates agree.

Pros:

- Keeps Torghut responsible for profit semantics and Jangar responsible for action authority.
- Makes stale empirical proof repair measurable by hypothesis, candidate, account, window, and capital gate.
- Prevents a route from self-certifying live capital.
- Creates durable evidence for why paper or live reentry did or did not happen.

Cons:

- Adds claim and receipt schemas.
- Requires conservative defaults for early scoring.
- Requires deployers to inspect claim settlement, not just readiness.

Decision: select Option C.

## Architecture

Torghut emits `torghut_empirical_profit_claim` records.

```text
torghut_empirical_profit_claim
  claim_id
  created_at
  expires_at
  hypothesis_id
  lane_id
  candidate_id
  dataset_snapshot_ref
  account
  window
  required_empirical_jobs
  current_empirical_job_refs
  required_quant_health_refs
  required_market_context_domains
  required_runtime_refs
  expected_information_gain        # low, medium, high, critical
  expected_capital_gate            # observe, merge_ready, paper_canary, live_micro_canary, live_scale
  expected_profit_value_class      # low, medium, high, critical
  risk_reduction_class             # low, medium, high, critical
  requested_jangar_lane_class      # empirical_replay, quant_latest_bootstrap, market_context_rehydrate,
                                   # sim_ta_repair, alert_closure, hypothesis_retirement
  max_runtime_seconds
  max_query_budget_units
  max_notional
  claim_status                     # proposed, selected, denied, closed, expired
  denial_reasons
```

When a selected claim finishes, Torghut emits `torghut_empirical_profit_claim_receipt`.

```text
torghut_empirical_profit_claim_receipt
  receipt_id
  claim_id
  completed_at
  closure_status                   # complete, partial, failed, expired
  before_refs
  after_refs
  empirical_job_refs
  quant_health_refs
  market_context_refs
  runtime_refs
  hypothesis_state_before
  hypothesis_state_after
  evidence_truthfulness            # truthful, unverified, contradicted
  freshness_decision               # fresh, stale, mixed
  remaining_blockers
  jangar_clearinghouse_epoch_ref
  jangar_closure_receipt_ref
```

Torghut also maintains `torghut_shadow_capital_settlement`.

```text
torghut_shadow_capital_settlement
  settlement_id
  generated_at
  expires_at
  account
  hypothesis_id
  lane_id
  current_capital_stage
  shadow_decision                  # keep_shadow, eligible_for_observe, eligible_for_paper_shadow,
                                   # eligible_for_paper, eligible_for_live_micro
  paper_notional_ceiling
  live_notional_ceiling
  required_claim_receipts
  required_jangar_settlements
  missing_receipts
  rollback_target
```

Rules:

- `max_notional` is always `0` for claims and receipts.
- A claim can improve shadow eligibility only after Jangar selects the claim or explicitly accepts a closure receipt
  for an already-running repair.
- A complete empirical claim is not sufficient for paper canary if account/window quant health is empty or
  market-context domains required by the hypothesis are stale.
- A complete market-context claim is not sufficient for paper canary if empirical jobs are stale.
- A complete sim TA repair can unlock proof renewal capacity, not capital directly.
- A failed claim should reduce future expected information gain for the same repair class until a new reason or
  dataset appears.
- Live micro and live scale require prior paper settlement history; no claim can jump directly from shadow to live.

## Measurable Hypotheses

Hypothesis 1: renewing the four stale empirical jobs for `intraday_tsmom_v1@prod` should retire
`empirical_jobs_degraded` for merge readiness only when all job receipts are fresh, truthful, and tied to the current
candidate and dataset.

Hypothesis 2: paper canary remains held after empirical renewal if `account=paper&window=1d` quant health is empty.
Success means paper does not advance on empirical proof alone.

Hypothesis 3: market-context rehydration improves event-reversion claim quality only when fundamentals and news both
become fresh inside the hypothesis freshness budget.

Hypothesis 4: sim TA image pull repair is valuable only if a selected claim requires sim technical-analysis proof.
Success means platform repair capacity is not spent on unrelated sim debt during an empirical proof block.

## Implementation Scope

Torghut engineer scope:

- Add claim and claim-receipt builders that read empirical jobs, hypothesis posture, typed quant health, market
  context, runtime revision, and signal continuity.
- Add a read-only route for current claims and settlements. The route must not launch jobs, submit orders, or mutate
  trading flags.
- Add tests for stale empirical jobs, irrelevant candidate proof, stale market-context domain, empty quant health,
  failed repair receipt, expired claim, and paper/live notional staying zero.
- Emit claim refs that Jangar can consume without privileged database access.

Jangar engineer scope:

- Consume claims through the companion clearinghouse.
- Settle claim receipts into action-class decisions without letting Torghut self-certify capital.

Deployer scope:

- Confirm `/readyz` may remain HTTP `503` while claims and settlement are healthy in shadow.
- Do not treat `claim_status=closed` as capital authority unless Jangar settlement is present and fresh.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/torghut/design-system/v6/123-torghut-empirical-profit-claims-and-shadow-capital-settlement-2026-05-06.md docs/agents/designs/119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md docs/torghut/design-system/v6/index.md`

Engineer validation:

- Claim builder tests cover complete, partial, failed, expired, and denied claims.
- Settlement tests prove `paper_notional_ceiling=0` and `live_notional_ceiling=0` until Jangar settlements are fresh.
- Submission council tests prove claim closure cannot bypass `simple_submit_disabled`, dependency quorum, quant health,
  or market-context blockers.
- Empirical job tests verify candidate id, dataset snapshot, artifact refs, truthfulness, and freshness are all part of
  the claim receipt.

Cluster validation:

- `/trading/autonomy` still reports stale jobs until real fresh empirical evidence exists.
- The new claim route reports claims as proposed or selected while live submission stays disabled.
- Jangar status shows the matching clearinghouse epoch before any action-class settlement changes.

## Rollout

1. Land this contract with the companion Jangar clearinghouse.
2. Implement the Torghut claim route as read-only shadow output.
3. Publish claim receipts for already-running or manually-run repair jobs without changing capital state.
4. Let Jangar consume claims in shadow and compare settlements to existing dependency quorum.
5. Allow selected zero-notional claims to request repair admission.
6. Only after multiple successful closure cycles, allow paper-canary settlement to cite the claim ledger.
7. Keep live micro and live scale blocked until paper settlement history exists.

## Rollback

- Disable claim consumption in Jangar. Torghut can continue publishing claims as audit-only records.
- Keep all capital stages in shadow and all live notional at `0`.
- Treat all incomplete and expired claims as unsettled proof debt.
- Fall back to current `/readyz`, `/trading/autonomy`, Jangar dependency quorum, and action SLO budgets.

## Risks

- Claim inflation: every stale surface can become a claim. Mitigation: require expected capital gate, candidate,
  dataset, and closure criteria; deny claims with no gate impact.
- Profit overstatement: expected profit value is an ordinal repair priority, not realized PnL. Mitigation: keep
  realized PnL separate and require paper settlement before live capital.
- Stale closure: a once-fresh receipt can age out. Mitigation: every receipt and settlement has `expires_at`.
- Jangar coupling drift: Torghut may publish a claim schema Jangar does not understand. Mitigation: version claims and
  fail closed when the companion clearinghouse does not recognize the version.
- Repair starvation: empirical replay may starve market-context or quant repairs. Mitigation: publish denied claims,
  age, and denied reason so Jangar can rotate capacity.

## Handoff

Engineer acceptance gates:

- Claims are typed, versioned, read-only, and zero-notional.
- Receipts bind empirical jobs to candidate id, dataset snapshot, hypothesis, account, window, and artifact refs.
- Shadow capital settlement cannot lift paper or live notional without Jangar settlement refs.
- Tests cover blocked, stale, partial, failed, and expired proof.

Deployer acceptance gates:

- Capture Torghut `/readyz`, `/trading/status`, `/trading/autonomy`, claim route, Jangar control-plane status, typed
  quant health, and market-context health before enabling consumption.
- Keep `simple_submit_disabled` and shadow capital in place during claim rollout.
- Roll back by disabling claim consumption and preserving current dependency quorum/action-budget gates.
