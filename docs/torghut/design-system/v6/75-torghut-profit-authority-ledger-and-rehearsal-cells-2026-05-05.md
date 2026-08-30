# 75. Torghut Profit Authority Ledger and Rehearsal Cells (2026-05-05)

Status: Approved for implementation (`plan`)

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


## Executive Summary

The decision is to introduce a Torghut **profit authority ledger** and **rehearsal cells**. Torghut can keep serving,
observing, and researching while evidence is stale, but no non-observe capital movement may proceed without a current
profit authority entry that cites Jangar rollout authority, fresh lane-local proof, bounded query evidence, and a
successful rehearsal cell for the target capital state.

The reason is the May 5 live state. Torghut is alive and measuring: `/healthz` returned `200`, `/trading/health`
returned `200`, schema is on Alembic head `0029_whitepaper_embedding_dimension_4096`, and `trade_decisions` has
`147,606` rows with the newest decision at `2026-05-04 17:25:57.901670+00`. But the profitable truth surface is narrower:
`/readyz` timed out at 12 seconds, logs showed repeated `IdleInTransactionSessionTimeout` on
`SELECT max(trade_decisions.created_at) FROM trade_decisions`, typed Jangar quant-health timed out at eight seconds,
market-context for `AAPL` and `NVDA` is degraded, empirical jobs are truthful but stale from March 21, and the strategy
hypothesis, promotion, autoresearch, and simulation progress tables are present with zero rows.

The tradeoff is deliberate friction. This will slow broad promotion. I am choosing that because profitable autonomy
needs precise authority over stale proof, simulation portability, and route-time query pressure, not a larger green
button.

## Decision

Torghut will make the profit authority ledger the only valid source for non-observe capital authority. The ledger does
not replace profit cells or Jangar evidence escrows; it binds them into one economic decision that can be replayed,
invalidated, and rolled back.

A capital state is valid only when:

- Torghut has a current `profit_authority_id`.
- The entry cites one Jangar `authority_ledger_id` with `torghut_promotion=allow`.
- The lane has a successful rehearsal cell for the target state: `shadow`, `canary`, `live`, or `scale`.
- Required proof cells are fresh within their lane policy.
- Query budgets are met from current projections, not broad historical scans.
- Rollback instructions are attached before the state is activated.

## Current Assessment

### Cluster, Rollout, and Events

Read-only cluster evidence:

- Torghut pod status:
  - `Running 17`
  - `Completed 2`
  - `ImagePullBackOff 1`
- The main service pod `torghut-00202-deployment-677db4fc7f-5cqgl` was `2/2 Running`.
- The simulation revision was split:
  - `torghut-sim-00280-deployment-77d5694d7b-6zvfs` was `2/2 Running`.
  - `torghut-sim-00280-deployment-6f844b4647-np4x6` was `0/2 ImagePullBackOff`.
- Recent Torghut events showed:
  - `no match for platform in manifest` for image digest
    `registry.ide-newton.ts.net/lab/torghut@sha256:d278a4d4267f011ba559dc51401acc6ac8f43d44a766b61f29a4d01859cce5cf`;
  - `configuration/torghut-sim` reporting `LatestReadyFailed`;
  - main Torghut revisions `00201` and `00202` recovering after startup and readiness timeouts;
  - `torghut-db-migrations` completing successfully.
- RBAC limitations:
  - the assessment account can list pods and services and get named secrets;
  - it cannot list Knative services, FlinkDeployments, PDBs, CNPG clusters, or Argo CD Applications;
  - it cannot exec into database pods.

Interpretation:

- Main Torghut is live.
- Simulation proof is not portable across the current node set.
- Deploy verification must work with partial RBAC and must not infer promotion authority from one healthy pod.

### Runtime Routes and Logs

Route evidence:

- `GET /healthz`: `{"status":"ok","service":"torghut"}`
- `GET /readyz`: timed out after 12 seconds.
- `GET /db-check`: returned `ok=true`, schema current, single expected head, and lineage warnings for known parent forks.
- `GET /trading/health`: returned `status=ok`, but its own payload showed:
  - `alpha_readiness.dependency_quorum.decision="block"`;
  - `alpha_readiness.dependency_quorum.reasons=["empirical_jobs_degraded"]`;
  - `promotion_eligible_total=0`;
  - `rollback_required_total=3`;
  - `live_submission_gate.allowed=true`;
  - `quant_evidence.reason="quant_health_not_configured"` and `required=false`.
