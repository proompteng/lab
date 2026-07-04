# 188. Jangar Typed Torghut Evidence Admission And Repair Dispatch (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane Torghut evidence intake, typed consumer evidence route binding, repair-bid admission,
route-warrant dispatch custody, capital safety, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/192-torghut-typed-consumer-evidence-route-and-capital-safe-repair-dispatch-2026-05-13.md`

Extends:

- `187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
- `186-jangar-route-warrant-dispatch-custody-and-dependency-verdicts-2026-05-13.md`
- `../torghut/design-system/v6/191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md`
- `../torghut/design-system/v6/190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`

## Decision

I am selecting **typed Torghut consumer-evidence admission** as the next Jangar control-plane reliability contract.

The fresh evidence says the blocker has moved. Torghut is serving revision `torghut-00338`; the live and sim pods are
ready; the options catalog and enricher are ready; database schema is current at Alembic head
`0031_autoresearch_candidate_spec_epoch_uniqueness`; empirical replay jobs are fresh; and Torghut's typed
`/trading/consumer-evidence` route returns route warrants, repair-bid settlement, evidence clocks, profit freshness,
and capital holds. At the same time, Jangar reports `torghut_consumer_evidence_missing` because its GitOps config still
points `JANGAR_TORGHUT_STATUS_URL` at `/trading/autonomy`, a legacy operational surface that does not carry
`torghut.consumer-evidence-status.v1`.

The decision is to make `/trading/consumer-evidence` the Jangar intake boundary for Torghut quant. Jangar already has a
resolver and tests that expect that route and schema. The missing piece is source-serving configuration convergence:
the control plane must read the typed evidence route before it judges repair-bid admission, route-warrant dispatch,
source-serving verdicts, paper canary, or live canary action classes.

The tradeoff is that Jangar will now see more Torghut blockers, not fewer. That is the right outcome. Typed evidence
will convert a generic missing-consumer-evidence hold into exact repair lots: stale TA data, missing quant health,
stale active-session TCA, missing rollout image proof, no routeable candidates, and `simple_submit_disabled`. It does
not open capital. It keeps `max_notional=0` and improves the repair queue's ability to work on the smallest blocker.

## Governing Runtime Requirements

Every Torghut quant run must cite the governing Torghut design or runtime requirement before changing code.
Implementation stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
quality, or capital safety. Verify stages must merge only green PRs and prove image promotion, Argo sync, live service
health, and trading or evidence status after rollout. Final handoff must name the revenue metric improved or the
smallest blocker preventing revenue impact.

This contract maps to the value gates:

- `capital_gate_safety`: typed route warrants and repair bids keep paper/live blocked when `max_notional=0`.
- `zero_notional_or_stale_evidence_rate`: Jangar stops treating typed Torghut evidence as missing and can route stale
  evidence to exact zero-notional repair lots.
- `routeable_candidate_count`: Jangar reads `accepted_routeable_candidate_count=0` from Torghut instead of inferring
  routeability from a legacy route.
- `fill_tca_or_slippage_quality`: Jangar admits active-session TCA repair only from the typed TCA witness and repair
  packet.
- `post_cost_daily_net_pnl`: post-cost claims remain repair-only until typed Torghut evidence exposes current profit
  receipts and routeable candidates.

## Read-Only Evidence Snapshot

All cluster and database assessment was read-only. I did not mutate Kubernetes resources, database records, broker
state, trading flags, AgentRun objects, or live services.

### Cluster And Rollout

- `kubectl get pods -n torghut` showed Torghut revision `torghut-00338-deployment-8ddcb9bdf-wwsl5` ready `2/2`,
  Torghut sim revision `torghut-sim-00436-deployment-658dfc6c4-dv5cw` ready `2/2`, ClickHouse, Keeper, Postgres, TA,
  TA sim, WebSocket, options catalog, options enricher, and guardrail exporters running.
- `torghut-db-migrations` completed during the evidence window after pulling image digest
  `sha256:d8a0f28d22bccf28ced6032a6465e32ab715a830e4eb07425ede3d9f7d068036`.
- Options catalog and options enricher rolled to the same digest and became ready.
- `torghut-whitepaper-autoresearch-profit-target-m68ds` was in `Error`; this is not a live capital gate, but it is
  evidence that whitepaper profit-target automation still has a reliability gap.
