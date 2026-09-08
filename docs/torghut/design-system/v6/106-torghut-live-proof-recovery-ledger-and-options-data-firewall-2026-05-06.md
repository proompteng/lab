# 106. Torghut Live Proof Recovery Ledger And Options Data Firewall (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: options data/control lane exists; options trading authority remains separate and gated.
- Matched implementation area: Options lane.
- Current source evidence:
  - `services/torghut/app/options_lane/settings.py`
  - `services/torghut/app/options_lane/catalog_service.py`
  - `services/torghut/app/options_lane/enricher_service.py`
  - `argocd/applications/torghut-options/ws/deployment.yaml`
  - `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
- Design drift note: March/options text must be checked against current `options_lane` source and `torghut-options` GitOps before use.


## Decision

I am choosing a **live proof recovery ledger with an options data firewall** for Torghut.

The cluster is healthier than the earlier soak suggested. Argo is healthy and synced. Torghut live and simulation are on
current revisions `torghut-00229` and `torghut-sim-00310`, both running at `2/2`. Equity TA, simulation TA, and options
TA Flink jobs are running. Torghut live `/healthz` returns 200, and simulation `/readyz` plus `/trading/health` return 200.

That does not mean Torghut is profit-authoritative. Live `/readyz` and `/trading/health` return 503. The live account
`PA3SX7FYNUTF` has stale Jangar quant metrics from May 5 while generic metrics are fresh on May 6. Empirical jobs are
stale from March 21. `execution_tca_metrics` has 13,775 rows, but `execution_order_events` has zero rows. ClickHouse
equity TA tables are populated through the last market session, while all options feature tables are empty. Options
catalog is ready, but its health payload still exposes an upstream TLS-handshake error detail.

The chosen architecture turns this into a recovery system instead of another no-go report. Torghut will project one
ledger row per live proof gap, map each gap to a repair lane with acceptance criteria, and keep options hypotheses
behind a data firewall until options bars, features, and quote quality exist. Capital can move only when the ledger says
the proof gap is retired, Jangar's capital proof firewall allows the action class, and post-cost hypothesis evidence is
current for the account and window.

The tradeoff is that the fastest live path is not a live path. It is a proof recovery path. I accept that because
current evidence says Torghut has market data and route liveness, not closed-loop profit proof.

## Read-Only Evidence Snapshot

No Kubernetes resources, database records, or trading settings were changed during this assessment.

### Cluster And Route Evidence

- Argo reported `torghut`, `torghut-options`, `symphony-torghut`, `jangar`, `agents`, and `agents-ci` as `Healthy` and
  `Synced`.
- `kubectl get pods -n torghut -o wide` showed live `torghut-00229-deployment-b564df89-944pn` and simulation
  `torghut-sim-00310-deployment-6cbdcb9d95-kgwc8` at `2/2 Running`.
- Torghut Postgres, ClickHouse, Keeper, options catalog, options enricher, equity TA, simulation TA, options TA,
  websockets, Alloy, and guardrail exporters were running.
- `kubectl get deploy -n torghut -o wide` showed live, simulation, options catalog, and options enricher on Torghut
  digest `sha256:37d1fb2b36cff3107969ec9532a4ff3c13399fe7001b378b030a60c5d98fa203`.
- Equity TA ran digest `sha256:4d43f2a5c308cef923f66419c395903981127aedef919ff0e0c1b4fc895a4503`; simulation TA ran
  digest `sha256:20fe1818a7c5239d58d4e3888804163025b9b3b2ee1a1674fd7db77007f682af`; options TA ran digest
  `sha256:9016052d30c4f06f9726e516b8048725f0f48c0fa64dcbeaac0e8993a5254a9b`.
- Flink REST endpoints reported equity TA, simulation TA, and options TA jobs in `RUNNING` state.
- Recent Torghut events still included repeated ClickHouse PodDisruptionBudget match warnings and an options TA status
  conflict warning, even though the jobs were running.
- Live `/healthz` returned HTTP 200.
- Live `/readyz` and `/trading/health` returned HTTP 503 with Postgres, ClickHouse, and Alpaca healthy but capital
  readiness degraded.
- Live `/trading/status` returned HTTP 200 with `mode=live`, `pipeline_mode=simple`, `execution_lane=simple`,
  `kill_switch_enabled=false`, active revision `torghut-00229`, and `capital_stage_totals.shadow=3`.
- Simulation `/readyz` and `/trading/health` returned HTTP 200 with `mode=paper`, active revision `torghut-sim-00310`,
  and the same shadow-first posture.
- `/quant-health` on Torghut returned 404, which is correct because typed quant-health is Jangar-owned, not a Torghut
  local route.
- Options catalog `/healthz` and `/readyz` returned ready, but included `last_error_detail` showing an upstream TLS
  handshake timeout.
- Options enricher `/healthz` and `/readyz` returned ready with `last_success_ts=2026-05-06T05:10:32Z`.

### Database And Data Evidence

- Torghut Postgres connected as `torghut_app` to database `torghut` at `2026-05-06T05:12:39Z`.
- Torghut Postgres had 71 public tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- `vnext_empirical_job_runs` had 16 rows; latest update was `2026-03-21T09:03:22Z`.
- `execution_tca_metrics` had 13,775 rows; latest update was `2026-04-03T05:32:36Z`.
- `execution_order_events` had zero rows.
- `simulation_run_progress`, `strategy_hypotheses`, and `whitepaper_claims` were empty in the direct sample.
- ClickHouse `torghut.ta_microbars` had 1,676,707 rows with max window end `2026-05-05T20:59:07Z` and max ingest
  `2026-05-05T20:59:32Z`.
- ClickHouse `torghut.ta_signals` had 1,176,729 rows with max event time `2026-05-05T20:59:07Z` and max ingest
  `2026-05-06T02:34:17Z`.
- ClickHouse `torghut.options_contract_bars_1s`, `torghut.options_contract_features`, and
  `torghut.options_surface_features` each had zero rows.
- `torghut_sim_default.ta_microbars` and `torghut_sim_default.ta_signals` each had zero rows.
- Jangar `torghut_control_plane.quant_metrics_latest` had fresh generic-account rows through `2026-05-06T05:13Z`, but
  live account `PA3SX7FYNUTF` rows were stale from `2026-05-05T17:27Z` through `2026-05-05T19:13Z`.
- Jangar `torghut_control_plane.simulation_runs` was stale, with latest failed run evidence on March 19 and latest
  succeeded/running/submitted evidence on March 13-14.

### Source Evidence

- `services/torghut/app/main.py` is 4,042 lines and composes readiness, trading health, empirical jobs, shadow-first
  status, live submission gates, quant evidence, metrics, and trading APIs.
- `services/torghut/app/trading/submission_council.py` is 1,196 lines and already owns `load_quant_evidence_status`,
  `build_live_submission_gate_payload`, capital stage resolution, empirical readiness, promotion eligibility, and
  simple-submit blocking.
- `services/torghut/app/trading/autonomy/lane.py` is 7,377 lines and owns the largest empirical and promotion surface.
- `services/torghut/app/trading/execution.py` is 1,612 lines and `order_feed.py` is 612 lines. The schema has broker
  event concepts, but production `execution_order_events` is empty.
- `services/torghut/app/options_lane/repository.py` owns the options contract catalog and enrichment stores. The
  options route is alive, but feature tables are not yet populated.
- Torghut has broad tests for empirical jobs, submission council, order feed, execution adapters, TCA, options lane,
  risk, universe, simulations, strategy runtime, property tests, and quant readiness. The missing regression is a single
  reducer proving stale account quant, stale empirical jobs, empty broker events, and empty options features combine
  into deterministic repair lanes and no capital authority.

## Problem

Torghut's current state is a classic dangerous middle: operationally alive, data-rich in equities, but not
closed-loop enough to justify capital.

1. **Live route health is not live proof.** Live liveness and broker connectivity pass while live readiness and trading
   health correctly degrade.
2. **Account freshness and generic freshness diverge.** Generic Jangar quant rows are fresh; the live account is not.
3. **Empirical and broker-event proof are stale or absent.** Replay evidence is March 21, and broker event rows are
   zero despite TCA history.
4. **Options services are ready before options data exists.** Catalog and enricher are alive, but options ClickHouse
   feature tables are empty.
5. **Simulation proof is not current.** Simulation route health is green, but Jangar simulation rows and simulation
   ClickHouse tables are stale or empty.
6. **The code has the primitives but lacks one recovery ledger.** Readiness, submission gates, empirical status,
   options data, and order events are spread across large modules and stores.

The next architecture must answer which proof gap blocks capital, which lane owns repair, how profitability will be
measured after repair, and when deployers must roll back.

## Alternatives Considered

### Option A: Keep Live Disabled And Wait For Manual Review

Pros:

- Safest immediate posture.
- Matches current degraded live readiness.
- Requires no new projection.

Cons:

- Does not retire stale empirical jobs.
- Does not create broker-event reconciliation.
- Does not separate equity repair from options bootstrap.
- Produces another static no-go report rather than a repair system.

Decision: reject as the target architecture. Manual review remains a final approval gate, not the system of record.

### Option B: Promote The Best Equity Hypothesis After Jangar Is Healthy

Pros:

- Jangar is healthier now than during the earlier soak.
- Equity TA data is populated and current through the last market session.
- Live route and broker checks prove the service can reach required dependencies.

Cons:

- Live account quant proof is stale.
- Empirical jobs are stale.
- Broker-event reconciliation is empty.
- Simulation proof is stale or empty.

Decision: reject. This path mistakes route recovery for profit recovery.

### Option C: Live Proof Recovery Ledger And Options Data Firewall

Pros:

- Converts every no-go reason into a repair lane with measurable acceptance.
- Lets equity repair move without letting options bootstrap leak into capital routing.
- Gives Jangar a clean consumer contract through the companion capital proof firewall.
- Makes broker-event reconciliation a first-class promotion blocker.
- Supports ambitious options innovation without pretending empty feature tables are ready.

Cons:

- Adds a new projection and reducer tests.
- Requires account/window normalization across Jangar and Torghut.
- Paper/live promotion waits for proof retirement.

Decision: select Option C.

## Chosen Architecture

### LiveProofRecoveryLedger

Torghut should project one current row per account, window, strategy family, and proof gap.

```text
live_proof_recovery_ledger
  recovery_id
  account
  window
  strategy_family              # equity_intraday, options_intraday, market_context, execution_reconcile
  proof_gap                    # account_quant_stale, empirical_stale, broker_events_missing,
                               # options_features_empty, simulation_store_stale, catalog_upstream_error
  proof_state                  # fresh, stale, missing, contradictory, blocked
  repair_lane                  # quant_metrics_rebuild, empirical_replay, broker_event_backfill,
                               # options_feature_bootstrap, simulation_reseed, catalog_upstream_repair
  permitted_capital_stage      # observe, repair, paper_candidate, live_candidate, blocked
  expected_net_edge_bps
  expected_cost_bps
  drawdown_limit_bps
  required_sample_count
  observed_sample_count
  source_refs[]
  jangar_firewall_ref
  fresh_until
  reason_codes[]