- `GET /trading/autonomy` and `GET /trading/empirical-jobs` showed empirical jobs are `ready=false`,
  `status="degraded"`, and stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- Torghut logs showed repeated idle transaction timeouts on `SELECT max(trade_decisions.created_at) FROM trade_decisions`
  during the same assessment window.

Interpretation:

- Serving, readiness, live submission, alpha readiness, empirical proof, and quant proof are not yet one coherent
  capital authority surface.
- The system is honest enough to expose the contradictions; the architecture should preserve that honesty and make it
  enforceable.

### Source Architecture and Test Gaps

High-risk source paths:

- `services/torghut/app/main.py`
  - `3,959` lines.
  - `_evaluate_trading_health_payload()` assembles scheduler state, database dependency checks, hypothesis payloads,
    market-context status, empirical job status, quant evidence, and live submission gate state.
  - `/readyz` calls that payload with database contract checks and stale-cache allowance.
  - `/trading/health` calls the same evaluator without database contract checks.
  - `/db-check` validates schema separately.
- `services/torghut/app/trading/submission_council.py`
  - `1,196` lines.
  - `load_quant_evidence_status()` treats missing typed quant-health as `ok` when the requirement flag is false.
  - `build_live_submission_gate_payload()` can compose strong certificate logic, but live route outputs still showed
    `allowed=true` while alpha readiness and empirical truth were degraded.
- `services/torghut/app/whitepapers/workflow.py`
  - `4,473` lines.
  - Whitepaper ingestion is active, but runtime logs showed many ignored Kafka messages and no accepted work during the
    sampled window.
- `services/torghut/scripts/start_historical_simulation.py`
  - `8,197` lines.
  - Simulation orchestration is powerful but too broad to be the only proof path for day-to-day promotion.
- Tests:
  - `146` Python test files exist under `services/torghut/tests`.
  - `7` files are property or stateful tests.
  - Missing coverage is cross-surface: no single regression proves `/readyz`, `/trading/health`, `/trading/status`,
    Jangar typed quant-health, and empirical job freshness all project the same profit authority entry.

### Database and Data Quality

Torghut Postgres evidence:

- PostgreSQL version: `17.0`.
- Schema: `public`.
- Alembic head: `0029_whitepaper_embedding_dimension_4096`.
- Fresh or useful tables:
  - `trade_decisions`: `147,606` exact rows, `1182 MB`, latest `created_at` at
    `2026-05-04 17:25:57.901670+00`.
  - `position_snapshots`: `39,695` exact rows, latest `created_at` at `2026-05-04 20:59:06.489364+00`.
  - `trade_cursor`: one row, latest `updated_at` at `2026-05-04 20:59:12.575466+00`.
  - `torghut_options_contract_catalog`: estimated `1,710,579` rows, latest `expiration_date` `2028-02-18`.
- Stale or empty proof surfaces:
  - `executions`: latest `updated_at` `2026-04-03 05:32:36.212112+00`.
  - `llm_decision_reviews`: latest `created_at` `2026-03-19 20:13:45.326646+00`.
  - `vnext_empirical_job_runs`: `16` exact rows, latest `updated_at` `2026-03-21 09:03:22.150009+00`.
  - `torghut_options_watermarks`: `1,213` rows, latest `last_event_ts` `2026-03-11 01:08:11.973321+00`.
  - `torghut_options_subscription_state`: `1,948` rows, latest `last_ranked_ts`
    `2026-03-11 01:06:33.304365+00`.
  - `strategy_hypotheses`, `strategy_hypothesis_metric_windows`, `strategy_promotion_decisions`,
    `autoresearch_epochs`, `autoresearch_candidate_specs`, `autoresearch_portfolio_candidates`, and
    `simulation_run_progress`: all existed and had zero rows.
- ClickHouse:
  - direct unauthenticated HTTP probes reached ClickHouse but failed with `REQUIRED_PASSWORD`.
  - Jangar market-context health reported ClickHouse ingestion configured and successful, which is useful but not a
    substitute for Torghut promotion proof.

Interpretation:

- Torghut has live data and production schema.
- The profit authority path is not populated enough for non-observe promotion.
- Options and empirical surfaces need lane-local vetoes, not global optimism.

## Problem Statement

Torghut's current architecture is close to a strong autonomous trading system, but the authority boundary is still too
diffuse. A route can report live submission ready while the evidence required for profitable promotion is stale,
unconfigured, or missing. A database check can be correct while a readiness path times out. A simulation revision can be
half-portable. A strategy family can have a large options catalog but stale options watermarks.