- `kubectl get deploy -n agents` showed `agents` available `1/1` and `agents-controllers` available `1/2`.
- Jangar `/ready` returned HTTP 200 and `status=ok`, while `/api/agents/control-plane/status` reported
  `execution_trust=degraded` because the `jangar-control-plane:verify` stage was stale and the supporting controller
  was degraded.

### Source And Configuration

- Repository `HEAD` and `origin/main` were both `fdc164d70`, with recent source commits including
  `fix(jangar): stamp stage credit launch evidence`, `fix(torghut): require repair dispatch tickets`, and
  `chore(torghut): promote image 88d9f39d`.
- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts` resolves
  `torghut.consumer-evidence-status.v1`, `torghut.route-proven-profit-receipt.v1`,
  `torghut.route-warrant-exchange.v1`, and `torghut.repair-bid-settlement-ledger.v1`.
- `services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts` explicitly sets
  `JANGAR_TORGHUT_STATUS_URL` to `http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` in the success
  paths.
- `argocd/applications/agents/values.yaml` still configured
  `JANGAR_TORGHUT_STATUS_URL=http://torghut.torghut.svc.cluster.local/trading/autonomy`.
- `services/torghut/app/main.py` exposes `/trading/consumer-evidence` and returns
  `schema_version=torghut.consumer-evidence-status.v1` with `torghut_consumer_evidence_receipt`,
  `route_proven_profit_receipt`, `repair_bid_settlement_ledger`, and `route_warrant_exchange`.

### Runtime Evidence And Data

- `/trading/consumer-evidence` returned HTTP 200 and typed Torghut evidence.
- Jangar status still classified Torghut evidence as `status=missing`, endpoint
  `http://torghut.torghut.svc.cluster.local/trading/autonomy`, and reason
  `torghut_consumer_evidence_missing`.
- Torghut runtime build reports version `v0.569.1-143-g88d9f39d0`, commit
  `88d9f39d06f7cfde06a980ab133afef50bd20e19`, active revision `torghut-00338`, and `image_digest=null`.
- Runtime profitability over `72h` reported `29` decisions, `0` executions, `500` TCA samples, and every decision
  blocked.
- Live submission remains blocked by `simple_submit_disabled` and `hypothesis_not_promotion_eligible`; active
  capital stage is `shadow`.
- Route warrants reported `warrant_state=repair_only`, `max_notional=0`, `routeable_candidate_count=0`,
  `zero_notional_or_stale_evidence_rate=0.8`, and `capital_gate_safety=zero_notional_safe`.
- Repair-bid settlement reported `routeable_candidate_count=0`, `capital_decision=repair_only`, `max_notional=0`, and
  selected dispatchable zero-notional lots while holding over-selected lots.
- Active-session TCA remains a blocker: latest execution created at `2026-04-02T19:00:29.586040+00:00`, average
  absolute slippage `13.8203637593029676` bps, expected shortfall sample count `0`, and stale execution samples.
- `/db-check` returned schema current, expected and current head `0031_autoresearch_candidate_spec_epoch_uniqueness`,
  lineage ready, account-scope ready, and only migration parent-fork warnings.

## Problem

Jangar's admission logic and deployment configuration disagree about the Torghut evidence boundary.

The concrete failure modes are:

1. Jangar probes `/trading/autonomy`, which is not the typed consumer-evidence route.
2. The resolver classifies the payload as missing because it does not include `torghut_consumer_evidence_receipt`.
3. Repair-bid admission falls back to missing evidence even though Torghut has a current repair-bid settlement ledger.
4. Route-warrant dispatch custody cannot consume precise repair packet blockers.
5. Source-serving verdicts and proof-floor decisions see a generic Torghut hold instead of the route's typed reason
   codes.
6. Paper/live safety remains intact, but zero-notional repair dispatch loses the value of current evidence and keeps
   stale-evidence rate higher than necessary.

This is a control-plane evidence intake problem. It is not a reason to enable paper or live trading.

## Alternatives Considered

### Option A: Keep `/trading/autonomy` As The Jangar Endpoint

Leave the deployed config alone and teach Jangar to tolerate missing consumer evidence while other Torghut routes are
queried manually.

Advantages:

- No GitOps config change.
- Avoids changing the live control-plane intake path.
- Keeps the current conservative missing-evidence posture.

