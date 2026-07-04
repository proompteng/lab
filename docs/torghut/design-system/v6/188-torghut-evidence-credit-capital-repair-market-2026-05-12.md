# 188. Torghut Evidence-Credit Capital Repair Market (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut profitability, proof-lease repair ranking, Jangar stage evidence credit consumption, zero-notional
capital safety, validation, rollout, rollback, and handoff gates.

Companion Jangar contract:

- `docs/agents/designs/184-jangar-stage-evidence-credit-authority-and-freeze-reclock-2026-05-12.md`

Extends:

- `187-torghut-profit-window-custody-and-repair-value-market-2026-05-08.md`
- `186-torghut-proof-lease-repair-market-and-capital-hold-2026-05-08.md`
- `184-torghut-profit-signal-quorum-and-context-routability-handoff-2026-05-08.md`
- `docs/agents/designs/183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`

## Decision

I am selecting an **evidence-credit capital repair market** for the next Torghut architecture step.

Torghut is safe enough to diagnose and not safe enough to trade. At `2026-05-12T16:21Z`, live `/healthz` returned
`status=ok`, while live `/readyz` returned `status=degraded`. The database schema was current at Alembic head
`0031_autoresearch_candidate_spec_epoch_uniqueness`, Postgres and ClickHouse checks were OK, the scheduler was running,
and latest quant metrics were fresh. The proof and capital gates correctly held: live submission was disabled,
`capital_stage=shadow`, profitability proof floor was `repair_only`, `capital_state=zero_notional`, alpha readiness had
three hypotheses with zero promotion-eligible hypotheses, and live submission blockers included
`hypothesis_not_promotion_eligible`, `empirical_jobs_not_ready`, and `simple_submit_disabled`.

The profitable repair question is now more precise. Torghut should not ask Jangar to run "more research" or "repair
proof" generically. It should price the next zero-notional repair by the evidence credit it can spend and the capital
gate it could unlock. On May 12, the largest current gaps were clear: quant latest metrics were current, but ingestion
stage lag reached `956,708` seconds; execution TCA evidence had `13,775` rows and `12` symbols but newest computation
was still May 8; promotion tables were thin with `research_candidates=0`, `research_promotions=0`,
`strategy_promotion_decisions=1`, and `vnext_promotion_decisions=0`; proof leases for `H-CONT-01`, `H-MICRO-01`, and
`H-REV-01` were all `repair_only` with `proof_state=missing`.

The selected design turns Torghut proof gaps into repair bids that must cite a current Jangar stage evidence credit.
The bid can buy agent work. It cannot buy notional. Paper and live capital stay held until Torghut proof floor,
route/TCA evidence, promotion evidence, market context, and Jangar credit authority all converge.

The tradeoff is less opportunistic autonomy. Torghut will sometimes leave a plausible signal untouched because the
Jangar control plane cannot prove launch credit or because the repair bid is not tied to a routeable capital gate. That
is the right trade. Profitability improves when repair capacity targets the missing proof most likely to restore a
routeable, post-cost hypothesis without violating zero-notional safety.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, GitOps
resources, or AgentRun objects.

### Cluster And Runtime Evidence

- Argo CD reported `torghut` as `Synced/Degraded` at revision
  `32564cef018d608a7928c80240a70d35f75c5b25`.
- Argo CD reported `torghut-options` as `Synced/Progressing` at revision
  `d875cca7addce4a02afd5bb005b26636960f8c35`.
- Torghut live revision `torghut-00320` and sim revision `torghut-sim-00418` were running.
- `torghut-options-ta`, `torghut-ta-sim`, `torghut-ws`, and `torghut-ws-options` were in `ImagePullBackOff`.
- Recent Torghut events included registry DNS/image pull failures, startup/readiness probe failures, and later normal
  completion for migration and bootstrap jobs.
- Torghut `/healthz` returned `{"status":"ok","service":"torghut"}`.
- Torghut `/readyz` returned `status=degraded`, scheduler `ok=true`, Postgres `ok=true`, ClickHouse `ok=true`, and
  database schema `ok=true`.

### Readiness, Data, And Capital Evidence

