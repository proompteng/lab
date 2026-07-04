# 182. Torghut Route-Proven Profit Receipts And Consumer Evidence Canary (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut profitability, consumer evidence route parity, Jangar source-serving escrow consumption, capital
guardrails, validation, rollout, rollback, and measurable trading hypotheses.

Companion Jangar contract:

- `docs/agents/designs/178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`

Extends:

- `181-torghut-quality-adjusted-profit-frontier-and-hypothesis-escrow-2026-05-08.md`
- `180-torghut-resource-priced-evidence-frontier-and-context-spend-escrow-2026-05-08.md`
- `179-torghut-capital-repair-frontier-and-route-yield-clearance-2026-05-08.md`
- `docs/agents/designs/177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`

## Decision

I am selecting **route-proven profit receipts with a consumer-evidence canary** as Torghut's next profitability
architecture step.

The current Torghut runtime has useful proof, but the Jangar-facing receipt path is not live. On 2026-05-08 around
04:28Z, `/trading/status` on live revision `torghut-00297` returned a proof floor in `repair_only` with
`capital_state=zero_notional`. It had fresh empirical jobs, a live proof-floor timestamp, and a route reacquisition
book that ranked repair candidates. The same status payload showed execution TCA blockers, alpha readiness blockers,
simple submission disabled, and zero paper or live notional. That is good capital safety.

The missing piece is route-proven evidence. Source at the current merge head defines `/trading/consumer-evidence`, and
the receipt builder exists in `services/torghut/app/trading/consumer_evidence.py`. The live service returned HTTP 404
for that route through both the Knative service and the active private service. Jangar therefore reported
`torghut_consumer_evidence.status=unavailable`, degraded empirical service consumers, and held or blocked material
actions. Torghut has proof internally, but it did not present the proof on the route Jangar consumes.

The selected design makes route proof part of profit proof. A Torghut receipt cannot be capital-authoritative just
because it exists in source code or inside `/trading/status`. It must be observed on the consumer route, tied to the
serving revision and image digest, and canaried by Jangar before it can influence paper or live capital. When the
consumer route is missing, Torghut stays zero-notional and emits a high-priority repair packet rather than asking
Jangar or the submission council to infer from adjacent routes.

The tradeoff is that a profitable-looking internal proof can still be held when the route contract is broken. I accept
that. Profitability depends on the system spending the right receipt at the right boundary. If the receipt cannot
cross the boundary where Jangar enforces capital and rollout authority, it is not yet a production profit signal.

## Success Metrics

Success means:

- Torghut emits `route_proven_profit_receipt` from `/trading/consumer-evidence`.
- The receipt records `receipt_id`, `generated_at`, `fresh_until`, `serving_revision`, `image_digest`,
  `route_canary_id`, `jangar_parity_escrow_ref`, `proof_floor_state`, `capital_state`, `max_notional`,
  `candidate_id`, `dataset_snapshot_ref`, `route_repair_value`, `decision`, and `rollback_target`.
- `/trading/status` may include the same receipt for operator context, but Jangar treats `/trading/consumer-evidence`
  as the action boundary.
- HTTP 404, schema mismatch, stale receipt, and missing receipt are different repair reasons.
- Paper and live notional remain zero when the route canary is missing, even if internal empirical jobs are healthy.
- Route repair packets rank work by expected unblock value, not by newest error.
- Jangar source-serving parity escrow can cite the Torghut receipt without recursively calling Jangar status.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, Torghut database rows, trading flags, or
GitOps manifests.

### Runtime And Cluster Evidence

- Torghut active user pod was `torghut-00297-deployment-6d749db458-zt29s`, serving image digest
  `sha256:a5f1bfde242b80a1c18d7776859dcb1b56d69c5ec5d742bb59b5244ec54c87a2`.
- The pod was ready, but the user container had restarted four times and the last termination was exit code 137.
- Torghut, Torghut sim, Postgres, ClickHouse, Keeper, WebSocket, options, and TA pods were running. The earlier sim
  ImagePullBackOff seen by the swarm had cleared.
- `/trading/autonomy` returned a live payload with empirical jobs fresh, signal continuity in expected market-closed
  staleness, forecast service degraded by `registry_empty`, lean authority disabled, and autonomy disabled.
- `/trading/status` returned proof floor `repair_only`, route state `repair_only`, capital state `zero_notional`, and
  blockers `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `simple_submit_disabled`.
- `/trading/consumer-evidence` returned HTTP 404 through both the main Torghut service and the active private service.

### Source Evidence

- `services/torghut/app/main.py` defines `_build_trading_consumer_evidence_payload` and
  `@app.get("/trading/consumer-evidence")`.
- `services/torghut/app/trading/consumer_evidence.py` builds schema
  `torghut.consumer-evidence-receipt.v1` and stable receipt ids of the form `torghut-consumer-evidence:*`.
- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts` expects that route and maps failed fetches
  to `torghut_consumer_evidence_unavailable`.
- The live route behavior contradicts source, so source presence alone cannot be a capital or rollout permit.

### Database And Data Evidence

