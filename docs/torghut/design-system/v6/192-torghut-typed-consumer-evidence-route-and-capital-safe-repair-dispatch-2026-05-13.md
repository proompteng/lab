# 192. Torghut Typed Consumer-Evidence Route And Capital-Safe Repair Dispatch (2026-05-13)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting **typed consumer-evidence route authority** as the next Torghut quant architecture step.

Torghut now has enough live evidence to distinguish "safe but not profitable" from "unobservable." The live service
is running, the typed `/trading/consumer-evidence` route answers with `torghut.consumer-evidence-status.v1`, empirical
jobs are fresh, route warrants exist, repair-bid settlement exists, and capital remains at `max_notional=0`. The
business problem is narrower: Jangar was configured to consume `/trading/autonomy`, so the control plane saw missing
consumer evidence even while the typed evidence route was current enough to classify exact repair work.

The decision is to make `/trading/consumer-evidence` the single Torghut-to-Jangar quant admission route. Torghut owns
that route's schema, freshness, compactness, and capital-safe semantics. Jangar owns admission decisions that consume
it. The route must be strong enough for repair dispatch and conservative enough that no paper or live notional can be
derived from a partial packet.

The tradeoff is operational strictness. A stale typed route will hold Jangar dispatch even if other Torghut diagnostic
routes are healthy. I accept that because repair and capital admission need one authoritative contract. Diagnostics can
stay broad; admission needs a small route with explicit proof refs and `max_notional=0` when the evidence is not ready.

## Governing Runtime Requirements

Every run must cite the governing Torghut design or runtime requirement before changing code. Implementation stages
must produce production PRs that improve readiness, profit evidence, data freshness, execution quality, or capital
safety. Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading
or evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker
preventing revenue impact.

This design maps to the value gates:

- `capital_gate_safety`: consumer evidence must carry route-warrant and repair-bid `max_notional=0` while blocked.
- `zero_notional_or_stale_evidence_rate`: stale reasons become dispatchable zero-notional repair lots instead of
  generic missing evidence.
- `routeable_candidate_count`: routeability can increase only from a typed packet with current route warrants,
  repair-bid settlement, source-serving proof, and TCA.
- `fill_tca_or_slippage_quality`: active-session TCA quality is a typed blocker with required output receipts.
- `post_cost_daily_net_pnl`: profit evidence remains repair-only until the typed route provides current post-cost
  receipts and capital gates.

## Read-Only Evidence Snapshot

All cluster and database assessment was read-only. No Kubernetes objects, database rows, trading flags, broker state,
or AgentRuns were mutated.

### Cluster And Runtime

- Torghut core revision `torghut-00338` and sim revision `torghut-sim-00436` were ready.
- Options catalog and options enricher were ready after rolling to image digest
  `sha256:d8a0f28d22bccf28ced6032a6465e32ab715a830e4eb07425ede3d9f7d068036`.
- ClickHouse, Keeper, Postgres, TA, TA sim, WebSocket, options TA, and guardrail exporters were running.
- `torghut-db-migrations` completed during the evidence window.
- Recent events showed ordinary rollout startup/readiness probe failures for new revisions before they became ready,
  plus one whitepaper profit-target job in `Error`.
- `/readyz` returned HTTP 503 during the evidence pass, while `/db-check` was healthy and `/trading/consumer-evidence`
  returned HTTP 200.

### Source

- `services/torghut/app/main.py` builds `_build_trading_consumer_evidence_payload()` and exposes it at
  `/trading/consumer-evidence`.
- The payload includes `torghut_consumer_evidence_receipt`, `route_proven_profit_receipt`,
  `capital_reentry_cohort_ledger`, `profit_repair_settlement_ledger`, `routeability_repair_acceptance_ledger`,
  `profit_freshness_frontier`, `evidence_clock_arbiter`, `routeable_profit_candidate_exchange`,
  `repair_bid_settlement_ledger`, and `route_warrant_exchange`.
- Jangar source already parses this route in
  `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`.
- Jangar tests already use `/trading/consumer-evidence` as the successful endpoint.
- GitOps still pointed Jangar at `/trading/autonomy`, which is an integration bug rather than a Torghut route gap.

### Database And Data

- `/db-check` reported `ok=true`, `schema_current=true`, current and expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, lineage ready, and account-scope ready.
- The schema graph still has known parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; the current head count and expected head count both equal `1`.
- Runtime profitability for `72h` reported `29` decisions, `0` executions, and `500` TCA samples.
- Realized PnL proxy from TCA shortfall was negative, average realized shortfall was `4.14805219806` bps, and adverse
  excursion p95 was `52.00243128` bps.
- TCA summary reported `7334` orders, `7245` filled executions, average absolute slippage
  `13.8203637593029676` bps, expected shortfall coverage `0`, and latest execution timestamp
  `2026-04-02T19:00:29.586040+00:00`.