```

Initial reducer rules:

- If live account quant metrics are stale or missing, `permitted_capital_stage=repair`.
- If empirical jobs are older than the configured stale threshold, `permitted_capital_stage=repair`.
- If `execution_order_events` is empty, paper and live are blocked by `broker_events_missing`.
- If options feature tables are empty, options strategies are `repair` under `options_feature_bootstrap`.
- If options catalog is ready but carries upstream error detail, options contract discovery remains observe-only until
  two consecutive clean discovery cycles.
- If Jangar capital proof firewall is `repair_only`, Torghut cannot advance beyond repair even if local checks pass.
- Only fresh account quant proof, fresh empirical proof, non-empty broker events, and non-negative post-cost edge can
  create a `paper_candidate`.

### OptionsDataFirewall

Options hypotheses remain behind a data firewall until minimum data exists.

Minimum release gates:

- `options_contract_bars_1s` has rows for the selected liquid contract universe.
- `options_contract_features` has non-null spread, quote quality, and microstructure fields.
- `options_surface_features` has enough rows to compare skew, term structure, and realized-vol dislocation.
- Catalog has two consecutive discovery cycles with no upstream TLS or auth error detail.
- Jangar firewall permits at least `repair` and then `paper_candidate` for the options action class.

### Measurable Hypothesis Lanes

Equity live proof recovery:

- Hypothesis: current equity TSMOM/opening-session signals can produce positive post-cost edge once account proof and
  broker reconciliation are current.
- Initial paper gate: account quant metrics fresh within 15 minutes, empirical replay fresh within 24 hours,
  `execution_order_events > 0`, expected net edge at least 8 bps after estimated cost, and drawdown limit at or below
  60 bps for the test window.
- Guardrail: if rejection drag or realized slippage exceeds 50 percent of expected edge, stay in repair.

Options bootstrap:

- Hypothesis: options opening-gap and skew-dislocation signals can outperform equity-only repair lanes during high
  realized-vol sessions.
- Initial data gate: non-empty options bars, features, and surface features for the liquid contract universe; spread
  quality within policy; no catalog upstream errors for two cycles.
- Initial paper gate: expected net edge at least 12 bps after spread and fee cost, minimum 100 qualified contract
  samples, and no single-underlier concentration above 25 percent.
- Guardrail: options cannot reach live while broker-event reconciliation is missing.

No-trade profit protection:

- Hypothesis: explicit no-trade decisions reduce negative expected value when proof is stale or route evidence is
  contradictory.
- Gate: every blocked capital decision must cite a proof gap and estimated avoided loss or avoided uncertainty band.
- Guardrail: if no-trade blocks persist for more than one session without a repair action, the lane escalates to
  operator review.

## Implementation Scope

Engineer stage:

- Add a Torghut migration for `live_proof_recovery_ledger`.
- Add a reducer that joins live submission gate payload, empirical job status, Jangar quant freshness, broker-event
  counts, options feature counts, simulation freshness, and Jangar capital proof firewall state.
- Add `/trading/proof-recovery` or an equivalent status section under `/trading/status`.
- Add deterministic tests for stale live account metrics, stale empirical jobs, empty broker events, empty options
  features, catalog upstream errors, and Jangar repair-only firewall decisions.
- Add options bootstrap tests that prevent paper/live promotion when options tables are empty.
- Add one migration or backfill plan for broker-event reconciliation if existing order-feed data can be recovered.

Deployer stage:

- Deploy the ledger in shadow mode.
- Verify live and simulation routes report the same recovery IDs for the same proof gaps.
- Keep live submission disabled while proof recovery is shadowing.
- Enable paper-candidate evaluation only after account quant, empirical, and broker-event proof are fresh.
- Keep options in data-only repair until all options data firewall gates pass.

## Validation Gates

Local and CI gates:

- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pytest services/torghut/tests/test_empirical_jobs.py`
- `uv run --frozen pytest services/torghut/tests/test_order_feed.py`
- `uv run --frozen pytest services/torghut/tests/test_options_lane.py`
- `uv run --frozen pytest services/torghut/tests/test_verify_quant_readiness.py`
- `bunx oxfmt --check docs/torghut/design-system/v6/106-torghut-live-proof-recovery-ledger-and-options-data-firewall-2026-05-06.md`