- Torghut DB identity was database `torghut`, user `torghut_app`, observed at `2026-05-08T04:25:18.991Z`.
- Torghut had 69 public base tables and Alembic version `0029_whitepaper_embedding_dimension_4096`.
- `execution_tca_metrics` had 13,775 rows updated at `2026-05-08T02:38:30Z`.
- `position_snapshots` had 43,757 rows updated at `2026-05-07T20:58:04Z`.
- `trade_decisions` had 147,623 rows with latest created at `2026-05-06T17:44:19Z`.
- `vnext_empirical_job_runs` had 24 rows updated at `2026-05-07T21:27:18Z`.
- Strategy hypothesis state was sparse but current enough for repair triage: one strategy hypothesis, one promotion
  decision, three hypothesis metric windows, and one dataset snapshot updated at `2026-05-06T22:34:19Z`.
- ClickHouse pods were healthy, but direct HTTP access returned 401 without credentials in this observer context.

### Profit Evidence

- Proof floor kept `max_notional=0`.
- Empirical jobs were fresh and authoritative for candidate `chip-paper-microbar-composite@execution-proof` on
  dataset `torghut-chip-full-day-20260505-4c330ce9-r1`.
- Execution TCA had 7,334 orders, 7,245 filled executions, average absolute slippage about 13.82 bps, and a slippage
  guardrail of 8 bps.
- Route evidence was incomplete: one probing symbol (`AAPL`), four blocked symbols (`AMD`, `AVGO`, `INTC`, `NVDA`),
  and three missing symbols (`AMZN`, `GOOGL`, `ORCL`).
- The repair book ranked NVDA, AMD, INTC, AVGO, AMZN, GOOGL, and ORCL as repair candidates with expected unblock value 14.

## Problem

Torghut currently has internal proof that cannot be spent by Jangar.

The failure modes are:

1. A receipt can exist in source while the live serving route returns 404.
2. `/trading/status` can contain enough context for humans, but Jangar's action contract expects a dedicated
   consumer-evidence route.
3. A missing route and a stale receipt are currently both downstream "unavailable" from Jangar's point of view.
4. Profit repair ranking does not explicitly price the value of restoring the receipt boundary.
5. Source and serving image digest are not carried in the profit receipt, so consumers cannot prove which revision
   generated the receipt.
6. Capital gates can only stay conservative; they cannot explain which route repair unlocks the next safe action.

Torghut needs profit receipts that prove their own delivery path.

## Alternatives Considered

### Option A: Let Jangar Fall Back To `/trading/status`

Teach Jangar to read `torghut_consumer_evidence_receipt` from `/trading/status` when `/trading/consumer-evidence`
returns 404.

Advantages:

- Fastest operational recovery.
- Uses an already-live route.
- Low Torghut code churn.

Disadvantages:

- Hides a broken consumer contract.
- Makes one large operator status route action-authoritative.
- Reintroduces route ambiguity for future receipt versions.

Decision: reject as the primary architecture. It may be a temporary compatibility override, but it is not the right
capital boundary.

### Option B: Block All Torghut Profit Work Until The Route Is Fixed

Keep every Torghut repair, paper, and live action held while the consumer-evidence route is missing.

Advantages:

- Simple and safe.
- Prevents capital from relying on ambiguous proof.
- Easy for Jangar to enforce.

Disadvantages:

- Blocks useful zero-notional repair.
- Does not rank which repair restores capital option value.
- Treats endpoint repair and alpha repair as the same failure class.

Decision: use for live and paper capital, not for observe-only or route repair.

### Option C: Route-Proven Profit Receipts With Consumer Evidence Canary

Make the receipt route itself a canaried proof surface. Torghut keeps internal proof and zero-notional repair running,
but paper/live gates require Jangar to observe the receipt on the live route and schema.

Advantages:

- Separates internal proof from cross-plane capital authority.
- Gives Jangar a small, stable receipt route.
- Turns HTTP 404 into a ranked route repair packet.
- Carries serving revision and image digest in the receipt for auditability.

Disadvantages:

- Requires stricter deploy validation and route canarying.
- May temporarily hold paper opportunities after a source fix until serving parity is observed.
- Adds receipt schema compatibility tests.

Decision: select Option C.

## Architecture

Torghut exposes a dedicated route-proven receipt:

```text
route_proven_profit_receipt
  schema_version
  receipt_id
  generated_at
  fresh_until
  serving_revision
  source_commit
  image_digest
  route_canary_id
  jangar_parity_escrow_ref
  proof_floor_state
  route_state
  capital_state
  max_notional
  candidate_id
  dataset_snapshot_ref
  empirical_jobs_state
  forecast_registry_state
  tca_state
  paper_readiness_state
  live_readiness_state
  route_repair_value
  reason_codes
  decision                 # observe | repair | hold | block
  rollback_target
```

The canary is intentionally small:

```text
consumer_evidence_canary
  route_ref=/trading/consumer-evidence
  method=GET
  expected_status=200
  expected_schema=torghut.consumer-evidence-status.v1
  expected_receipt_schema=torghut.consumer-evidence-receipt.v1
  max_payload_bytes=65536
  max_latency_ms=3000
```

