# 142. Torghut Alpha Truth Windows And Capital Reentry Warrants (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant profitability, alpha truth windows, post-cost evidence, scoped quant health, TCA repair,
forecast proof, doc29 gates, capital reentry, validation, rollout, and rollback.

Companion Jangar contract:

- `docs/agents/designs/138-jangar-proof-truth-windows-and-contradiction-arbiter-2026-05-07.md`

Extends:

- `141-torghut-watch-debt-profit-repair-market-and-capital-reentry-gates-2026-05-07.md`
- `140-torghut-post-cost-alpha-reentry-and-proof-query-market-2026-05-07.md`
- `139-torghut-profit-evidence-custody-and-capital-reentry-auction-2026-05-07.md`
- `134-torghut-profitability-proof-floor-and-evidence-repair-market-2026-05-06.md`

## Decision

I am selecting **alpha truth windows with capital reentry warrants** as Torghut's next quant profitability architecture
step.

The current Torghut service is alive and it is correctly refusing capital. Live and sim are running the same
`315dde4b8581598309238c2989b95451a167c110` build. `/healthz` is healthy. `/db-check` reports the Alembic head current.
The scheduler is running. Empirical jobs are fresh and authoritative for
`chip-paper-microbar-composite@execution-proof`.

Those facts are not enough for paper or live. Over the last 72 hours, the profitability runtime reports `25` decisions,
`0` executions, and `0` TCA samples. Historical TCA exists, but its latest computation is
`2026-04-02T20:59:45Z`, and the live proof floor blocks on `execution_tca_stale`. The scoped Jangar quant route for
account `PA3SX7FYNUTF` and `window=15m` is degraded because ingestion lag is roughly `55,645s`, even while the global
latest-store route is fresh. Doc29 completion has `1` satisfied gate, `2` stale gates, and `6` blocked gates. Runtime
hypotheses remain `3` total, `0` promotion eligible, and `3` rollback required.

I am not choosing "run paper because empirical jobs are fresh." I am also not choosing another indefinite freeze. The
selected design creates an alpha truth window per account, hypothesis, and action class. That window consumes Jangar's
proof truth window, Torghut's DB-backed route evidence, scoped quant health, TCA freshness, doc29 gates, forecast
authority, and market-context state. Capital reentry is allowed only through a warrant generated from a contradiction
free alpha truth window.

The tradeoff is stricter paper entry. I accept that. Torghut's next profitable move is not more notional. It is retiring
the exact proof contradictions that make expected edge untrustworthy.

## Runtime Objective And Success Metrics

This contract increases profitability by forcing each candidate alpha to prove that its edge is current, scoped,
post-cost, and actionable before it receives paper or live capital.

Success means:

- `observe` remains available while proof contradictions exist.
- `proof_repair` is ranked and zero-notional.
- `paper_canary` requires a clean Jangar proof truth window, scoped quant health current, TCA current, doc29 simulation
  and paper gates satisfied, forecast proof non-placeholder when used, and no rollback-required hypothesis state.
- `live_micro_canary` requires paper settlement, fresh post-cost TCA, scoped quant ingestion current during market
  hours, and explicit max daily loss.
- `live_scale` requires live micro settlement plus deployer approval or an approved automated escalation policy.
- Every warrant declares expected edge, evidence cost, max notional, max daily loss, expiry, and rollback trigger.

Initial gate thresholds:

- Scoped quant ingestion lag <= `15s` during market hours before paper.
- TCA freshness <= `24h` before paper and <= `4h` before live micro.
- Expected shortfall coverage > `95%` for any TCA sample set used in a warrant.
- Average absolute slippage <= the hypothesis budget: `12bps` for continuation/reversion, `8bps` for microstructure.
- Doc29 `paper_gate_satisfied` and its dependencies must be satisfied before paper.
- Runtime profitability window must contain non-empty execution evidence before live micro.
- `/trading/health` should return in <= `5s`; slow proof families become repair bids, not capital authority.