Cluster and data gates:

- Live `/healthz` returns 200.
- Live `/readyz` and `/trading/health` may remain 503 during repair, but the response names the same recovery ledger
  reasons as `/trading/status`.
- Simulation `/readyz` and `/trading/health` remain 200 unless proof recovery detects a simulation-specific data gap.
- Torghut Postgres Alembic head remains `0029_whitepaper_embedding_dimension_4096` or the new migration head after the
  engineer stage lands.
- `vnext_empirical_job_runs.max(updated_at)` is within the configured stale threshold before paper promotion.
- `execution_order_events.count > 0` before paper/live promotion.
- Live account `PA3SX7FYNUTF` quant metrics are fresh for the target windows.
- Options feature tables are non-empty before any options paper candidate is emitted.
- Jangar capital proof firewall allows the requested action class.

## Rollout Plan

1. Shadow: publish recovery ledger rows without changing live submission decisions.
2. Repair: allow scheduled repair lanes for quant metrics, empirical replay, broker-event reconciliation, options
   feature bootstrap, simulation reseed, and catalog upstream cleanup.
3. Paper candidate: allow equity paper candidates only after account quant, empirical, broker-event, and Jangar firewall
   gates pass.
4. Options data: allow options hypotheses to produce paper candidates only after the options data firewall passes.
5. Live canary: require manual approval plus two fresh paper windows with positive post-cost edge and no guardrail
   breach.

