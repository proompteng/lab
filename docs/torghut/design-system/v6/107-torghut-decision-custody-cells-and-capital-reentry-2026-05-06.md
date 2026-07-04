# 107. Torghut Decision Custody Cells And Capital Reentry (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Torghut GitOps, migrations, release workflows, and scripts exist; post-deploy verification wiring has changed over time.
- Matched implementation area: CI/CD, release, GitOps, Argo, Knative, and deployment automation.
- Current source evidence:
  - `argocd/applications/torghut/knative-service.yaml`
  - `argocd/applications/torghut/db-migrations-job.yaml`
  - `.github/workflows/torghut-ci.yml`
  - `.github/workflows/torghut-release.yml`
  - `packages/scripts/src/torghut/update-manifests.ts`
- Design drift note: Deployment docs must be checked against current workflows because old names have been retired or replaced.


## Decision

I am choosing **decision custody cells and capital warrants before sizing** as the next Torghut profitability
architecture.

Torghut is live in the narrow operational sense. The service is on `torghut-00231`, the scheduler is running, Postgres
and ClickHouse are healthy, Alpaca returns broker OK for `PA3SX7FYNUTF`, and the Jangar universe has 12 fresh symbols.
That is not enough for capital. `/trading/status` shows `capital_stage=shadow`, `simple_submit_disabled`, no autonomy
promotion, no live promotion, and dependency quorum blocked by stale empirical jobs. The newest sampled decisions from
May 4 were rejected before submit for `insufficient_buying_power`, while the latest sampled executions are canceled
orders from April 2.

The current architecture lets strategy intent, sizing, proof freshness, and live capital authority meet too late. A
decision can exist with a large target notional before Torghut has a current warrant proving that this hypothesis,
account, window, and rollout state can spend live capital. I am moving that boundary earlier. A strategy can produce
shadow evidence without a warrant. A live decision needs a warrant first, and the warrant owns max notional, max order
count, freshness, and rollback terms.

The tradeoff is less apparent trading activity in the short term. I accept that because rejected decisions and stale
proofs are not trading activity. They are unpriced risk and noisy evidence.

## Read-Only Evidence Snapshot

No Kubernetes resources, database records, or trading settings were changed during this assessment.

### Cluster And Runtime Evidence

- `kubectl get pods -n torghut -o wide` showed live `torghut-00231` and simulation `torghut-sim-00312` at `2/2`
  Running, plus ClickHouse, Keeper, Torghut Postgres, equity TA, simulation TA, options TA, options catalog, options
  enricher, websockets, and guardrail exporters running.
- `kubectl get deploy -n torghut -o wide` showed live and simulation Knative revisions available, options catalog and
  options enricher available, and TA deployments available.
- Recent events showed startup/readiness probe flaps during the current Knative rollout, multiple ClickHouse
  PodDisruptionBudget matches, and a Flink options status conflict.
- `/healthz` returned OK.
- `/readyz` returned degraded while scheduler, Postgres, ClickHouse, Alpaca, database schema, and universe checks were
  OK.
- `/trading/health` returned degraded for the same reason: the live path is blocked by proof and capital state, not by
  route death.
- `/db-check` returned schema current at `0029_whitepaper_embedding_dimension_4096`.

### Data And Profitability Evidence

- Direct database exec is forbidden for this service account, and ClickHouse requires credentials, so this pass used
  Torghut and Jangar read-only API projections.
- Jangar typed quant health for `PA3SX7FYNUTF` returned latest account metrics from `2026-05-05T17:28:03.839Z`, while
  Torghut marks quant health `not_required`.
- `/trading/empirical-jobs` reported stale `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` jobs from `2026-03-21T09:03:22Z`.
- `/trading/profitability/runtime` showed 8 decisions and 0 executions in the 72-hour runtime window.
- `/trading/decisions?limit=5` showed recent `microbar-volume-continuation-long-top2-v11` decisions rejected before
  submit for `insufficient_buying_power`.
- Those rejected decisions requested roughly `157950.10` notional while the precheck buying power was roughly
  `141543.88`, so sizing was not bounded by current available capital before persistence.