Rules:

- Missing route: decision `repair`, paper/live notional `0`, repair reason `consumer_evidence_route_missing`.
- Stale receipt: decision `hold`, paper/live notional `0`, repair reason `consumer_evidence_stale`.
- Schema mismatch: decision `hold`, paper/live notional `0`, repair reason `consumer_evidence_schema_mismatch`.
- Current receipt with proof floor repair-only: decision `repair`, paper/live notional `0`, repair reason from proof
  floor.
- Current receipt with proof floor pass and Jangar parity convergence: paper canary may open within configured
  notional limits.

## Measurable Trading Hypotheses

The receipt does not assert profit by itself. It creates a clean boundary for measuring profit hypotheses:

- H1: Route repair that moves a symbol from missing/blocked to probing increases next-session paper candidate count
  without increasing average absolute slippage above the guardrail.
- H2: Consumer-evidence route convergence reduces Jangar material-action holds without changing Torghut capital state
  until proof floor passes.
- H3: Repairing the top route candidates ranked by expected unblock value yields higher paper opportunity density than
  repairing the newest failing symbol first.
- H4: Paper canary opens only after receipt route parity, proof floor pass, and route/TCA guardrails are all current.

Initial metrics:

- `consumer_evidence_route_canary_success_total`
- `consumer_evidence_route_canary_failure_total{reason}`
- `route_proven_profit_receipt_current`
- `route_repair_expected_unblock_value`
- `paper_candidate_count`
- `paper_probe_notional_limit`
- `live_notional_limit`

## Implementation Scope

Engineer stage should implement:

- A route-proven receipt wrapper around the existing consumer-evidence builder.
- Tests that assert `/trading/consumer-evidence` returns HTTP 200 with schema and receipt ids.
- Tests that missing/stale/schema-mismatched receipts map to distinct decisions.
- Jangar parity escrow consumption in Torghut status without recursive Jangar status fetches.
- A compatibility flag for temporary `/trading/status` fallback, default off for action-grade evidence.

Deployer stage should implement:

- Post-rollout canary checks for `/trading/consumer-evidence` on the live Knative service and active private service.
- A release gate that blocks Torghut deploy widening if the source route exists but the serving route returns 404.
- Rollout evidence that records serving revision, image digest, route canary id, and receipt id.

## Validation Gates

Local validation:

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k consumer_evidence`
- `uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py`
- `bun --cwd services/jangar run test -- control-plane-torghut-consumer-evidence`

Cluster validation:

- `curl http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` returns HTTP 200 with
  `torghut_consumer_evidence_receipt.receipt_id`.
- `curl` against the active Torghut private service for `/trading/consumer-evidence` returns the same schema.
- Jangar status reports `torghut_consumer_evidence.status=current` or, while route repair is pending,
  `route_missing` rather than generic unavailable.
- Paper/live notional stays zero until proof floor, route canary, and Jangar parity are all current.

Data validation:

- Receipt `fresh_until` is in the future and no more than the configured short TTL.
- Receipt `serving_revision` matches the active Knative revision.
- Receipt `image_digest` matches the user-container image digest.
- Route repair value matches route reacquisition book summary.

## Rollout

1. Add receipt route tests and route canary metrics.
2. Deploy route-proven receipt in shadow mode while Jangar still records unavailable evidence.
3. Enable Jangar parity escrow to distinguish 404, stale, and schema mismatch.
4. Require route-proven receipt for paper canary and live gates.
5. Remove any temporary `/trading/status` fallback once the route has been stable for a full trading session.

## Rollback

- Set `TORGHUT_CONSUMER_EVIDENCE_CANARY_ENFORCEMENT=shadow` to keep the route visible but non-blocking.
- Set Jangar Torghut consumer evidence to compatibility fallback only for observe/repair classes, never paper/live.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and `max_notional=0` while route parity is unresolved.
- Revert to the prior proof-floor-only capital gate only if the receipt route causes false paper/live blocks after
  proof-floor pass and Jangar parity convergence.

## Risks

- Route canary can fail during Knative cold starts. Mitigation: short retry window plus serving revision correlation,
  while capital remains zero-notional.
- Receipt shape can drift. Mitigation: schema versions and contract tests in both Torghut and Jangar.
- `/trading/status` may appear healthier than the receipt route. Mitigation: keep operator status separate from the
  action boundary.
- Repair ranking can overvalue route work. Mitigation: compare route repair expected unblock value against realized
  paper candidate count and slippage changes.

## Handoff

Engineer acceptance gate: `/trading/consumer-evidence` must be a first-class tested API that returns a current receipt
with serving revision, image digest, and proof-floor state; Jangar must distinguish route missing, stale, and schema
mismatch.

Deployer acceptance gate: do not widen Torghut after a source route change until the live revision and active private
service both pass the consumer-evidence canary.

Capital acceptance gate: keep paper and live notional at zero while the route canary is missing, stale, schema
mismatched, or not converged with Jangar parity escrow.