## Evidence Snapshot

All evidence was collected read-only through permitted Kubernetes reads, service routes, source inspection, and NATS
coordination. I did not mutate Kubernetes resources, database rows, broker state, empirical artifacts, GitOps resources,
or trading flags.

### Cluster Evidence

- `kubectl get pods,deploy,job,cronjob,svc -n torghut` showed Torghut Postgres, ClickHouse, Keeper, TA, TA sim,
  options services, WebSocket services, guardrail exporters, live Torghut, and sim Torghut running.
- The current live revision was `torghut-00252`; the current sim revision was `torghut-sim-00352`.
- Recent Torghut events showed startup/readiness timeouts during the rollout, followed by `RevisionReady` for both live
  and sim.
- Torghut DB migrations, empirical backfill, whitepaper bootstrap, and whitepaper semantic backfill jobs completed in
  the observed rollout window.
- This service account cannot list CNPG cluster CRs, ClickHouse installation CRs, PDBs, HPAs, secrets, or exec into
  Torghut pods. The warrant design therefore requires service-owned route evidence for normal validation.

### Route Evidence

- `/healthz` returned `{"status":"ok","service":"torghut"}`.
- `/db-check` returned `ok=true`, schema current, expected head `0029_whitepaper_embedding_dimension_4096`, and lineage
  ready with known parent-fork warnings.
- `/trading/status` returned `mode=live`, `running=true`, `last_run_at=2026-05-07T09:12:02Z`, and
  `last_decision_at=2026-05-06T17:44:19Z`.
- The live submission gate was closed with `reason=simple_submit_disabled`, `capital_stage=shadow`, and
  `promotion_eligible_total=0`.
- The proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`, and blocked by
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- `/trading/profitability/runtime` reported a 72-hour window with `25` decisions, `0` executions, `0` TCA samples, and
  realized PnL proxy `0`.
- `/trading/tca?limit=5` reported `13,775` historical TCA rows, average absolute slippage about `568.61bps`, expected
  shortfall coverage `0`, and latest computation `2026-04-02T20:59:45Z`.
- `/trading/decisions?limit=5` returned recent blocked decisions, including `AMAT` on `2026-05-06T17:44:19Z` blocked
  by `trading_simple_submit_disabled`.
- `/trading/executions?limit=5` returned latest executions from `2026-04-02`/`2026-04-03`, not current-session
  execution evidence.
- `/trading/empirical-jobs` returned `status=healthy`, `ready=true`, `authority=empirical`, and eligible jobs for
  benchmark parity, foundation-router parity, Janus event CAR, and Janus HGRM reward.
- `/trading/completion/doc29` returned `total=9`, `satisfied=1`, `stale=2`, and `blocked=6`.
- Jangar scoped quant health for `PA3SX7FYNUTF&window=15m` returned `status=degraded`; compute and materialization were
  current, but ingestion was stale with `lagSeconds=55645`.

### Database And Data Evidence

- Direct CNPG psql is not available to this worker:
  `pods "torghut-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`.
- Pod exec into the live Torghut deployment and secret listing in the Torghut namespace are also forbidden.
- The normal data assessment therefore depends on route evidence that is already backed by the application database.
- Schema quality is good enough to operate: current Alembic head, one current schema head, and account-scope checks
  ready because multi-account mode is disabled.
- Data freshness is not good enough for capital: current decisions exist, but current execution and TCA evidence do
  not.
- Data consistency is mixed: empirical jobs are fresh, but doc29 proving gates are mostly stale or blocked; global quant
  latest-store health is fresh, but scoped ingestion proof is stale.

### Source Evidence

- `services/torghut/app/main.py` owns the route aggregation that already exposes status, health, runtime
  profitability, TCA, doc29, decisions, and executions.
- `services/torghut/app/trading/proof_floor.py` already produces the zero-notional repair-only floor.
- `services/torghut/app/trading/submission_council.py` owns live submission gate composition and hypothesis runtime
  summaries.