Disadvantages:

- Contradicts Jangar's resolver and tests.
- Prevents repair-bid admission from reading the typed settlement ledger.
- Keeps zero-notional repair dispatch blind to route warrants and value gates.
- Does not improve the business metric because missing evidence cannot select the smallest blocker.

Decision: reject.

### Option B: Have Jangar Probe Multiple Torghut Routes And Merge Them

Let Jangar call `/trading/autonomy`, `/trading/status`, `/trading/consumer-evidence`, `/readyz`, and maybe
`/trading/health`, then merge whichever fields are present.

Advantages:

- Can tolerate route-specific failures.
- Provides a wider operational picture.
- Useful for human diagnostics.

Disadvantages:

- Reintroduces source ambiguity exactly where a single admission contract is needed.
- Makes schema mismatch harder to detect.
- Increases Jangar status latency and failure surface.
- Risks using `/trading/status` fields that are not intended as consumer-evidence authority.

Decision: keep multi-route diagnostics for humans, not the admission boundary.

### Option C: Bind Jangar Admission To The Typed Torghut Consumer-Evidence Route

Configure Jangar to read `/trading/consumer-evidence` as the sole Torghut quant admission surface, then require that
route to carry route warrants, repair-bid settlement, source-serving proof, profit freshness, and capital holds.

Advantages:

- Matches the Jangar resolver and tests already present in source.
- Converts missing evidence into exact repair lots and value-gate blockers.
- Keeps paper/live capital blocked through typed `max_notional=0` and route-warrant states.
- Reduces control-plane false negatives without weakening capital safety.
- Gives deployer verification one route to capture after every rollout.

Disadvantages:

- Jangar will surface more Torghut-specific blockers after the config lands.
- The typed route must stay compact and schema-versioned.
- A route outage will be more visible because it is now the admission boundary.

Decision: select Option C.

## Architecture

Jangar treats Torghut consumer evidence as a typed admission packet:

```text
jangar_torghut_evidence_admission
  schema_version = jangar.torghut-evidence-admission.v1
  generated_at
  endpoint = /trading/consumer-evidence
  torghut_schema_version = torghut.consumer-evidence-status.v1
  receipt_id
  fresh_until
  build_commit
  serving_revision
  serving_image_digest
  route_warrant_id
  route_warrant_state
  route_warrant_repair_packet_ids[]
  repair_bid_settlement_ledger_id
  repair_bid_settlement_status
  dispatchable_lot_ids[]
  held_lot_ids[]
  evidence_clock_arbiter_id
  source_serving_repair_receipt_ledger_id
  routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  fill_tca_or_slippage_quality
  capital_gate_safety
  max_notional
  action_class_decisions[]
```

Action-class rules:

- `serve_readonly` can allow when the route is current or stale but reachable.
- `torghut_observe` can allow when the route is current and `max_notional=0`.
- `dispatch_repair` can allow only dispatchable repair-bid lots whose required output receipt matches the current
  value gate and whose `max_notional=0`.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` hold while source-serving proof, execution trust, or rollout
  truth is degraded.
- `paper_canary` holds until route warrants, repair-bid settlement, source-serving proof, TCA, empirical replay,
  quant health, and paper settlement are all current.
- `live_micro_canary` and `live_scale` block while any typed capital gate remains `repair_only`, `hold`, or
  `max_notional=0`.

The immediate implementation changes the GitOps endpoint:

```text
JANGAR_TORGHUT_STATUS_URL=http://torghut.torghut.svc.cluster.local/trading/consumer-evidence
```

No live Kubernetes resources are patched by hand. Argo should carry the configuration through normal sync.

## Implementation Scope

This architecture PR includes:

- Change `argocd/applications/agents/values.yaml` so Jangar points at `/trading/consumer-evidence`.
- Document the typed evidence admission contract in Jangar and Torghut docs.
- Update documentation indexes so engineer and deployer stages can cite the governing contract.

Engineer follow-up:

- Keep `resolveTorghutConsumerEvidence` as the only reducer for admission decisions.
- Add a regression test or config assertion that the production value for `JANGAR_TORGHUT_STATUS_URL` targets
  `/trading/consumer-evidence`, not `/trading/autonomy`.
- Add source-serving repair receipt fields when Torghut implements the ledger from design `191`.
- Keep schema mismatches as hard typed holds for repair-bid admission.

Deployer follow-up:

- After Argo sync, capture `/api/agents/control-plane/status` and prove `torghut_consumer_evidence.status` is
  `current` or `stale` rather than `missing`.
- Capture Torghut `/trading/consumer-evidence` and prove route warrants and repair-bid settlement remain
  `repair_only`, `routeable_candidate_count=0`, and `max_notional=0`.
- Keep paper/live disabled until the typed Torghut packet explicitly says otherwise.

## Validation Gates

Local validation for this PR:

- `bunx oxfmt --check argocd/applications/agents/values.yaml services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts docs/agents/designs/188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md docs/torghut/design-system/v6/192-torghut-typed-consumer-evidence-route-and-capital-safe-repair-dispatch-2026-05-13.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `bun test services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts`
- `git diff --check`