- Current and expected schema heads were both `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Schema graph lineage was ready with known historical parent-fork warnings.
- Live submission gate was not OK with detail `simple_submit_disabled` and `capital_stage=shadow`.
- Profitability proof floor was not OK with detail `repair_only`, `capital_state=zero_notional`, and `required=true`.
- Alpha readiness had `3` hypotheses, states `blocked=1` and `shadow=2`, promotion eligible `0`, and rollback required
  `2`.
- Quant evidence was informationally degraded: latest metrics count was `180`, newest metrics were current at
  `2026-05-12T16:21:12Z`, and max stage lag was `956,708` seconds.
- The sampled quant stages showed compute current, ingestion false for all three sampled strategies, and
  materialization false for two of three sampled strategies.
- Market context was mixed: readiness reported last freshness near `44` seconds, news OK, but technicals,
  fundamentals, and regime stale in the proof-floor source ref.
- Execution TCA route evidence was stale relative to live session proof: newest computed timestamp was
  `2026-05-08T02:42:07Z`; route universe had one probing/candidate symbol, four blocked symbols, and three missing
  symbols.

### Database Evidence

- Direct database pod exec was forbidden for `agents-sa`; raw database inspection used CNPG app credentials and
  `BEGIN READ ONLY`.
- Torghut Postgres identity was `database=torghut`, `user=torghut_app`, observed at `2026-05-12T16:27:10Z`.
- `public.alembic_version` had one row: `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `public.trade_decisions` had `147,666` rows, newest `created_at=2026-05-08T17:29:45Z`.
- `public.execution_tca_metrics` had `13,775` rows across `12` symbols, newest
  `computed_at=2026-05-08T02:42:07Z`.
- `public.research_candidates` had `0` rows.
- `public.research_promotions` had `0` rows.
- `public.strategy_promotion_decisions` had `1` row, newest `created_at=2026-05-06T22:34:19Z`.
- `public.vnext_promotion_decisions` had `0` rows.

### Source Evidence

- `services/torghut/app/main.py` is `5,298` lines and already hosts readiness, status, consumer evidence, proof-floor,
  and trading route projection logic. The new market should not add another large reducer there.
- `services/torghut/app/trading/profit_leases.py` is `791` lines and already builds the proof-lease projection and
  source provenance. It is the right source module for repair bids.
- `services/torghut/app/trading/consumer_evidence.py` is `406` lines and already produces Jangar-consumable evidence
  receipts.
- `services/torghut/app/trading/proof_floor.py` already owns the profitability proof-floor receipt and capital hold
  semantics.
- Existing tests cover proof floor, consumer evidence, profit leases, capital reentry cohorts, profit repair
  settlement, Jangar continuity, and trading API payloads. The missing test surface is repair-bid scoring against a
  Jangar evidence-credit budget and the invariant that repair bids never increase notional.

## Problem

Torghut has accurate capital holds but weak repair pricing.

The live system can say "not ready" with many reasons. It does not yet choose the highest-value zero-notional repair
under a Jangar launch budget. That produces five concrete risks:

1. Agent work can chase stale or low-value proof gaps because all blockers look similar.
2. Current quant metrics can hide stale ingestion and materialization debt.
3. Route/TCA evidence can be stale while market context and schema evidence are current.
4. Empty promotion tables can keep every hypothesis in shadow without a ranked path to generate promotion evidence.
5. A Jangar stage freeze can cause repeated repair launch attempts unless Torghut spends explicit evidence credit.

Torghut needs a market object that prices repairs by expected capital unlock, proof freshness, cost, and available
Jangar evidence credit.

## Alternatives Considered

### Option A: Keep Proof Lease Projection As The Repair Plan

Use `profit_lease_projection` and its blocker list as the only repair guidance.

Advantages:

- No new runtime contract.
- Already present in readiness payloads.
- Ties blockers to hypotheses.

Disadvantages:

- Does not rank repairs by expected capital value.
- Does not consume Jangar launch credit or stage debt.
- Does not prevent repeated repair attempts against the same stale source.
- Does not expose a market-level stop condition.

Decision: reject. A blocker list is not a capital-aware repair market.

### Option B: Fixed Repair Order

Always repair quant ingestion first, then route/TCA, then promotion evidence, then market context, then proof floor.

Advantages:

- Easy to implement.
- Current evidence would benefit from quant ingestion repair.
- Simple to explain during incidents.

Disadvantages:

- Ignores whether the repair can spend a current Jangar credit.
- Ignores routeable capital value and hypothesis scope.
- Can waste work when route/TCA or promotion evidence is the true paper-canary blocker.
- Does not adapt across sessions.

Decision: keep as emergency fallback only.