Profitability will not come from loosening these gates. It will come from making the gates precise enough that healthy
cells keep learning while stale cells cannot spend capital.

## Alternatives Considered

### Option A: Increase Timeouts, Pools, and Cache TTLs

Summary:

- Increase route budgets and database pool capacity.
- Keep the current route composition.
- Treat stale proof as operational debt rather than authority structure.

Pros:

- Fastest local relief.
- Low implementation complexity.
- Less schema work.

Cons:

- Scales the expensive pattern.
- Does not fix contradictory capital authority.
- Encourages teams to bypass proof when proof gets slow.

Decision: rejected as the primary architecture. It may be useful as tactical maintenance, but it does not create
profitable autonomy.

### Option B: Let Jangar Be the Final Capital Arbiter

Summary:

- Jangar evidence escrow becomes final authority for Torghut capital movement.
- Torghut consumes platform decisions.

Pros:

- One platform gate.
- Simple deployer story.
- Strong centralized rollback.

Cons:

- Jangar does not own PnL, slippage, fills, or trading economics.
- Platform health would be overfit to one trading system.
- Torghut would lose lane-local falsification and experiment accounting.

Decision: rejected. Jangar should veto platform evidence; Torghut must own economic authority.

### Option C: Profit Authority Ledger With Rehearsal Cells (Selected)

Summary:

- Torghut writes one durable authority entry per capital decision.
- The entry cites Jangar authority, profit cells, proof cells, data freshness, query budgets, and rollback instructions.
- Rehearsal cells prove a lane can safely enter the requested capital state before it does so.

Pros:

- Makes non-observe capital replayable and falsifiable.
- Preserves serving availability while blocking promotion.
- Lets stale options, empirical, market-context, or simulation proof block only dependent lanes.
- Creates measurable profitability hypotheses with explicit guardrails.
- Gives engineer and deployer stages concrete acceptance gates.

Cons:

- Adds schema and route work.
- Requires migration of status consumers to ledger ids.
- Broad portfolio promotion will initially be slower.

Decision: selected.

## Target Architecture

### Profit Authority Ledger

Add a Torghut-owned ledger with these logical fields:

- `profit_authority_id`
- `jangar_authority_ledger_id`
- `profit_cell_id`
- `hypothesis_id`
- `strategy_family`
- `strategy_variant`
- `account`
- `market_segment`
- `capital_state`: `observe`, `shadow`, `canary`, `live`, `scale`, `rollback`
- `status`: `allow`, `hold`, `veto`, `superseded`
- `proof_cell_refs`
- `rehearsal_cell_ref`
- `dataset_snapshot_ref`
- `market_context_ref`
- `quant_health_ref`
- `empirical_job_refs`
- `query_budget_ref`
- `post_cost_metrics`
- `guardrail_results`
- `issued_at`
- `expires_at`
- `rollback_plan_ref`
- `superseded_by`

The ledger is append-only. A rollback writes a new authority entry and supersedes the old one.

### Rehearsal Cells

Initial rehearsal cells:

- `shadow-rehearsal`
  - requires schema head current, strategy manifest loaded, and no missing required proof cells for observe/shadow.
- `canary-rehearsal`
  - requires fresh market-context for required domains, fresh quant latest projection, current empirical proof, and
    positive post-cost replay on the lane's frozen holdout.
- `live-rehearsal`
  - requires canary pass, live image portability, bounded query proof, TCA/fill-quality proof, and Jangar
    `torghut_promotion=allow`.
- `scale-rehearsal`
  - requires live pass, drawdown under policy, turnover under policy, concentration under policy, and no stale
    dependent data segment.
- `rollback-rehearsal`
  - proves a lane can return to observe/shadow without deleting evidence.

### Trading Hypotheses

The first authority entries should target concrete hypotheses:

- `H-CONT-01`: high-volume intraday continuation.
  - Hypothesis: continuation can contribute positive post-cost PnL when technicals/regime freshness is current and
    signal lag is under policy.
  - Guardrails: max drawdown, slippage budget, turnover cap, no promotion during market-context stale state.
- `H-BREAK-01`: opening-drive breakout.
  - Hypothesis: early liquidity expansion can produce positive expectancy on high-relative-volume names when empirical
    proof is current.
  - Guardrails: first-hour freshness, gap-risk cap, concentration cap.
- `H-REV-01`: event-driven reversion.
  - Hypothesis: reversion can work only when news/fundamentals freshness is current.
  - Guardrails: no promotion while news or fundamentals are stale.
