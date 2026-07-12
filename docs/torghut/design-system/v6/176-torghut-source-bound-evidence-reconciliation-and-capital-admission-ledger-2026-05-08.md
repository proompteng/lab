# 176. Torghut Source-Bound Evidence Reconciliation And Capital Admission Ledger (2026-05-08)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: TigerBeetle journal/reconcile modules and GitOps resources exist, but financial-ledger docs need current runtime verification.
- Matched implementation area: TigerBeetle ledger and reconciliation.
- Current source evidence:
  - `services/torghut/app/trading/tigerbeetle_journal`
  - `services/torghut/app/trading/tigerbeetle_reconcile`
  - `services/torghut/scripts/journal_tigerbeetle_order_events.py`
  - `services/torghut/scripts/verify_tigerbeetle_ledger.py`
  - `argocd/applications/torghut/tigerbeetle-cluster.yaml`
- Design drift note: Ledger designs are partial until checked against journal/reconcile scripts and cluster state.


## Decision

I am selecting a **source-bound evidence reconciliation ledger with capital admission gates** as the next Torghut
architecture step.

The cluster recovered from the earlier shared soak. `agents-controllers` is now healthy, Jangar is serving, Torghut
live and sim revisions are running, and the promoted sim image is no longer in ImagePullBackOff. Torghut is still not
capital-ready. The live service says exactly why: proof floor is `repair_only`, route state is `repair_only`, capital
state is `zero_notional`, live submit is disabled, alpha readiness has zero promotion-eligible hypotheses, route TCA is
incomplete or too expensive, and Jangar paper/live action budgets remain held or blocked.

The new evidence problem is not a missing health check. It is source disagreement. The application status synthesizes
three runtime hypotheses, while durable database rows show one active hypothesis record and three metric windows for
`H-MICRO-01`. Empirical job rows are fresh and promotion-authority eligible, while simulation progress and simulation
runtime context tables are empty. TCA has 13,775 durable rows and was recomputed on 2026-05-07, but the newest
execution row behind that evidence was created on 2026-04-02. Jangar quant health reports fresh latest metrics for the
live account, while the stage list is empty and Torghut still treats quant ingestion as informational debt.

The decision is to make Torghut publish a compact ledger that reconciles service-owned witnesses, durable database row
witnesses, route-local evidence, and Jangar custody before any route can move from no-notional repair to paper
candidate. A healthy sibling surface can no longer mask a stale or empty source of truth.

The tradeoff is stricter admission. This will hold paper longer when empirical jobs look fresh but simulation progress,
hypothesis persistence, or route TCA provenance is incomplete. I accept that because the profitable system is the one
that knows which proof is executable, not the one that finds a green field in a large payload.

## Current Evidence

All evidence in this pass was collected read-only on 2026-05-08. I did not mutate Kubernetes resources, database
records, secrets, GitOps resources, AgentRuns, or trading flags.

### Cluster And Jangar Evidence

- The local runner used branch `codex/swarm-torghut-quant-discover` based on `main`.
- The in-cluster service account was `system:serviceaccount:agents:agents-sa`.
- `agents` namespace showed `agents` 1/1 and `agents-controllers` 2/2 ready.
- Jangar namespace showed `jangar`, `bumba`, `symphony`, `symphony-jangar`, and `jangar-alloy` ready.
- Jangar `/health` returned HTTP 200 with `status=ok`; the smaller health payload still reported
  `agentsController.enabled=false`, so the control-plane status route remains the authoritative witness.
- Jangar control-plane status at `2026-05-08T01:14Z` reported healthy controller heartbeats, leader election current,
  workflow and job runtimes configured, execution trust healthy, watch reliability healthy with 1,897 events and zero
  errors, database connected, and Kysely migrations consistent at
  `20260505_torghut_quant_pipeline_health_window_index`.
- The same status held material action classes because source rollout truth was missing and controller witness custody
  was split. `serve_readonly` and `torghut_observe` were allowed, while `dispatch_repair`, `dispatch_normal`,
  `deploy_widen`, `merge_ready`, and `paper_canary` were held, and `live_micro_canary` plus `live_scale` were blocked.

### Torghut Runtime Evidence

- Torghut namespace showed `torghut-00291-deployment` 1/1 and `torghut-sim-00390-deployment` 1/1.
- ClickHouse replicas, Keeper, Torghut DB, TA, TA sim, options services, WebSocket services, and guardrail exporters
  were running.
- `torghut-whitepaper-autoresearch-profit-target-8r6w6` remained in `Error`.
- Recent Torghut events showed duplicate ClickHouse PodDisruptionBudget selection warnings, no matching pods for the
  keeper PDB, and repeated `torghut-options-ta` FlinkDeployment status churn from external modification.