### Option C: Evidence-Credit Capital Repair Market

Emit a `evidence_credit_capital_repair_market` beside the proof floor and profit leases. Each bid names the proof gap,
hypothesis, lane, expected unlock, Jangar evidence credit ref, max notional, stop condition, and rollback target.

Advantages:

- Converts many blockers into a ranked zero-notional repair queue.
- Makes Jangar launch credit an explicit scarce input.
- Keeps capital held while still allowing bounded proof repair.
- Gives engineer and deployer stages a measurable hypothesis for each repair.
- Reduces manual intervention because the next repair action is deterministic.

Disadvantages:

- Adds scoring complexity.
- Requires careful tests so a repair bid never becomes capital permission.
- Needs observed-versus-fixed-order comparison before enforcement.

Decision: select Option C.

## Architecture

Torghut adds this projection:

```text
evidence_credit_capital_repair_market
  schema_version
  market_id
  generated_at
  fresh_until
  account
  window
  capital_hold_state
  jangar_stage_evidence_credit_authority_ref
  bids[]
  capital_action_decision       # hold | block | repair_only | paper_candidate
  max_notional
  fixed_order_fallback
  rollback_target
```

Each bid is scoped:

```text
capital_repair_bid
  bid_id
  proof_lease_id
  hypothesis_id
  lane_id
  repair_class                  # quant_ingestion | route_tca | promotion | market_context | empirical | proof_floor
  stale_or_missing_source
  expected_capital_unlock
  expected_value_gate
  expected_cost_class
  jangar_credit_ref
  credit_spend_state            # available | partial | missing | denied
  decision                      # observe | repair | hold | block
  max_notional
  stop_conditions[]
  acceptance_evidence[]
  rollback_target
```

Bid ranking starts with deterministic weights:

- `quant_ingestion`: high value when latest metrics are current but ingestion lag exceeds the service threshold.
- `route_tca`: high value when TCA has old evidence, missing symbols, or slippage-blocked symbols for the active
  universe.
- `promotion`: high value when proof leases are missing and promotion tables are empty or stale.
- `market_context`: high value when a required domain is stale for a hypothesis lane.
- `empirical`: high value when empirical job receipts are stale or ineligible for the active lease.
- `proof_floor`: high value when a single proof-floor blocker can move paper canary without changing live notional.

Hard rules:

- Every bid has `max_notional=0` unless the full proof floor and capital gate already permit paper or live, which this
  design does not enable.
- A bid with missing Jangar credit cannot launch new work; it can remain visible as `hold`.
- A bid with partial Jangar repair credit can launch at most one bounded repair AgentRun.
- A bid cannot mark `paper_candidate` while any required proof lease is `repair_only` or `proof_state=missing`.
- A bid cannot mark `live_micro_canary` or `live_scale`; those remain separate capital gates.

## Measurable Hypotheses

Hypothesis 1: Credit-priced repair reduces stale-evidence loops.

- Measure: lower `zero_notional_or_stale_evidence_rate` for leases that receive a repair bid.
- Gate: each completed repair either refreshes the source or retires the source from the lease with a reason.
- Expected value: less repeated work against proof that cannot unlock routeability.

Hypothesis 2: Credit-priced ranking improves routeability faster than fixed-order repair.

- Measure: higher `routeable_candidate_count` or lower blockers per active lease within two market sessions.
- Gate: shadow comparison logs selected bid versus fixed-order bid.
- Expected value: better repair ROI under the same Jangar launch capacity.

Hypothesis 3: Capital hold remains intact while repair pressure rises.

- Measure: `paper_canary`, `live_micro_canary`, and `live_scale` remain held or blocked while any market bid has
  `decision=repair`.
- Gate: tests inject current Jangar repair credit and assert `max_notional=0`.
- Expected value: repair throughput without accidental live exposure.

## Implementation Scope

M1 adds a pure builder in `services/torghut/app/trading/evidence_credit_repair_market.py`. It consumes the proof-floor
receipt, profit lease projection, quant evidence, route/TCA summary, promotion table counts, market-context states,
and a Jangar credit receipt. It returns the market object and no side effects.

M2 exposes the market in `/readyz`, `/trading/status`, and `/trading/consumer-evidence` while keeping capital hold
unchanged.

M3 teaches Jangar Torghut consumer evidence parsing to recognize top repair bids as bounded repair actions, not capital
permission.