- `H-OPT-BOOT-01`: options bootstrap lane.
  - Hypothesis: options-derived features can improve trade selection only after watermarks and ranked subscriptions are
    current.
  - Guardrails: stale options watermarks force observe-only state.

### Projection Rules

- `/healthz` remains serving liveness.
- `/readyz` must project readiness from latest proof authority and must not run broad freshness scans.
- `/db-check` remains schema lineage and account-scope proof, not profitability proof.
- `/trading/status`, `/trading/health`, `/trading/autonomy`, and scheduler decisions must expose the same
  `profit_authority_id` for the active lane.
- A missing typed quant-health URL is a promotion veto for non-observe capital, not an informational footnote.
- Empirical jobs marked stale block only hypotheses that require that empirical job family.
- Stale options watermarks block options-dependent lanes, not equities-only observation.

## Implementation Scope

Engineer stage:

1. Add Alembic migration and SQLAlchemy models for `profit_authority_ledger` and `profit_rehearsal_cells`.
2. Build a proof compiler that reads current projections with statement timeouts and writes authority entries.
3. Update `submission_council.py` so non-observe capital requires a current `profit_authority_id`.
4. Update `/trading/status`, `/trading/health`, `/trading/autonomy`, and scheduler payloads to expose the same
   authority id and reason codes.
5. Make typed Jangar quant-health required for non-observe capital once ledger shadow parity is enabled.
6. Add regression tests for stale empirical jobs, stale market-context, missing quant-health, stale options watermarks,
   and simulation image non-portability.
7. Add one property or stateful test proving stale proof cannot promote while unrelated lanes remain observable.

Deployer stage:

1. Run migration and compiler in shadow mode.
2. Compare current route outputs with ledger outputs.
3. Enable `shadow` enforcement first.
4. Enable `canary` only when rehearsal cells are green.
5. Enable `live` only after Jangar authority and Torghut profit authority agree for the lane.

## Validation Gates

Required local checks:

- `cd services/torghut && uv sync --frozen --extra dev`
- `cd services/torghut && uv run --frozen python scripts/check_migration_graph.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
- targeted pytest for submission council, readiness, empirical jobs, options lane, and authority ledger tests
- property/stateful test for stale-proof non-promotion

Required cluster gates:

- `/readyz` responds within 2 seconds from inside the cluster.
- `/trading/health` and `/trading/status` cite the same `profit_authority_id`.
- Jangar typed quant-health responds within 2 seconds from current-state projections.
- `trade_decisions` freshness is read from a projection or indexed current table, not a route-time broad aggregate.
- all non-observe lanes have current empirical, market-context, quant, simulation, and options proof where required.
- simulation image portability is green across the node classes used by Torghut and `torghut-sim`.

## Rollout

1. Land schema and compiler behind `TRADING_PROFIT_AUTHORITY_LEDGER_ENABLED=false`.
2. Emit shadow authority entries for seven trading sessions or until every active lane has at least five successful
   rehearsals, whichever is later.
3. Enable route projection fields while keeping legacy decisions.
4. Enforce observe/shadow decisions.
5. Enforce canary decisions.
6. Enforce live decisions only after Jangar `torghut_promotion=allow` and Torghut profit authority agree.

## Rollback

Rollback is a first-class ledger action:

- write a new `capital_state=rollback` authority entry;
- freeze affected lanes at observe or shadow;
- preserve stale and failed proof rows;
- supersede the previous authority id;
- disable enforcement flags if the compiler is the failure source;
- never delete evidence to unblock a lane.

## Risks and Tradeoffs

- Promotion slows down while evidence is rebuilt. Accepted.
- More state exists. Mitigated by append-only design and explicit supersession.
- Engineers must migrate status consumers. Mitigated by shadow parity and route-level compatibility fields.
- Initial ledger entries may be mostly `hold`. That is truthful and useful because it names the missing proof.

## Handoff Gates

Engineer acceptance:

- A missing typed quant-health URL or timeout cannot allow non-observe capital.
- Stale empirical jobs from March 21 block only lanes that require those jobs.
- Stale options watermarks from March 11 block `H-OPT-BOOT-01` and do not poison equities-only observation.
- `/trading/status`, `/trading/health`, scheduler state, and `/trading/autonomy` expose the same authority id.

Deployer acceptance:

- Shadow ledger projection runs without route-time broad scans.
- Rehearsal cells are visible before enforcement.
- Rollback writes a superseding ledger entry and demotes the lane without deleting evidence.