- `services/torghut/app/trading/empirical_jobs.py` distinguishes authoritative empirical jobs from placeholders.
- `services/torghut/app/trading/forecast_runtime.py` and `forecasting.py` carry promotion-authority fields, but current
  forecast service evidence is still degraded or scaffold-backed.
- The highest risk is not missing local code. The risk is that each proof family is locally correct but capital has no
  single warrant that applies the strictest current contradiction.

## Problem

Torghut has enough evidence to explain why capital is blocked, but the evidence is not yet organized around alpha
reentry.

The current state creates false pressure to take one of two bad shortcuts:

1. Use fresh empirical jobs as a reason to paper trade.
2. Keep everything frozen until a human manually repairs every stale proof family.

Both shortcuts miss the profitable middle. The system needs to spend repair effort on the contradictions most likely to
unlock controlled, post-cost alpha:

- scoped quant ingestion is stale for the live account/window;
- TCA is stale and historically far outside the microstructure budget;
- recent decisions exist but recent execution proof is empty;
- doc29 paper and simulation gates are blocked;
- forecast proof is degraded or non-authoritative;
- runtime hypotheses are not promotion eligible and all require rollback.

Capital should come back only when those facts settle into a warrant. Repair work should be ordered by expected edge
unblock value, not by whichever stale alert is loudest.

## Alternatives Considered

### Option A: Promote The Fresh Empirical Candidate To Paper

Pros:

- Fastest path to new observations.
- Uses current authoritative empirical job rows before they age.
- Makes the quant lane visibly active.

Cons:

- Ignores stale TCA and zero expected-shortfall coverage.
- Ignores 72-hour zero execution evidence.
- Ignores blocked doc29 paper and simulation gates.
- Ignores scoped quant ingestion debt.
- Converts empirical repair priority into capital authority.

Decision: reject.

### Option B: Run A Focused Backfill Sprint

This option runs TCA, order-feed, doc29, and quant-ingestion backfills until the current blockers clear.

Pros:

- Attacks concrete blockers.
- Useful work even if the architecture changes later.
- Easier to schedule than a new receipt family.

Cons:

- Backfills age immediately after completion.
- Does not create a warrant that can tell paper/live when proof is still current.
- Does not account for Jangar action-class contradictions.
- Can spend repair compute on low-edge hypotheses.

Decision: reject as the architecture. Keep the backfills as repair actions under the selected design.

### Option C: Alpha Truth Windows With Capital Reentry Warrants

This option produces a truth window per account, hypothesis, and action class. It ranks proof repairs, then issues
capital warrants only when the window has no unresolved capital contradiction.

Pros:

- Keeps observe and repair active without releasing notional.
- Converts every proof gap into a priced repair input.
- Makes paper and live entry auditable and expiring.
- Lets Jangar carry upstream truth-window authority into Torghut capital decisions.
- Protects against global-green, scoped-stale contradictions.

Cons:

- Requires one new Torghut receipt surface.
- Requires threshold calibration by strategy family.
- Paper canaries may wait longer than a manual operator would choose.

Decision: select Option C.

## Architecture

Torghut emits one alpha truth window per account, hypothesis, strategy family, and action class.

```text
alpha_truth_window
  window_id
  generated_at
  fresh_until
  account_label
  hypothesis_id
  strategy_family
  action_class              # observe, proof_repair, paper_canary, live_micro_canary, live_scale
  jangar_proof_truth_ref
  proof_floor_ref
  scoped_quant_ref
  tca_ref
  doc29_ref
  forecast_ref
  market_context_ref
  runtime_profitability_ref
  contradictions[]
  repair_bids[]
  capital_effect
```

Contradictions are explicit:

```text
alpha_truth_contradiction
  contradiction_id
  family                    # scoped_quant, tca, doc29, forecast, market_context, runtime_profitability, jangar
  observed_state
  required_state
  action_class
  effect                    # observe_only, repair_only, hold, block
  repair_action
  expected_edge_unblock_bps
  evidence_cost_score
```

Repair bids are ranked but cannot release capital.

```text
alpha_repair_bid
  bid_id
  hypothesis_id
  account_label
  target_action_class
  closes_contradiction_refs[]
  expected_edge_unblock_bps
  evidence_cost_score
  stale_proof_age_seconds
  max_runtime_seconds
  max_notional              # always 0
  acceptance_gate
```

Capital reentry warrants are separate and expiring.

```text
capital_reentry_warrant
  warrant_id
  generated_at
  expires_at
  account_label
  hypothesis_id
  strategy_family
  action_class
  alpha_truth_window_ref
  jangar_proof_truth_window_ref
  decision                  # observe, repair_only, paper, live_micro, live_scale, hold, block
  max_notional
  max_daily_loss
  max_symbol_weight
  expected_edge_bps
  expected_turnover_bps
  post_cost_edge_bps
  rollback_triggers[]
  reason_codes[]
```

Precedence rules:

1. No capital warrant can be stronger than the Jangar proof truth window for the same action class.
2. Fresh empirical jobs may create or raise repair bids; they cannot issue paper or live warrants.
3. Scoped account/window quant health beats global quant health for paper and live.
4. TCA freshness and expected shortfall coverage are hard paper/live requirements.
5. Runtime profitability can be empty for observe and proof repair, but not for live micro.
6. Doc29 paper and simulation gates must be satisfied before paper.

## Measurable Trading Hypotheses

### Hypothesis A: Scoped Quant Ingestion Repair Unlocks Valid Paper Opportunities

Claim: Reducing scoped ingestion lag for `PA3SX7FYNUTF` to <= `15s` during market hours will reduce stale-proof holds and
increase valid paper opportunities without increasing drawdown.

Entry:

- Jangar proof truth window has no paper contradiction.
- Scoped quant health for account/window is `ok`.
- TCA freshness <= `24h`.
- Doc29 simulation and paper prerequisites are satisfied.

Measure:

- valid paper opportunities per session;
- stale-proof rejection rate;
- next-session paper PnL;
- drawdown;
- average absolute slippage.

Guardrail:

- max paper notional starts at the warrant value and defaults to `0` until all entry gates pass;
- rollback if scoped ingestion lag exceeds `60s` for two consecutive checks.

### Hypothesis B: Post-Cost TCA Refresh Prevents False Positive Alpha

Claim: Requiring fresh expected-shortfall coverage and strategy-family slippage budgets before paper will prevent
microbar candidates from entering when their apparent edge is consumed by execution cost.

Entry:

- TCA freshness <= `24h`;
- expected shortfall coverage > `95%`;
- average absolute slippage <= the family budget;
- runtime decisions have matching execution/order-feed coverage.

Measure:

- post-cost edge bps;
- slippage distribution p50 and p95;
- execution coverage;
- rejected candidate count;
- realized paper drawdown.

Guardrail:

- if average absolute slippage exceeds budget by more than `2x`, the warrant downgrades to repair-only for that family.

### Hypothesis C: Forecast And Market-Context Authority Improves Selection Quality

Claim: Non-placeholder forecast authority plus fresh market context will improve paper selection quality for chip
microbar candidates compared with the current scaffold-backed forecast path.

Entry:

- at least one promotion-authority-eligible forecast model for the strategy family;
- market-context route p95 <= `2s`;
- domain freshness within configured thresholds;
- quality score >= `0.75`;
- no unresolved Jangar paper contradiction.

Measure:

- information ratio delta versus no-forecast shadow baseline;
- hit rate;
- stale-entry rejection rate;
- forecast calibration error;
- missed opportunity count.

Guardrail:

- paper only; live remains blocked until paper settlement and TCA gates pass.

## Implementation Scope