M4 runs a shadow comparison between credit-priced ranking and fixed-order repair for one full market session.

M5 enforces one repair bid per credit window. If the bid completes, the next status payload must either show improved
freshness/routeability or retire the bid with evidence.

## Validation Gates

Required tests:

- Unit tests for bid ranking with current quant metrics but stale ingestion.
- Unit tests for stale TCA, empty promotion tables, mixed market context, and missing Jangar credit.
- Unit tests proving all repair bids have `max_notional=0`.
- API tests proving `/readyz` and `/trading/status` include the market without changing existing degraded readiness.
- Jangar consumer evidence tests proving bids become bounded repair action classes only.

Required runtime checks after merge:

- `curl -sS http://torghut.torghut.svc.cluster.local/readyz | jq '.evidence_credit_capital_repair_market'`
- `curl -sS http://torghut.torghut.svc.cluster.local/trading/status | jq '.evidence_credit_capital_repair_market'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m'`
- `kubectl get applications.argoproj.io -n argocd torghut torghut-options -o wide`
- `gh pr checks <pr> --watch -R proompteng/lab`

Value-gate mapping:

| Milestone | Scope                                                                    | Value gates                                                         |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| T0        | Merge this design and companion Jangar credit authority.                 | `handoff_evidence_quality`                                          |
| T1        | Pure evidence-credit repair market builder with fixtures.                | `zero_notional_or_stale_evidence_rate`, `capital_gate_safety`       |
| T2        | Expose the market in readiness and status without changing capital hold. | `capital_gate_safety`, `handoff_evidence_quality`                   |
| T3        | Let Jangar consume top bids as bounded repair actions.                   | `manual_intervention_count`, `failed_agentrun_rate`                 |
| T4        | Shadow compare credit-priced ranking against fixed-order repair.         | `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate` |
| T5        | Enforce one repair bid per current Jangar credit window.                 | `manual_intervention_count`, `capital_gate_safety`                  |

## Rollout

Roll out in shadow first. The first production signal is not capital movement. It is a current market receipt whose top
bid names a Jangar credit ref, a proof gap, a stop condition, and `max_notional=0`.

After one full market session, compare top bid selection against fixed-order repair. Only enforce bid selection if the
shadow market would not have selected a lower-safety action than fixed order and if Jangar credit authority is current.

The first enforcement target should be one bounded quant-ingestion or route/TCA repair bid. Do not enforce promotion or
proof-floor repair until the builder has fixtures for empty promotion tables and stale TCA evidence.

## Rollback

Rollback is straightforward:

- Stop exposing the market to Jangar consumers.
- Keep `/readyz` and `/trading/status` proof floor and profit lease projection unchanged.
- Fall back to fixed repair order for operator guidance.
- Preserve `max_notional=0` and existing live submission disablement.
- Do not delete market receipts; retain them for comparison and audit.

The fallback is conservative. Torghut remains degraded and zero-notional, but capital safety is preserved.

## Risks

- Bid scoring can overvalue current quant metrics and undervalue stale ingestion.
- Route/TCA evidence can look stale because live trading has correctly stopped; the builder must distinguish safe
  absence from missing proof.
- Jangar credit refs can be stale or missing while Torghut status is current; missing credit must hold the bid.
- A repair market can be misread as capital readiness unless every bid carries zero-notional invariants.
- Promotion table emptiness can create repeated research jobs unless each bid has a stop condition and retirement rule.

## Engineer Handoff

Start with the pure builder and fixtures only. Own `services/torghut/app/trading/evidence_credit_repair_market.py` and
`services/torghut/tests/test_evidence_credit_repair_market.py`.

Acceptance gates:

- Current quant metrics plus stale ingestion ranks a `quant_ingestion` repair bid when Jangar credit is available.
- Empty promotion tables create promotion repair bids, but they cannot outrank a blocker that is required for all
  active leases unless their expected unlock is higher.
- Missing Jangar credit produces `decision=hold`.
- Every repair bid has `max_notional=0`.

## Deployer Handoff

Treat the market as advisory until the Jangar companion authority is shadowing cleanly.

Acceptance gates:

- Torghut `/readyz` remains degraded while proof floor is `repair_only`.
- No paper or live capital gate changes from exposing the market.
- Argo `torghut` and `torghut-options` state is recorded before and after rollout.
- A completed repair bid must show either improved freshness/routeability or a retired bid reason in the next status
  payload.