- Empirical jobs were fresh for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`, all tied to candidate `chip-paper-microbar-composite@execution-proof`.
- Hypothesis status had three hypotheses, zero promotion-eligible, two rollback-required, all capital multipliers `0`,
  and blockers including `feature_rows_missing`, `required_feature_set_unavailable`, and
  `post_cost_expectancy_non_positive`.
- Route warrant evidence reported `repair_only`, `max_notional=0`, `routeable_candidate_count=0`,
  `zero_notional_or_stale_evidence_rate=0.8`, and blockers across direct data, quant ingestion, active TCA,
  routeability, profit signal, rollout image, and submission.

## Problem

Torghut has a typed evidence route, but the surrounding control-plane contract did not force Jangar to consume it.

The failure modes are:

1. Jangar can classify Torghut evidence as missing while `/trading/consumer-evidence` is live.
2. Repair-bid settlement can be present but invisible to dispatch admission.
3. Route-warrant blockers can be precise in Torghut and generic in Jangar.
4. Source-serving proof can be designed but never enforced if the consumer route is not the configured authority.
5. Operators can see healthy pieces and missing control-plane evidence at the same time, which weakens trust in the
   readiness surface.
6. Zero-notional repair work can be under-dispatched because the control plane cannot see exact dispatchable lots.

This does not justify paper or live capital. It just means the system is spending proof work inefficiently.

## Alternatives Considered

### Option A: Keep `/trading/autonomy` As Compatibility Surface

Let `/trading/autonomy` remain Jangar's configured endpoint and add compatibility fields there.

Advantages:

- Minimal deployment blast radius.
- Preserves current route shape.
- Avoids changing Jangar GitOps values.

Disadvantages:

- Blurs autonomy status and consumer evidence authority.
- Forces another payload to mirror route warrants and repair-bid settlement.
- Makes schema drift more likely.
- Leaves existing Jangar tests and production values pointed at different contracts.

Decision: reject.

### Option B: Move All Evidence To `/trading/status`

Make `/trading/status` the admission surface because it already contains broad runtime detail.

Advantages:

- Single broad Torghut status route.
- Easier for manual inspection.
- Many fields are already there.

Disadvantages:

- Too large and operationally broad for admission.
- Contains diagnostic fields that are not proof contracts.
- Makes it harder to keep Jangar's timeout, schema, and freshness semantics strict.

Decision: reject for admission; keep it as diagnostics.

### Option C: Promote `/trading/consumer-evidence` To Admission Authority

Keep `/trading/consumer-evidence` compact, schema-versioned, and capital-safe. Point Jangar to it and make every
repair and promotion decision consume this route.

Advantages:

- Matches the route Torghut already exposes and Jangar already parses.
- Keeps route warrants and repair-bid settlement close to capital-hold semantics.
- Makes zero-notional dispatch precise.
- Gives deployer one route to verify after rollout.
- Preserves paper/live safety with `max_notional=0` while evidence is stale.

Disadvantages:

- Requires the route to remain strict and small.
- Route staleness becomes an admission hold.
- Future payload additions need schema discipline.

Decision: select Option C.

## Architecture

Torghut publishes an admission-safe packet on `/trading/consumer-evidence`:

```text
torghut.consumer-evidence-status.v1
  generated_at
  enabled
  mode
  running
  build
    version
    commit
    image_digest
    active_revision
  torghut_consumer_evidence_receipt
  route_proven_profit_receipt
  route_warrant_exchange
  repair_bid_settlement_ledger
  source_serving_repair_receipt_ledger
  evidence_clock_arbiter
  routeable_profit_candidate_exchange
  profit_freshness_frontier
  routeability_repair_acceptance_ledger
  profit_repair_settlement_ledger
  live_submission_gate
  simple_lane_status