- `/trading/executions?limit=5` returned canceled April 2 executions in the sample.
- `/trading/tca` retained 13,775 historical rows with `last_computed_at=2026-04-02T20:59:45Z`, but expected shortfall
  coverage is zero.
- `/trading/status` reported three hypotheses, with two in shadow and one blocked; all three require rollback and none
  are promotion eligible.

### Source Evidence

- `services/torghut/app/main.py` owns the API projection surface for readiness, trading status, trading health,
  decisions, executions, runtime profitability, and TCA.
- `services/torghut/app/trading/scheduler/pipeline.py` owns the large hot path for signal conversion, sizing,
  submission, market context, and live submission gates.
- `services/torghut/app/trading/submission_council.py` already owns quant evidence, empirical readiness, promotion
  eligibility, and capital stage resolution.
- The source tree has broad tests for scheduler autonomy, strategy runtime, empirical jobs, order feed, execution
  adapters, risk, TCA, and quant readiness.
- The missing test gap is a warrant-first reducer: stale empirical proof, optional account quant, and insufficient
  buying power must prevent live notional persistence while preserving shadow evidence.

## Problem

Torghut has the pieces for safe autonomy, but the proof boundary is in the wrong place.

1. Live route health is allowed to sit next to shadow capital state without a single warrant object explaining the
   difference.
2. Strategy runtime can produce high-quality intent while empirical proof is stale.
3. The scheduler can size a decision before current account capacity is part of the contract.
4. Rejected pre-submit decisions become noisy negative evidence instead of earlier budgeted shadow evidence.
5. Promotion gates are distributed across readiness, status, empirical jobs, quant health, TCA, and Jangar quorum.

The next design has to make profitability measurable again. That means every hypothesis needs a current warrant,
explicit budget, conversion target, and rollback trigger before live capital is even considered.

## Alternatives Considered

### Option A: Keep Live Submission Disabled And Continue Shadow Observation

Pros:

- Safe for capital.
- Matches current `simple_submit_disabled` posture.
- Requires no immediate code change.

Cons:

- Does not reduce stale empirical proof.
- Does not fix target-notional sizing before reject.
- Does not define when a hypothesis can reenter capital.

Decision: reject as architecture. It is a holding pattern, not a capital program.

### Option B: Repair Empirical Jobs First, Then Reopen The Existing Simple Lane

Pros:

- Addresses the largest current dependency-quorum blocker.
- Reuses existing simple-lane code.
- Keeps implementation smaller.

Cons:

- Still lets account quant be optional.
- Still lets sizing happen before a warrant.
- Does not isolate hypotheses with different proof quality.
- Does not turn rejection ratios into rollback triggers.

Decision: reject as the full design. Empirical repair is necessary but not sufficient.

### Option C: Warrant-First Decision Custody Cells

Pros:

- Moves capital authority before sizing.
- Makes stale empirical proof and stale account quant first-class blockers.
- Lets shadow evidence continue while capital is blocked.
- Gives each hypothesis measurable profit and reject thresholds.
- Aligns Torghut with Jangar's rollout proof exchange.

Cons:

- Requires a new adapter between Jangar custody cells and Torghut scheduler state.
- Requires tests around a hot path that is already large.
- Slows first live canary until proof freshness is current.

Decision: select Option C.

## Chosen Architecture

Torghut consumes a current Jangar custody cell and converts it into a local capital warrant:

```text
hypothesis_capital_warrant
  warrant_id
  account_label
  hypothesis_id
  strategy_id
  strategy_family
  action_class                    # shadow_decide, paper_canary, live_micro_canary, live_scale
  max_notional
  max_orders
  max_participation_rate
  evidence_window
  empirical_jobs_fresh
  account_quant_fresh
  broker_events_fresh
  tca_fresh
  issued_at
  expires_at
  reason_codes[]
  rollback_terms[]
```

Scheduler rules:

- Without a warrant, Torghut may emit shadow-only evidence but must not persist a live notional.
- With a `shadow_decide` warrant, Torghut records intent, features, forecasts, and would-have-sized budgets.
- With a `paper_canary` warrant, Torghut may submit to paper or simulation only.
- With a `live_micro_canary` warrant, Torghut sizes by the warrant's `max_notional`, current buying power, symbol
  exposure, and hypothesis cap, choosing the smallest limit.
