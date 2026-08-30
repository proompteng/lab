# 129. Torghut Proof-Carry Watermarks And Zero-Decision Capital Drain (2026-05-06)

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

Torghut will use **proof-carry watermarks and a zero-decision capital drain** before any lane can move from observe to
paper or live capital.

The current runtime is useful for observation, but not capital-ready. Live `/readyz` returned HTTP `503` because
`simple_submit_disabled` keeps live submission blocked at `capital_stage=shadow`. Scheduler, Postgres, ClickHouse,
Alpaca, database schema, empirical jobs, and the Jangar universe were healthy. That does not prove a trading lane is
profitable enough to promote. Jangar's Torghut quant health route was fresh when account scope was omitted, but
`account=paper&window=1d` returned `degraded` with `latestMetricsCount=0` and `emptyLatestStoreAlarm=true`. Open
alerts included critical `metrics_pipeline_lag_seconds` windows from `5m` to `20d`. Torghut market context for `NVDA`
was degraded because fundamentals and news were stale. Prometheus showed `torghut_trading_decisions_total=0` and
`torghut_trading_orders_submitted_total=0`.

That evidence means Torghut should not treat a reachable service, healthy database, or healthy unscoped quant runtime
as proof of lane profitability. A lane must carry proof for the account/window it wants to use. If it has no recent
decisions, no submitted orders, an empty account-scoped latest store, open critical proof alerts, stale lane-required
market context, or a disabled live submission gate, its capital authority drains to observe with max notional `0`.

The tradeoff is that some alpha candidates will wait longer in shadow. I accept that. The target failure mode is
capital reentry based on infrastructure health while the lane itself has no fresh proof and no recent decision tape.

## Runtime Objective And Success Metrics

This contract increases profitability by making stale or absent lane evidence reduce capital authority before a broker
order can be considered.

Success means:

- Every capital intent cites Jangar `consumer_evidence_escrow` and `control_plane_run_settlement_watermark` refs.
- Account-scoped empty quant stores drain paper and live authority to observe.
- Zero recent trading decisions or zero proof-carrying simulated fills cannot support positive edge credit.
- Open critical quant alerts reduce post-settlement expected edge to zero until resolved or explicitly waived.
- Lane-required stale market-context domains block paper/live but keep observe and repair available.
- Live submission disabled remains a hard live-capital block, even when database and Alpaca are healthy.
- Profitability reports show the pre-drain edge, drain reasons, and post-drain edge.

## Evidence Snapshot

All evidence was collected read-only. No trading flags, broker records, Kubernetes resources, database rows, or
GitOps resources were changed.

### Runtime And Cluster Evidence

- Torghut live pods, sim pods, ClickHouse replicas, Keeper, Postgres, live TA, sim TA, options TA, options catalog,
  options enricher, websocket pods, guardrail exporters, Alloy, and Symphony were running.
- Active Knative-style revisions included live `torghut-00240-deployment` and sim `torghut-sim-00336-deployment`.
- Older live and sim revisions were scaled to `0/0`, which is expected revision retention but still requires action
  receipts to name the active proof source.
- Listing statefulsets, CNPG resources, and Secrets was forbidden to the agent service account; validation therefore
  depends on application routes and Jangar observation contracts.
- Agents events showed recent controller readiness timeouts even while current deployments were available.

### Data And Schema Evidence

- Live `/readyz` returned HTTP `503` with scheduler OK, Postgres OK, ClickHouse OK, Alpaca OK, database schema current,
  and universe fresh.
- Live submission gate was not allowed: `simple_submit_disabled`, `capital_stage=shadow`,
  `promotion_eligible_total=0`.
- Torghut schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096` with signature
  `3c1a76a911bc0a1af7d88d931bd53837ef1d5a4b0eac48c9b690317f3e76756d`.
- Schema lineage was ready with known parent-fork warnings for `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Jangar quant health without account scope had `latestMetricsCount=540`, latest update around
  `2026-05-06T17:08:25Z`, and about `13` seconds of lag.
- Jangar quant health for `account=paper&window=1d` returned `status=degraded`, `latestMetricsCount=0`, and
  `emptyLatestStoreAlarm=true`.
- Open quant alerts returned `count=50`; the first sampled alerts were critical pipeline-lag alerts for `5m`, `15m`,
  `1h`, `1d`, `5d`, and `20d` windows.
- Market context for `NVDA` was degraded with `fundamentals_stale` and `news_stale`; fundamentals freshness was
  `4764365` seconds against `86400`, and news freshness was `5273` seconds against `600`.
- Torghut metrics showed zero trading decisions and zero submitted orders.