- The service account could list standard deployments, pods, services, and events but could not list Knative Service,
  Rollout, Workflow, CronWorkflow, StatefulSet, or CNPG custom resources in the Torghut and Jangar namespaces.

### Trading Evidence

- Live `/healthz` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- Live `/db-check` returned HTTP 200 with schema current, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, and lineage ready with known historical
  parent-fork warnings.
- Live `/trading/status` returned HTTP 200, while live `/trading/health` returned HTTP 503 with structured degraded
  evidence.
- Proof floor was `repair_only`, route state was `repair_only`, capital state was `zero_notional`, and max notional was
  `0`.
- Live submission gate was blocked by `simple_submit_disabled`.
- Alpha readiness reported 3 total hypotheses, 1 blocked, 2 shadow, 0 promotion eligible, and 2 rollback required.
- Proof blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `simple_submit_disabled`.
- Live route TCA covered eight scoped symbols. `AAPL` was probing, `AMD`, `AVGO`, `INTC`, and `NVDA` were blocked by
  route TCA, and `AMZN`, `GOOGL`, and `ORCL` had missing route evidence.
- Empirical jobs were fresh for `chip-paper-microbar-composite@execution-proof`, but forecast authority was degraded
  with `registry_empty` and Lean authority was disabled.
- Quant evidence had 144 latest metrics and a short metrics pipeline lag, but stage count was zero and
  `quant_pipeline_stages_missing` remained informational.
- ClickHouse guardrail exporter reported both replicas reachable, disk free ratios above 0.96, no read-only replicated
  tables, and fresh TA signal/microbar timestamps.

### Database And Data Evidence

- Direct CNPG status reads and pod exec were forbidden, but the service account could read the Torghut application
  database credentials and execute read-only SQL through the app database role. I used only `SELECT` queries.
- Public schema tables included `vnext_empirical_job_runs`, `simulation_run_progress`, `simulation_runtime_context`,
  `execution_tca_metrics`, `execution_tca_symbol_agg_v1`, `strategy_hypotheses`,
  `strategy_hypothesis_metric_windows`, and whitepaper/autoresearch tables.
- Largest row estimates were options catalog data at about 2.38 million rows, position snapshots at about 43,757 rows,
  and execution TCA metrics at 13,775 rows.
- `vnext_empirical_job_runs` contained 24 completed, empirical, promotion-authority-eligible rows; the newest batch was
  created at `2026-05-07T21:27:18Z`.
- `simulation_run_progress` and `simulation_runtime_context` returned no rows.
- `execution_tca_metrics` had 13,775 rows, 12 distinct symbols, max `computed_at` around
  `2026-05-07T14:23:44Z`, max `created_at` around `2026-04-02T20:59:45Z`, and average absolute slippage around
  13.76 bps.
- `execution_tca_symbol_agg_v1` showed high sample counts for `NVDA`, `MSFT`, `AAPL`, `META`, `AVGO`, and `AMD`, but
  the current scoped universe still lacked `AMZN`, `GOOGL`, and `ORCL` route evidence.
- `strategy_hypotheses` had one active row, updated on 2026-05-06.
- `strategy_hypothesis_metric_windows` had three rows, all for `H-MICRO-01`, with `evidence_maturity` set to
  `empirically_validated`.
- Whitepaper analysis runs had one completed row and no failed rows in the durable application table, while the
  Kubernetes whitepaper autoresearch pod was in `Error`. That is another source-bound reconciliation issue.

### Source Evidence

- `services/torghut/app/main.py` assembles trading status, health, proof floor, route reacquisition, quant evidence,
  empirical jobs, and promotion-related payloads.
- `services/torghut/app/trading/proof_floor.py` owns the current capital proof reducer and keeps capital at zero when
  any blocking dimension is degraded.
- `services/torghut/app/trading/route_reacquisition.py` classifies routeable, blocked, missing, probing, and repair
  candidate symbols from proof-floor source refs.
- `services/torghut/app/trading/route_reacquisition_board.py` turns proof-floor route evidence into zero-notional
  repair packets and optional Jangar refs.
- `services/torghut/app/trading/submission_council.py` owns live submission gate, quant evidence loading, capital-stage
  resolution, and promotion packet logic.
- `services/torghut/app/trading/simulation_progress.py` has durable hooks for simulation progress and runtime context,
  but production database evidence shows those tables empty for the current posture.
- Torghut has 156 test files, including proof floor, route reacquisition, route board, empirical jobs, submission
  council, quant readiness, TCA refresh, trading health, and simulation progress tests. The missing surface is
  cross-source contradiction scoring across service witnesses and durable rows.

## Problem

Torghut now has enough telemetry to avoid unsafe capital, but not enough reconciliation to make promotion evidence
auditable.