## Rollback Plan

- Disable the recovery ledger consumer and fall back to current live submission gate behavior.
- Keep ledger writes in shadow mode for audit evidence.
- If the ledger produces false holds, mark the affected proof gap `observe_only` and require a regression before
  re-enabling enforcement.
- If options bootstrap produces bad data, disable the options data firewall producer and keep options hypotheses in
  data-only repair.
- If broker-event backfill is wrong, block paper/live and rebuild reconciliation from the source order feed.

## Risks And Mitigations

- **Repair work may become the new blocker.** Mitigate with per-gap owners, fresh-until timestamps, and escalation when
  no repair action happens within a session.
- **Options data may look populated but be untradeable.** Mitigate with spread quality, quote quality, and concentration
  gates before paper candidates.
- **Generic quant freshness may mask account staleness.** Mitigate by making account/window proof mandatory for capital.
- **Broker-event reconciliation may require historical source gaps.** Mitigate by starting with current forward capture
  and treating backfill as a separate repair lane.
- **Jangar firewall may hold too much work during rollout.** Mitigate with shadow mode and action-class-specific repair
  allowance.

## Handoff Contract

Engineer acceptance:

- A reducer test proves stale live account quant metrics produce `repair` and block paper/live.
- A reducer test proves stale empirical jobs produce `repair` and name `empirical_replay`.
- A reducer test proves zero `execution_order_events` blocks paper/live even when TCA metrics exist.
- A reducer test proves empty options feature tables block options paper candidates.
- A reducer test proves Jangar `repair_only` firewall state holds Torghut capital stage below paper.
- `/trading/status` or `/trading/proof-recovery` exposes stable recovery IDs and reason codes.

Deployer acceptance:

- Shadow ledger rows are visible for live and simulation before enforcement.
- Repair lanes run without changing live submission.
- Paper candidates are not emitted until all cluster and data gates pass.
- Options hypotheses remain data-only until the options data firewall passes.
- Rollback is a config-only action that returns Torghut to the current live submission gate without data loss.
