# 133. Torghut Capital Readiness Cache And Profit Carry Governor (2026-05-06)

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

I am selecting a **capital readiness cache and profit carry governor** for Torghut.

Torghut is operational but not capital-ready. At `2026-05-06T20:26Z`, the Torghut namespace had `27` running pods,
`5` completed pods, and `1` pending pod. The active live and sim Knative revisions were running. `/healthz` returned
HTTP `200`. `/db-check` returned HTTP `200` with schema current at `0029_whitepaper_embedding_dimension_4096`,
`account_scope_ready=true`, no missing heads, and no unexpected heads. Jangar reported Torghut empirical jobs healthy
with fresh eligible jobs.

At the same time, `/readyz` returned HTTP `503`. The local dependencies in that readiness payload were mostly healthy:
Postgres, ClickHouse, Alpaca, database schema, universe, and empirical jobs were `ok=true`. The degraded component was
alpha-readiness dependency quorum: Jangar status fetch timed out and surfaced as `jangar_status_fetch_failed`. Live
submission was already blocked by `simple_submit_disabled`, capital stage was `shadow`, and runtime profitability over
the 72-hour window showed `25` decisions, `0` executions, and `0` TCA samples. Doc 29 completion had `6` blocked gates,
`2` stale gates, and only `empirical_jobs_persisted` satisfied.

The selected design gives Torghut a local readiness cache backed by Jangar consumer evidence leases and a profit carry
governor. Operational readiness may use a bounded cached lease when Torghut's local dependencies are healthy. Paper and
live capital may not. Profit carry requires current Jangar lease, current Torghut proof, current schema, and measured
post-cost evidence.

The tradeoff is that `/readyz` becomes less punitive than capital admission. That is intentional. A service should keep
serving dashboards, health probes, and zero-notional research while capital remains held. Readiness should not become a
hidden trading approval.

## Runtime Objective And Success Metrics

This contract increases Torghut profitability by keeping evidence-producing work alive while preventing stale or
missing cross-plane proof from funding capital.

Success means:

- `/readyz` separates local service health from capital readiness and Jangar lease freshness.
- A Jangar fetch timeout can use a cached operational lease only inside a short grace window.
- Paper, live micro, and live scale capital require current Jangar leases with no operational grace.
- Profit carry is calculated from decision, execution, TCA, drawdown, reject-rate, and gate rollback evidence.
- Zero-notional forecast and empirical proof work can continue while live submission is disabled.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, ClickHouse tables, or runtime objects.

### Cluster And Runtime Evidence

- Torghut namespace phase count was `Pending=1`, `Running=27`, and `Completed=5`.
- `torghut-00243-deployment-dd8ff7496-h9r9n` was `2/2 Running`.
- `torghut-sim-00344-deployment-68787fcc66-rmdp5` was `2/2 Running`.
- `torghut-db-1`, both ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog/enricher, websockets,
  guardrail exporters, Symphony, and Alloy were running.
- Recent Torghut events showed startup/readiness warm-up on live and sim revisions, then `RevisionReady` for
  `torghut-00243` and `torghut-sim-00344`.
- Recent Torghut events also showed repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods and
  `NoPods` for `poddisruptionbudget/torghut-keeper`.
- `/healthz` returned HTTP `200`.
- `/readyz` returned HTTP `503` with `status=degraded`.

### Database And Data Evidence

- `/db-check` returned HTTP `200`.
- Schema was current at `0029_whitepaper_embedding_dimension_4096`.
- `schema_head_count_expected=1`, `schema_head_count_current=1`, and `schema_head_delta_count=0`.
- Known parent-fork warnings remain for
  `0010_execution_provenance_and_governance_trace -> [0011_autonomy_lifecycle_and_promotion_audit, 0011_execution_tca_simulator_divergence]`
  and
  `0015_whitepaper_workflow_tables -> [0016_llm_dspy_workflow_artifacts, 0016_whitepaper_engineering_triggers_and_rollout]`.
- `account_scope_ready=true`, with the warning that account-scope checks are bypassed while
  `trading_multi_account_enabled=false`.