Engineer stage should implement the receipt surface before changing capital behavior.

- Add an alpha truth-window builder in Torghut, preferably outside the large scheduler pipeline.
- Expose it through a small DB-backed route, for example `/trading/alpha/truth-window`, and include the latest window
  ref in `/trading/status` and `/trading/health`.
- The route must summarize counts and freshness from existing DB-backed surfaces without exposing secrets or requiring
  pod exec.
- Feed it from:
  - Jangar proof truth window ref;
  - scoped quant health;
  - proof floor;
  - TCA summary;
  - runtime profitability window;
  - doc29 completion status;
  - empirical jobs;
  - forecast runtime status;
  - market-context status.
- Add tests proving:
  - global quant `ok` plus scoped ingestion stale blocks paper;
  - fresh empirical jobs do not bypass stale TCA;
  - direct DB witness denial is represented as service-owned evidence required, not as paper authority;
  - doc29 blocked gates keep paper and live warrants held;
  - only a contradiction-free alpha truth window can issue a non-zero paper warrant.

Deployer stage should validate the route and gates from permitted reads first. Privileged SQL can be used for incident
forensics, but it must not be the normal warrant source.

## Validation Gates

Required local and CI validation for engineer implementation:

- `cd services/torghut && uv sync --frozen --extra dev`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py tests/test_profitability_proof_floor.py tests/test_tca_adaptive_policy.py`
- `bunx oxfmt --check docs/agents/designs docs/torghut/design-system/v6`

Required deployer validation:

- `curl /db-check` reports the expected Alembic head.
- `curl /trading/status` includes the latest alpha truth-window ref.
- `curl /trading/health` returns within `5s` and reports the same capital effect as the alpha truth window.
- `curl /trading/alpha/truth-window` shows no unresolved paper contradictions before any paper warrant is enabled.
- Jangar status shows the upstream proof truth window current and contradiction-free for `paper_canary`.
- Scoped quant health for the live account/window is current during market hours.

## Rollout

1. Ship alpha truth windows in observe-only mode.
2. Compare their capital effect against the existing proof floor for at least one market session.
3. Make `/trading/health` read the latest settled alpha truth window instead of recomputing every proof family inline.
4. Enable paper warrants only for candidates with contradiction-free paper windows.
5. Keep live warrants disabled until paper settlement and live micro validation both pass.

## Rollback

- If the truth-window route fails, keep existing proof-floor behavior and mark the latest window stale.
- If `/trading/health` latency regresses, remove the truth-window dependency from health and continue exposing it as an
  observe-only route.
- If warrants are too strict, lower repair bid priority thresholds before changing paper/live safety gates.
- If a non-zero warrant is issued incorrectly, immediately set the warrant family to `hold`, keep `simple_submit`
  disabled, and require a fresh Jangar proof truth window before retry.

## Risks

- Warrant thresholds may initially keep paper blocked while repair evidence is being generated.
- Some proof families are currently endpoint-derived, so route latency needs disciplined budgets.
- Forecast proof may stay degraded until real promotion-authority artifacts exist.
- Historical TCA has very high absolute slippage, so the first TCA refresh may block more candidates than it unlocks.
- The design depends on Jangar exposing proof truth windows; until then Torghut should treat the upstream ref as
  missing and keep paper/live held.

## Handoff

Engineer acceptance:

- Torghut emits alpha truth windows and capital reentry warrants.
- Existing status and health surfaces cite the latest window.
- Tests cover scoped/global contradictions, fresh empirical versus stale TCA, doc29 blocked gates, and warrant expiry.
- No capital behavior changes until the route is validated in observe-only mode.

Deployer acceptance:

- Service-owned routes provide the DB/data evidence needed for normal validation.
- Paper remains held until a contradiction-free paper warrant exists.
- Live remains held until paper settlement, fresh TCA, scoped quant health, and Jangar truth-window gates pass.
- Rollback returns to the existing proof-floor-only behavior without database mutation.