### Source Evidence

- `services/torghut/app/main.py` owns `/readyz`, dependency checks, database schema projection, live submission gate
  assembly, empirical job status, and quant evidence projection.
- `services/torghut/app/trading/submission_council.py` owns the final trading submission council and is the right
  place to consume Jangar escrow refs before allowing paper or live submission.
- `services/torghut/app/trading/empirical_jobs.py` supplies job freshness for proof gates.
- `services/torghut/app/trading/profitability_archive.py` owns proof archive material that should feed the
  proof-carry watermark.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`,
  `-alerts.test.ts`, `-snapshot.test.ts`, and `-series.test.ts` already cover the Jangar quant control-plane routes.
- The missing test class is a capital-drain fixture that combines empty account-scoped metrics, zero decision counts,
  stale market context, and live submission disabled into one blocked capital receipt.

## Problem

Torghut currently exposes healthy infrastructure and degraded lane evidence at the same time.

That is a reasonable observe state. It is not a paper or live capital state. A strategy cannot claim fresh expected
edge from an empty account-scoped store. It cannot claim fillability from zero decisions and zero orders. It cannot
claim current market fitness while lane-required fundamentals and news are stale. It cannot claim live authority when
live submission is explicitly disabled.

The system needs a capital drain that turns absent proof into zero effective edge, while preserving observe and repair.

## Alternatives Considered

### Option A: Keep Live Submission Disabled And Wait For Manual Promotion

Pros:

- Lowest implementation cost.
- Live capital stays safe.
- Operators can inspect route health manually.

Cons:

- Paper and shadow lanes can still accumulate vague promotion claims.
- No measurable reason tells a lane how to earn capital back.
- Zero decision count and empty metrics remain operational details instead of profit inputs.

Decision: reject as sufficient. Manual disablement is a brake, not a profitability architecture.

### Option B: Use Only Empirical Jobs And Database Readiness

Pros:

- Uses existing `/readyz` fields.
- Current empirical jobs are healthy, which would simplify gates.
- Avoids pulling route-specific metrics into the capital path.

Cons:

- Misses the active paper account empty-store alarm.
- Misses critical quant lag alerts.
- Misses stale market-context domains.
- Misses the fact that the lane has zero current decisions and zero orders.

Decision: reject. Healthy empirical jobs are necessary, not sufficient.

### Option C: Proof-Carry Watermarks With Zero-Decision Capital Drain

Torghut computes a proof-carry watermark per lane/account/window and drains effective edge to zero when proof is
empty, stale, contradicted, or unsupported by recent decision tape.

Pros:

- Directly prices the observed empty paper store and zero decision tape.
- Preserves zero-notional observe and repair.
- Gives Jangar consumer evidence escrow exact refs and missing proof names.
- Makes paper and live promotion falsifiable.
- Lets profitability experiments measure repair return, not just readiness.

Cons:

- Adds a new capital calculation step.
- Requires route compatibility with Jangar escrow refs.
- Needs shadow calibration to avoid over-penalizing newly created lanes.

Decision: select Option C.

## Architecture

### ProofCarryWatermark

Torghut emits one proof-carry watermark per lane, strategy, account, and window.

```text
proof_carry_watermark
  watermark_id
  generated_at
  expires_at
  lane_id
  strategy_id
  account
  window
  quant_latest_metrics_count
  quant_latest_metrics_updated_at
  open_critical_alert_refs
  market_context_claim_ref
  empirical_job_refs
  recent_decision_count
  recent_submitted_order_count
  simulated_fill_count
  live_submission_gate_state
  jangar_consumer_evidence_escrow_ref
  decision                 # proof_fresh, observe_only, repair_only, hold, block
  reason_codes
```

Rules:

1. `quant_latest_metrics_count=0` sets `decision=observe_only` for paper and blocks live.
2. Any open critical account/window proof alert sets the watermark to `repair_only` unless explicitly waived.
3. Stale lane-required market-context domains hold paper and live.
4. Zero recent decisions or zero simulated fills drains positive edge to zero unless the lane is explicitly in a
   cold-start observation period.
5. Live submission disabled blocks live regardless of other proof.

### ZeroDecisionCapitalDrain

Torghut computes post-drain edge before paper or live promotion.

```text
zero_decision_capital_drain
  drain_id
  generated_at
  lane_id
  pre_drain_expected_edge_bps
  empty_store_discount_bps
  stale_context_discount_bps
  critical_alert_discount_bps
  zero_decision_discount_bps
  live_gate_discount_bps
  post_drain_expected_edge_bps
  stage_cap
  required_repairs