CI/deployer validation:

- Jangar control-plane status no longer reports endpoint `/trading/autonomy` for Torghut evidence.
- `torghut_consumer_evidence.reason_codes` are route-warrant or repair-bid reason codes, not
  `torghut_consumer_evidence_missing`.
- Repair-bid admission can see current or stale typed settlement status and exact dispatchable lot IDs.
- `max_notional=0`, `live_submission_allowed=false`, and live capital stays blocked.

## Rollout

Phase 1 changes the Jangar GitOps value. Argo rolls the control-plane deployment normally.

Phase 2 verifies Jangar reads typed Torghut evidence and preserves current holds. The expected result is better
classification, not a readiness greenwash: stale TCA, missing quant health, source-serving proof, routeability, and
simple submission remain blockers.

Phase 3 allows dispatch repair admission to use typed dispatchable repair-bid lots. Dispatch remains zero-notional.

Phase 4 requires this typed route for paper canary decisions. If the route is missing, schema-mismatched, or stale,
paper canary holds.

Phase 5 requires this typed route for live micro-canary and live scale. This should remain blocked until route
warrants and capital gates converge.

## Rollback

If `/trading/consumer-evidence` is unavailable after rollout, roll back the Jangar value to the previous endpoint only
as a read-only visibility fallback. Do not use the legacy endpoint for paper/live or repair-bid admission.

If the typed route is reachable but noisy, keep repair-bid admission in observe mode and continue publishing
schema-mismatch or stale evidence. Do not suppress the typed reason codes.

If the route exposes unexpected capital permission, Jangar must prefer the stricter of route warrant, repair-bid
settlement, source-serving proof, and live submission gate. A single permissive field cannot widen capital.

If deployer verification cannot prove the new endpoint is active, hold `dispatch_repair`, `paper_canary`,
`live_micro_canary`, and `live_scale` until the control-plane environment is source-serving current.

## Risks

- A single typed route can become too large. Mitigation: keep large data behind refs and expose compact summaries.
- Jangar may start dispatching more zero-notional repair after evidence becomes visible. Mitigation: repair-bid
  admission must keep `max_notional=0`, TTLs, dedupe keys, and parallelism limits.
- The old endpoint may have fields operators still inspect. Mitigation: keep `/trading/autonomy` for diagnostics, not
  admission.
- Source-serving drift can still exist after the endpoint fix. Mitigation: keep designs `187` and `191` as separate
  proof gates and do not count routeable candidates until source-serving proof converges.

## Handoff

Engineer acceptance gate: production Jangar reads Torghut from `/trading/consumer-evidence`, maps route warrants and
repair-bid settlement into admission state, and preserves `max_notional=0` when routeability, TCA, quant health, or
source-serving proof is stale.

Deployer acceptance gate: after Argo sync, `/api/agents/control-plane/status` cites the typed Torghut endpoint and
contains route-warrant or repair-bid reason codes; Torghut `/trading/consumer-evidence` still shows
`capital_decision=repair_only`, `routeable_candidate_count=0`, and live submission blocked.

The revenue metric improved is `zero_notional_or_stale_evidence_rate`: this change removes a false missing-evidence
classification so Jangar can route exact stale evidence repairs. The smallest blocker preventing revenue impact remains
active-session data and execution quality: no executions in the `72h` window, stale live execution samples from
`2026-04-02`, expected-shortfall coverage `0`, and no routeable candidates.