```

The packet is an admission contract, not an order instruction.

Decision rules:

- Missing or schema-mismatched `torghut.consumer-evidence-status.v1` blocks repair dispatch, paper, and live.
- Missing `route_warrant_exchange` blocks paper/live and limits repair dispatch to observe-only.
- `route_warrant_state=repair_only` allows only zero-notional repair packets.
- Missing or stale `repair_bid_settlement_ledger` holds repair-bid admission even if route warrants exist.
- `routeable_candidate_count` can increase only when route warrants, repair-bid settlement, source-serving proof,
  active TCA, empirical replay, and profit-signal quorum are current for the same account/window.
- `max_notional` is the strict minimum across route warrant, repair-bid settlement, proof floor, and live submission
  gate.
- `live_submission_gate.allowed=false` is authoritative even if other fields are healthy.

## Implementation Scope

This PR implements the first production step:

- Point Jangar GitOps configuration at `/trading/consumer-evidence`.
- Publish the Jangar and Torghut architecture contracts for typed evidence admission.
- Update docs indexes so subsequent engineer and deployer stages cite this design.

Engineer milestone 1:

- Add a test or config lint that rejects production `JANGAR_TORGHUT_STATUS_URL` values not ending in
  `/trading/consumer-evidence`.
- Keep `/trading/consumer-evidence` under an explicit schema version and add compatibility rules only with expiries.
- Add `source_serving_repair_receipt_ledger` from design `191` into the typed route.

Engineer milestone 2:

- Teach repair dispatch to consume only `dispatchable_lot_ids` from current repair-bid settlement.
- Require each dispatchable lot to include value gate, output receipt, TTL, dedupe key, validation command,
  max runtime, max parallelism, and `max_notional=0`.
- Keep held lots visible with exact hold reasons.

Engineer milestone 3:

- Connect post-deploy evidence to the typed route so Jangar can compare source SHA, serving build commit, image digest,
  route-warrant presence, repair-bid settlement presence, and source-serving proof.

Deployer milestone:

- After Argo sync, capture Jangar control-plane status and Torghut consumer evidence.
- Prove the configured endpoint is `/trading/consumer-evidence`.
- Prove no paper/live notional is enabled by this change.

## Validation Gates

Local validation for this PR:

- `bunx oxfmt --check argocd/applications/agents/values.yaml services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts docs/agents/designs/188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md docs/torghut/design-system/v6/192-torghut-typed-consumer-evidence-route-and-capital-safe-repair-dispatch-2026-05-13.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `bun test services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts`
- `git diff --check`

Engineer validation:

- Unit tests prove `/trading/autonomy` is not accepted as production consumer-evidence admission config.
- Jangar resolver tests prove current, stale, missing, schema-mismatch, route-warrant, and repair-bid settlement states.
- Torghut route tests prove `/trading/consumer-evidence` contains the required contract set without enabling capital.
- Repair dispatch tests prove stale route warrants and stale repair-bid settlement keep dispatch held.

Deployer validation:

- Jangar control-plane status reports endpoint `/trading/consumer-evidence`.
- Torghut consumer evidence route reports route warrants and repair-bid settlement.
- `capital_decision=repair_only`, `routeable_candidate_count=0`, and `max_notional=0` are preserved.
- `/db-check` remains schema current.
- The latest Torghut image and active revision are captured.

## Rollout

Phase 1 changes Jangar GitOps config. Argo rolls the control-plane deployment.

Phase 2 verifies typed evidence intake. Expected improvement: Jangar moves from
`torghut_consumer_evidence_missing` to current or stale typed evidence with exact route-warrant and repair-bid reason
codes.

Phase 3 allows zero-notional dispatch repair to consume current dispatchable lots. Paper/live remain blocked.

Phase 4 adds source-serving repair receipt ledger to the route and makes it a dispatch input.

Phase 5 considers paper canary only after route warrants, repair-bid settlement, source-serving proof, active TCA,
empirical replay, quant health, and profit signals are all current.

## Rollback

If the typed route fails hard, roll back Jangar admission to observe-only and keep route warrants as Torghut's local
capital hold. Do not enable paper or live through another route.

If the route is stale but reachable, keep repair dispatch held and publish stale reason codes.

If the route is current but missing a contract, treat it as schema or contract drift and hold the affected action
classes.

If Jangar consumes a malformed field, default to the stricter state: `repair_only`, `max_notional=0`,
`routeable_candidate_count=0`, and live blocked.

## Risks

- The typed route can become overloaded with evidence. Mitigation: expose ids, summaries, and refs instead of full raw
  artifacts.
- Dispatch repair may become more active once Jangar can see typed lots. Mitigation: enforce zero notional, TTL,
  dedupe, max parallelism, and validation command gates.
- Old operators may still use `/trading/autonomy`. Mitigation: keep it documented as diagnostics, not admission.
- Source-serving proof remains incomplete because `image_digest` is currently null. Mitigation: keep source-serving
  proof as a separate capital hold until runtime image metadata is wired.

## Handoff

Engineer acceptance gate: `/trading/consumer-evidence` remains the only Torghut admission route, includes route
warrants, repair-bid settlement, source-serving proof refs, and capital holds, and all tests prove malformed or stale
packets keep `max_notional=0`.

Deployer acceptance gate: after rollout, Jangar cites `/trading/consumer-evidence` and classifies Torghut with typed
route-warrant and repair-bid reason codes, while Torghut still reports `repair_only`, `routeable_candidate_count=0`,
and live submission blocked.

The revenue metric improved is `zero_notional_or_stale_evidence_rate`: typed evidence lets Jangar spend repair work on
the actual stale dimensions instead of a false missing-evidence hold. The smallest blocker preventing direct revenue
impact remains execution-quality and data freshness: no recent executions, stale active-session TCA from
`2026-04-02`, expected-shortfall coverage `0`, and no routeable candidates.