```

Final rule:

```text
post_drain_expected_edge_bps =
  pre_drain_expected_edge_bps
  - empty_store_discount_bps
  - stale_context_discount_bps
  - critical_alert_discount_bps
  - zero_decision_discount_bps
  - live_gate_discount_bps
```

If `post_drain_expected_edge_bps <= 0`, the lane remains observe or shadow repair with max notional `0`.

### Jangar Escrow Feed

Torghut sends or exposes:

- `proof_carry_watermark_ref`;
- `zero_decision_capital_drain_ref`;
- missing proof reason codes;
- post-drain edge;
- stage cap;
- repair actions.

Jangar consumes those fields in `consumer_evidence_escrow` and material action receipts. Jangar does not recalculate
Torghut edge; it enforces whether the consumer evidence is present, fresh, and compatible with the requested action.

## Profitability Hypotheses

H1: Draining account-scoped empty metrics to zero edge reduces false-positive paper promotions compared with using
unscoped quant runtime freshness.

H2: Requiring recent decision tape before paper promotion increases realized paper fillability because lanes must prove
they can produce actionable decisions in the current runtime.

H3: Blocking paper/live while stale market-context domains are required by the lane reduces drawdown from stale
feature inputs.

H4: Keeping observe available during proof gaps improves repair throughput without increasing live risk.

Measurements:

- false-positive paper promotion rate;
- time from proof alert open to repaired watermark;
- paper fillability after watermark enforcement versus prior shadow lanes;
- number of lanes held by each drain reason;
- post-drain expected edge distribution by strategy family.

## Implementation Scope

Engineer stage:

- Add proof-carry watermark calculation near the submission council or profitability archive boundary.
- Add zero-decision drain calculation before capital activation receipts.
- Surface watermark and drain refs in the Torghut capital verdict payload consumed by Jangar.
- Add tests for empty account-scoped latest store, open critical alerts, stale required market-context domains, zero
  decision count, and live submission disabled.
- Keep existing `/readyz` infrastructure checks, but stop treating them as capital evidence by themselves.

Deployer stage:

- Validate live `/readyz` still reports database, ClickHouse, Alpaca, schema, universe, and live gate state.
- Validate Jangar quant health for the exact account/window requested by paper or live.
- Confirm paper/live are blocked when proof-carry watermark is not `proof_fresh`.
- Confirm observe remains available and max notional remains `0` during repair.

## Validation Gates

Local validation:

- `uv sync --frozen --extra dev`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- Targeted Torghut tests for submission council and profitability archive.

Cross-plane validation:

- `curl -sS -i http://torghut.torghut.svc.cluster.local/readyz`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=1d'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/alerts?state=open'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/metrics`

Acceptance gates:

- Paper capital is observe-only when `latestMetricsCount=0` for the requested account/window.
- Live capital is blocked while `simple_submit_disabled` is present.
- Critical proof alerts appear in drain reasons.
- Stale lane-required market context appears in drain reasons.
- A lane with zero decisions and zero fills cannot produce positive post-drain edge outside a documented cold-start
  observation window.

## Rollout And Rollback

Roll out in shadow mode first. Publish proof-carry watermarks and drains, but keep existing capital decisions unchanged
for one release so the team can inspect false holds.

Move to enforcement when shadow output correctly blocks the known empty paper account, known stale market-context
domains, and live submission disabled state without blocking observe.

Rollback by disabling capital-drain enforcement and keeping the watermark payload as observability. Existing live
submission toggles, empirical job gates, data-plane disruption premium, and freshness settlement remain valid.

## Risks

- Newly created lanes can look like zero-decision failures. Mitigation: explicit cold-start observation windows with
  max notional `0`.
- Critical alert volume can over-block if alerts are not account/window scoped. Mitigation: require alert refs to match
  the lane account/window or be marked global.
- Draining expected edge to zero may hide a promising alpha during data outage. Mitigation: track repair return and
  time-to-proof, not just blocked counts.
- Jangar and Torghut can diverge on evidence naming. Mitigation: Jangar consumes refs and decisions, while Torghut owns
  edge arithmetic.

## Handoff

Engineer acceptance:

- Implement proof-carry watermark and zero-decision drain with targeted tests.
- Export refs and drain reasons for Jangar consumer evidence escrow.
- Do not allow infrastructure readiness alone to produce paper or live capital authority.

Deployer acceptance:

- Before paper promotion, verify the exact account/window watermark is `proof_fresh`.
- Before live promotion, verify paper settlement is complete and live submission gate is enabled.
- If the drain over-blocks, disable enforcement and keep watermarks in observe mode for root-cause review.