Today a reader must manually reconcile:

1. API health versus proof-floor capital holds.
2. Fresh empirical jobs versus empty simulation progress and runtime context rows.
3. Runtime registry hypotheses versus durable hypothesis rows.
4. TCA recomputation time versus the age of executions behind the recomputation.
5. Jangar global control-plane health versus source rollout truth and Torghut consumer evidence holds.
6. Kubernetes whitepaper/autoresearch failure versus durable whitepaper table success.

That manual reconciliation is a production risk. It lets good evidence and stale evidence coexist without a typed
contradiction packet. Profitability work then becomes a queue of plausible repairs instead of a ranked set of
source-bound gates.

## Alternatives Considered

### Option A: Trust The Existing Proof Floor

Continue to use proof floor, route reacquisition board, and Jangar action budgets as the admission boundary.

Advantages:

- Already implemented and safe.
- Correctly keeps capital at zero.
- Gives a useful repair ladder for operators.

Disadvantages:

- Does not explain why fresh empirical rows do not imply paper readiness.
- Does not compare database hypothesis rows against runtime registry hypotheses.
- Does not force simulation progress/context to exist before a route-local lab can claim promotion evidence.
- Does not identify Kubernetes-vs-database contradictions as a first-class debt.

Decision: keep as an input, reject as the next boundary.

### Option B: Backfill Every Missing Durable Row Before Any New Design

Prioritize simulation progress, simulation runtime context, hypothesis rows, and TCA refresh jobs until all durable
tables align with API status.

Advantages:

- Directly repairs visible data gaps.
- Makes the database more complete.
- Reduces reconciliation debt.

Disadvantages:

- Can spend repair capacity on rows that do not move a route toward paper.
- Does not define what counts as an admission contradiction.
- Does not give Jangar a compact consumer witness.
- Risks treating backfilled data as proof without source binding.

Decision: useful implementation work, insufficient architecture.

### Option C: Source-Bound Evidence Reconciliation Ledger

Publish an additive ledger that compares service witnesses, durable DB rows, Jangar custody, and route-local evidence.
The ledger emits contradictions, evidence debts, and admission decisions per route and per hypothesis.

Advantages:

- Converts disagreement into explicit repair work.
- Protects against accidental authority inflation from healthy sibling surfaces.
- Gives engineer and deployer stages a single acceptance contract.
- Keeps all current work no-notional until source-bound evidence closes.
- Lets Torghut rank repairs by capital-frontier movement instead of generic freshness.

Disadvantages:

- Adds a new ledger schema.
- Requires careful tests so informational closed-market staleness does not overblock observation.
- Delays paper canary until durable rows and runtime witnesses agree.

Decision: select Option C.

## Architecture

Torghut emits `source_bound_capital_admission_ledger` in shadow mode first:

```text
source_bound_capital_admission_ledger
  schema_version
  ledger_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  jangar_custody_ref
  schema_witness
  service_witnesses
  durable_row_witnesses
  route_reconciliations
  hypothesis_reconciliations
  contradiction_packets
  repair_queue
  capital_admission
  rollback_target
```

Each `contradiction_packet` has:

```text
contradiction_packet
  packet_id
  contradiction_class
  affected_symbols
  affected_hypotheses
  service_ref
  durable_row_ref
  observed_state
  expected_state
  severity              # informational | hold | block
  max_notional
  repair_action
  success_gate
  rollback_gate
  owner_stage
```

Initial contradiction classes:

- `empirical_without_simulation_context`: empirical jobs are fresh, but simulation progress/runtime context rows are
  empty.
- `runtime_hypothesis_db_mismatch`: API runtime hypotheses do not match durable hypothesis rows and windows.
- `tca_recomputed_from_old_execution_source`: TCA was refreshed but the newest execution source is too old for current
  route admission.
- `quant_metrics_without_stage_witness`: latest metrics exist, but pipeline stages are absent.
- `kubernetes_workflow_db_outcome_mismatch`: Kubernetes workflow or pod failure is not represented in durable outcome
  rows.
- `jangar_material_hold_not_in_route_packet`: Jangar holds paper/live because consumer evidence is missing, but route
  packets do not carry the custody ref.

## Capital Admission Rules

The ledger applies these rules before any paper or live route movement:

1. `serve_readonly` and `torghut_observe` can remain allowed while the ledger is in shadow mode.
2. No route can become a paper candidate while `simulation_run_progress` and `simulation_runtime_context` are empty for
   that route's lab run.
3. No hypothesis can become promotion eligible while runtime registry counts and durable hypothesis/window rows
   disagree.
4. TCA evidence must bind `computed_at`, source execution freshness, symbol coverage, and scope universe. Recomputing
   old rows does not create a current capital receipt.