- `/trading/empirical-jobs` reported `ready=true`, `status=healthy`, `authority=empirical`, stale horizon `86400`
  seconds, candidate `chip-paper-microbar-composite@execution-proof`, and dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- `/trading/autonomy` reported forecast service `status=degraded`, `authority=blocked`, `message=registry_empty`,
  `enabled=false`, `bridge_status.source=unavailable`, and empirical jobs healthy.
- `/trading/profitability/runtime` reported a 72-hour window with `decision_count=25`, `execution_count=0`,
  `tca_sample_count=0`, and live submission blocked by `simple_submit_disabled`.
- Doc 29 completion reported `blocked=6`, `stale=2`, `satisfied=1`; the satisfied gate was
  `empirical_jobs_persisted`.

### Source Evidence

- `services/torghut/app/trading/hypotheses.py` contains a process-local Jangar quorum cache, but cache entries are
  keyed by status URL and return only `JangarDependencyQuorumStatus`.
- `load_jangar_dependency_quorum()` performs a synchronous HTTP fetch and returns `decision=unknown`,
  `reason=jangar_status_fetch_failed` on any exception.
- `services/torghut/app/main.py` calls the dependency quorum loader from `/readyz`, `/trading/status`,
  `/trading/metrics`, `/trading/profitability/runtime`, and live submission gate construction.
- `services/torghut/app/trading/submission_council.py` already treats dependency quorum and empirical jobs as capital
  gate inputs. It is the right place to consume strict current leases for paper/live.
- `services/torghut/app/trading/completion.py` already evaluates Doc 29 gates and can represent stale, blocked,
  regressed, and satisfied states.
- `services/torghut/app/trading/autonomy/lane.py` is `7377` lines and owns autonomous lane artifacts, profitability
  evidence, and hypothesis governance persistence. The design should add a small cache/governor boundary, not more
  broad readiness logic inside this file.

## Problem

Torghut readiness is currently mixing service health, cross-plane dependency fetch health, and capital readiness.

That creates two bad outcomes:

1. A Jangar status timeout can make Torghut look operationally unhealthy even when it can serve read-only routes,
   health probes, and zero-notional evidence jobs.
2. Operators can be tempted to relax the Jangar dependency entirely, which would also weaken paper/live capital gates.

We need a stricter split:

- service readiness answers whether Torghut can serve and continue evidence production;
- profit carry answers whether the system has enough current proof to advance a hypothesis;
- capital readiness answers whether paper/live action is allowed.

## Alternatives Considered

### Option A: Fail `/readyz` On Every Jangar Timeout

Keep the current behavior and make Jangar dependency quorum mandatory for service readiness.

Pros:

- Simple and safe for capital.
- Makes dependency failures obvious to Kubernetes and operators.
- Avoids stale cache behavior.

Cons:

- Over-blocks operational service health.
- Prevents zero-notional learning when the local data plane is otherwise healthy.
- Makes Jangar network jitter look like a Torghut service outage.
- Does not produce a better capital admission signal.

Decision: reject.

### Option B: Make Jangar Dependency Informational Only

Keep readiness green when local dependencies are healthy and move all Jangar checks to dashboards or logs.

Pros:

- Removes readiness flakes.
- Minimal implementation effort.
- Keeps Torghut local health simple.

Cons:

- Weakens cross-plane safety.
- Lets paper/live gates drift from Jangar material action verdicts.
- Makes it harder to prove why capital stayed held or moved forward.
- Hides controller witness and dispatch debt from Torghut capital decisions.

Decision: reject.

### Option C: Lease-Backed Readiness Cache With Profit Carry Governor

Consume compact Jangar evidence leases. Use operational grace only for service readiness. Require strict current leases
for paper/live capital and calculate profit carry before promotion.

Pros:

- Keeps service readiness useful without weakening capital gates.
- Gives Torghut a stable, testable contract for Jangar dependency state.
- Supports zero-notional proof work while live submission remains disabled.
- Makes profitability claims depend on current data, executions, TCA, and rollback evidence.
- Aligns with Jangar's material action receipt and consumer evidence lease direction.

Cons:

- Adds a new cache and route payload.
- Requires careful test coverage so grace cannot unlock capital.
- Requires deployer visibility into lease age and source refs.

Decision: select Option C.

## Architecture

Torghut stores and serves a local capital readiness cache:

```text
capital_readiness_cache
  cache_id
  generated_at
  observed_at
  expires_at
  grace_until
  source_jangar_lease_set_id
  source_status_ref
  local_database_ref
  clickhouse_ref
  broker_ref
  empirical_jobs_ref
  forecast_registry_ref
  doc29_ref
  runtime_profitability_ref
  readiness_decision
  capital_decision
  blocked_reasons
  stale_reasons
```

The profit carry governor produces a bounded capital product:

```text
profit_carry_product
  product_id
  generated_at
  hypothesis_id
  account_label
  symbol_set
  evidence_window
  decision_count
  execution_count
  tca_sample_count
  realized_pnl_ref
  forecast_ref
  empirical_job_refs
  doc29_gate_refs
  jangar_action_lease_refs
  carry_stage       # observe, repair, paper_candidate, paper, live_micro, live_scale
  max_notional
  rollback_target
  decision          # allow, allow_zero_notional, repair_only, hold, block
```

Readiness behavior:

- `operational_ready`: local Postgres, ClickHouse, service, and broker probes are healthy. A Jangar lease may be
  current or inside operational grace.
- `evidence_ready`: empirical jobs and Doc 29 evidence are current enough for zero-notional proof work.
- `capital_ready`: current Jangar lease, current Torghut evidence, current schema, and satisfied capital gates.

Capital behavior:

- `observe`: allowed with zero notional when operational readiness is healthy and local evidence can still be
  produced.
- `repair`: allowed to refresh Jangar or Torghut evidence products.
- `paper_candidate`: held until Doc 29 paper gate, forecast registry, and Jangar paper lease are current.
- `paper`: bounded paper only after current proof and rollback targets.
- `live_micro`: blocked until paper settlement, TCA sample, reject-rate, drawdown, and Jangar live lease allow.
- `live_scale`: blocked until live micro settlement and explicit deployer approval.

## Measurable Trading Hypotheses

H-CRC-01, operational grace increases proof throughput without increasing capital risk:

- Baseline: fail `/readyz` on every Jangar fetch timeout.
- Candidate: operational readiness uses a cached `serve_readonly` lease inside a short grace window.
- Primary metric: count of zero-notional evidence jobs completed during Jangar fetch interruptions.
- Safety metric: paper/live actions allowed during grace must remain `0`.
- Promotion gate: at least one interrupted window keeps evidence production alive, and no paper/live action enters
  `allow` without a current lease.

H-CRC-02, profit carry should require execution evidence before live micro:

- Baseline: use decision and empirical job freshness only.
- Candidate: require executions, TCA samples, rollback readiness, and Doc 29 gates before live micro.
- Primary metric: live micro admission count with `execution_count=0` should be `0`.
- Promotion gate: paper canary may be considered only after a non-empty decision/evidence product; live micro requires
  non-zero execution and TCA samples.

H-CRC-03, stale Jangar lease should degrade capital before service:

- Baseline: stale Jangar dependency makes the service degraded.
- Candidate: stale lease within grace keeps operational readiness, blocks capital, and emits repair action.
- Primary metric: readiness and capital decisions diverge correctly in route payloads.
- Promotion gate: tests prove `operational_ready=true`, `capital_ready=false`, and required repair refs are present.

## Guardrails

Hard guardrails:

- No paper/live capital from an expired, missing, unknown, or grace-only Jangar lease.
- No live capital while `simple_submit_disabled` is present.
- No live capital with `execution_count=0` or `tca_sample_count=0`.
- No paper capital while Doc 29 paper gate is blocked.
- No forecast capital while forecast registry is `empty`, `stale`, or `revoked`.
- No schema bypass when `/db-check` is not current.

Soft guardrails:

- Keep zero-notional proof work available when operational readiness is healthy.
- Prefer repair jobs that renew Jangar leases before forecast or paper work.
- Degrade to observe when empirical jobs are fresh but completion gates are stale.
- Preserve parent-fork migration warnings in readiness payloads until the lineage graph is normalized.

## Implementation Scope

Engineer stage:

- Add a `CapitalReadinessCache` schema and pure decision reducer.
- Consume Jangar consumer evidence leases rather than the full status payload for readiness decisions.
- Keep strict full-status or lease-current checks available for capital admission.
- Add route payload fields for `operational_ready`, `evidence_ready`, `capital_ready`, lease age, grace state, and
  blocked reasons.