- With a `live_scale` warrant, Torghut may widen only after settled post-cost evidence and broker-event reconciliation.

## Measurable Trading Hypotheses

H-CONT-01, continuation:

- Entry: signal lag <= 90 seconds during market hours, fresh empirical jobs <= 24 hours old, account quant <= 60
  seconds old during market hours, and no Jangar dependency block.
- Micro-canary: at least 40 shadow decisions, reject ratio < 2 percent, average absolute slippage <= 12 bps, and
  post-cost expectancy proxy >= 6 bps.
- Rollback: two consecutive windows below 0 bps post-cost expectancy or any broker-event reconciliation gap.

H-MICRO-01, microstructure breakout:

- Entry: required microstructure features present, feature batch rows > 0, drift checks current, and average absolute
  slippage <= 8 bps.
- Micro-canary: at least 60 shadow decisions, reject ratio < 1 percent, expected shortfall coverage > 90 percent, and
  post-cost expectancy proxy >= 10 bps.
- Rollback: stale feature coverage, drift incident, or slippage above 12 bps.

H-REV-01, event reversion:

- Entry: market context freshness <= 120 seconds when required, account quant current, and signal lag <= 90 seconds.
- Micro-canary: at least 30 shadow decisions, reject ratio < 2 percent, post-cost expectancy proxy >= 8 bps, and no
  market-context stale alerts.
- Rollback: stale market context, negative post-cost window, or Jangar custody cell downgrade.

Sizing hypothesis:

- Moving capital warrants before sizing should reduce `insufficient_buying_power` pre-submit rejects below 1 percent
  of live decisions and keep live decision conversion above 50 percent in micro-canary windows.

## Validation Gates

Engineer acceptance:

- Add unit coverage for warrant parsing and expiry.
- Add scheduler coverage proving missing warrants create shadow evidence only.
- Add sizing coverage proving warrant max notional and buying power clamp before persistence.
- Add regression coverage for stale empirical jobs and optional account quant blocking live warrants.

Deployer acceptance:

- `/readyz` must remain schema-current and dependency checks must not time out.
- `/trading/status` must show active capital stage aligned with the current warrant.
- `/trading/empirical-jobs` must be ready before any paper or live canary.
- Jangar typed quant health must be fresh for `PA3SX7FYNUTF` during market hours.
- `/trading/profitability/runtime` must show fresh decisions, current execution settlement when live, and reject ratios
  under the hypothesis threshold.

## Rollout

1. Add the warrant adapter in observe mode and compare it with the current live submission gate.
2. Enforce missing or expired warrants as shadow-only.
3. Repair empirical job freshness and account-scoped quant enforcement.
4. Enable one paper canary for one hypothesis.
5. Enable one live micro-canary with a small notional cap only after broker-event reconciliation is current.
6. Scale only when the hypothesis meets its post-cost target and rollback rehearsal is complete.

## Rollback

- Missing or expired warrant: downgrade to shadow-only.
- Jangar custody cell hold or block: stop live decisions immediately.
- Empirical jobs stale: downgrade to repair-only plus shadow evidence.
- Account quant stale during market hours: downgrade to shadow-only.
- `insufficient_buying_power` pre-submit rejects >= 1 percent: downgrade to paper canary.
- Broker-event reconciliation missing after submit: block live until reconciled.
- Post-cost expectancy below threshold for two windows: disable that hypothesis and preserve evidence for repair.

## Risks

- Warrant enforcement can reduce decision volume. That is acceptable if rejected live decisions are replaced by
  explainable shadow evidence.
- Current TCA history is old and expected-shortfall coverage is zero. The first engineer stage must refresh
  settlement before treating TCA as promotion evidence.
- Account quant health is currently not required by Torghut. The deployer stage must make it required before paper or
  live canary.
- The scheduler hot path is large. Keep the adapter small and make it return a plain budget object before deeper
  refactors.

## Handoff Contract

Engineer stage should implement the warrant adapter, scheduler budget clamp, custody-cell ingestion, and tests.

Deployer stage should run one full market-session shadow comparison before enabling paper or live canary. Do not widen
capital because Torghut liveness or Jangar rollout health is green. Widen only from a fresh warrant for one account, one
hypothesis, one strategy, and one explicit notional cap.