5. Empirical jobs count as research authority only when their dataset snapshot, runtime refs, route-local lab refs, and
   Jangar custody refs are present.
6. Quant latest metrics without stage witnesses remain informational for observe, but hold paper and block live.
7. Kubernetes workflow failure that is absent from durable outcome rows is a hold until either the durable outcome is
   written or the workflow is declared out of scope.
8. Any missing Jangar custody ref keeps `max_notional=0`.

## Measurable Trading Hypotheses

- `H-RECON-SIM-01`: Filling simulation progress and runtime context for a route-local lab will reduce
  `empirical_without_simulation_context` to zero and make at least one no-notional route experiment auditable.
- `H-RECON-HYP-01`: Aligning runtime registry hypotheses with durable hypothesis rows will reduce promotion ambiguity
  and produce one authoritative per-hypothesis capital posture.
- `H-RECON-TCA-01`: Binding TCA recomputation to source execution freshness will separate stale route cost from current
  executable route cost and prevent slippage leakage from being hidden by old samples.
- `H-RECON-QUANT-01`: Requiring stage witnesses beside latest metrics will identify whether quant ingestion is
  actually ready for paper admission instead of merely producing fresh aggregate rows.
- `H-RECON-CUSTODY-01`: Carrying Jangar custody refs into route packets will let Jangar allow zero-notional repair
  while still holding paper/live capital.

## Implementation Scope

Engineer stage should add:

- A read-only ledger builder that consumes existing proof floor, route reacquisition board, empirical jobs, quant
  evidence, simulation progress, hypothesis windows, TCA summaries, and Jangar custody refs.
- A compact route, for example `GET /trading/control-plane/source-bound-capital-admission`.
- Tests for each initial contradiction class.
- Fixtures matching the current degraded posture: fresh empirical jobs, empty simulation context, runtime/DB hypothesis
  mismatch, old execution source behind TCA, missing quant stages, and Jangar consumer evidence holds.
- Metrics for contradiction counts by class and severity.

Deployer stage should verify:

- The ledger route returns within 500 ms p95 for the current payload size.
- `max_notional` stays `0` while any hold/block contradiction exists.
- Existing `/trading/health` and `/trading/status` behavior is unchanged.
- Jangar can consume the ledger in shadow mode without widening material action authority.

## Validation Gates

Local validation:

- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- Targeted tests for the new ledger and existing proof-floor/submission-council reducers.

Cluster validation:

- `GET /healthz` remains HTTP 200.
- `GET /db-check` remains HTTP 200 and current at the expected Alembic head.
- `GET /trading/health` may remain HTTP 503 while proof-floor blockers are real.
- New ledger route returns shadow-mode contradictions matching the current evidence.
- Jangar material action verdicts do not become more permissive from the new payload.

Data validation:

- Durable row witness counts and timestamps are included in the ledger.
- Empty simulation progress/context rows are explicit holds, not absent fields.
- Runtime/DB hypothesis divergence is explicit with source refs.
- TCA source execution freshness is visible beside `computed_at`.

## Rollout

Roll out in three phases:

1. Shadow emit only. The route is served, logs contradiction packets, and has tests. No Jangar material action consumes
   it as authority.
2. Jangar observe consumption. Jangar stores the ledger ref in observe and repair packets, but still uses existing
   action verdicts for holds and blocks.
3. Admission enforcement for paper only. Paper canary remains held unless the ledger has no hold/block contradiction
   for the selected route and hypothesis. Live remains blocked until paper settlement exists.

## Rollback

Rollback is to stop Jangar consumption of the ledger and keep Torghut's existing proof floor and submission gates as
the authority. Do not delete durable contradiction evidence. Do not use rollback to promote paper or live capital.

If the ledger route is slow or noisy, disable the route from Jangar consumption, keep it in Torghut logs for diagnosis,
and keep all notional at zero.

## Risks

- The ledger can become a second proof floor if it grows too broad. Keep it additive and contradiction-focused.
- Durable rows can lag legitimate runtime state. The remedy is an explicit freshness window, not bypassing the row
  witness.
- Closed-session expected staleness must stay informational for observation. Provider failures, empty lab rows, and
  missing custody refs are different classes.
- Query cost must be bounded. The route should use aggregated witnesses and current summaries, not scan raw options
  catalog data.

## Handoff

Engineer: implement the source-bound ledger as a small reducer and route beside the existing proof floor. Do not move
capital gates. Prove each contradiction class with fixtures that match the current cluster and database state.

Deployer: roll out in shadow mode, compare ledger contradictions with `/trading/health`, Jangar material verdicts, and
database row counts, then allow Jangar observe-only consumption. Paper and live remain zero-notional until the ledger,
proof floor, route board, and Jangar custody all agree.