- Add unit tests for Jangar fetch timeout with cached lease, expired lease, current lease, `simple_submit_disabled`,
  Doc 29 blocked gates, and `execution_count=0`.

Deployer stage:

- Enable cache emission in observe mode only.
- Verify `/readyz` and `/trading/profitability/runtime` show separate operational and capital decisions.
- Keep `TRADING_AUTONOMY_ENABLED=false` for live capital until paper settlement and TCA evidence exist.
- Publish lease id, profit carry product id, and rollback target before any paper route change.

## Validation Gates

Required local checks for this document PR:

- `bunx oxfmt --check docs/agents/designs/129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`
- `bunx oxfmt --check docs/torghut/design-system/v6/133-torghut-capital-readiness-cache-and-profit-carry-governor-2026-05-06.md`
- `bunx oxfmt --check docs/torghut/design-system/v6/index.md`

Required implementation tests:

- Unit test: Jangar fetch timeout plus cached `serve_readonly` lease keeps operational readiness and blocks capital.
- Unit test: expired Jangar lease blocks capital and emits repair reason.
- Unit test: `simple_submit_disabled` blocks live capital even with healthy database and empirical jobs.
- Unit test: Doc 29 paper gate blocked prevents paper carry.
- Unit test: `execution_count=0` and `tca_sample_count=0` block live micro.

Required runtime checks before enforcement:

- `curl http://torghut.torghut.svc.cluster.local/readyz`
- `curl http://torghut.torghut.svc.cluster.local/db-check`
- `curl http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
- `curl http://torghut.torghut.svc.cluster.local/trading/completion/doc29`
- `curl http://torghut.torghut.svc.cluster.local/trading/profitability/runtime`
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`

Acceptance gates:

- `/readyz` exposes local dependency state, Jangar lease state, and capital state separately.
- Operational readiness may be green during Jangar lease grace only when local dependencies are healthy.
- Paper/live capital remains blocked during grace.
- Profit carry includes decision, execution, TCA, Doc 29, Jangar lease, and rollback refs.
- Current runtime state remains observe/repair only: no live submission while `simple_submit_disabled` and
  `execution_count=0` are present.

## Rollout

1. Shadow: compute readiness cache and profit carry product without changing `/readyz` status code.
2. Observe: expose cache state in `/readyz` and `/trading/profitability/runtime`.
3. Operational grace: let `/readyz` use cached `serve_readonly` leases when local dependencies are healthy.
4. Repair enforcement: route Jangar lease repair before forecast or capital work when lease freshness is missing.
5. Paper enforcement: require current Jangar paper lease and Doc 29 paper satisfaction.
6. Live enforcement: require paper settlement, TCA, reject-rate, drawdown, rollback, and Jangar live lease.

## Rollback

- Disable operational grace and return `/readyz` to direct Jangar dependency quorum behavior.
- Keep capital blocked during rollback unless current strict leases and Torghut gates allow.
- Retain cached lease and profit carry payloads for audit even when enforcement is disabled.
- If cache decisions diverge from Jangar leases, prefer strict Jangar material action receipts and mark Torghut capital
  state `unknown`.

## Risks

- Operators may confuse operational readiness with trading approval; route payload labels and runbook wording must be
  explicit.
- A stale cached lease can mask a real Jangar outage if local dependency checks are too permissive.
- Profit carry products can become expensive if they attempt wide scans instead of bounded windows.
- Parent-fork migration warnings remain a schema-quality issue even while applied heads are current.

## Handoff Contract

Engineer:

- Keep the cache reducer pure and easy to test.
- Do not let grace semantics reach submission council capital approval.
- Preserve `jangar_status_fetch_failed` as a repair reason, not as an automatic capital veto for every route.
- Add tests around the current evidence: `/readyz` 503 from Jangar fetch timeout, `simple_submit_disabled`,
  `execution_count=0`, and Doc 29 blocked gates.

Deployer:

- Do not enable paper/live capital until current Jangar leases and Torghut profit carry both allow.
- Treat a green `/healthz` or operational-ready `/readyz` as service health only.
- Roll back by disabling grace first, then cache emission if payloads diverge.
