# 175. Torghut Failure-Costed Context Repair And Route Custody (2026-05-08)

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

I am selecting **failure-costed context repair with route custody** for Torghut.

The live Torghut service was reachable on 2026-05-08 at 00:23Z. `/healthz` returned ok, Postgres and ClickHouse were
healthy, the active Torghut revision was serving, and the universe contained the expected scoped symbols from Jangar
cache. That is enough to observe and repair.

It is not enough to promote capital. `/readyz` and `/trading/health` were degraded. The profitability proof floor was
`repair_only`, capital state was `zero_notional`, live submission was disabled, alpha readiness had 3 hypotheses with
0 promotion eligible and 2 rollback required, route TCA had only 1 probing symbol with 4 blocked and 3 missing, and
Jangar broker/custody refs were absent from the route repair board. At the same time, fresh market-context provider
jobs for symbols including `INTC`, `AMZN`, and `ORCL` ended in `BackoffLimitExceeded`.

The decision is to make context repair cost-aware and Jangar-custodied. Torghut will emit a
`context_repair_packet` that prices failed provider jobs, stale snapshots, provider circuit state, retry cost, expected
unblock value, route dependency, and Jangar terminal debt refs. A route repair packet cannot become a paper candidate
because context was retried; it can become a paper candidate only when the retry is bounded, the resulting receipts
are fresh enough for the hypothesis dependency, the Jangar terminal debt is settled or under custody, and the proof
floor allows the action.

The tradeoff is slower movement from observe to paper. I accept that. Profitability improves when repair spend goes to
the constraints most likely to unlock executable hypotheses. Retrying context providers without pricing failure cost
is activity, not edge.

## Success Metrics

Success means:

- Torghut emits `failure_costed_context_repair` in shadow mode beside the route reacquisition board.
- Every context repair packet contains `symbol`, `domain`, `last_snapshot_state`, `last_run_status`,
  `failure_category`, `provider_circuit_state`, `expected_unblock_value`, `expected_retry_cost`,
  `data_freshness_effect`, `route_packet_refs`, `jangar_terminal_debt_ref`, `retry_budget`, `paper_probe_notional_limit`,
  and `rollback_target`.
- Market-closed stale context can remain informational, but Kubernetes `BackoffLimitExceeded` and structured provider
  failures cannot remain informational when the symbol/domain is a route or alpha dependency.
- The route repair board ranks symbols by expected unblock value net of retry cost and proof dependency, not by a flat
  missing/blocked label.
- Paper and live notional remain zero while Jangar terminal debt refs are missing, proof floor is `repair_only`, alpha
  has no promotion-eligible hypotheses, or simple submit is disabled.
- A bounded observe-only repair can proceed when it cites a Jangar retry custody lease and does not change paper/live
  capital authority.

## Evidence Snapshot

All evidence in this pass was collected read-only.

### Cluster And Runtime Evidence

- Torghut namespace had active live and sim revisions available, plus Postgres, ClickHouse, TA, options, websocket,
  and supporting services.
- `torghut-00291-deployment` and `torghut-sim-00390-deployment` were available on the sampled image digest.
- Recent Torghut events showed the database migration job completed and the live/sim revisions rolled forward. Events
  also recorded startup/readiness probe failures during rollout handoff, repeated `MultiplePodDisruptionBudgets`
  warnings for ClickHouse pods, and a Flink status warning on `torghut-options-ta`.
- `/healthz` returned ok.
- `/readyz` returned degraded.
- `/trading/health` returned degraded.
- The service account could not list Knative Service or Revision resources and could not exec into CNPG pods. Runtime
  evidence therefore came from Kubernetes workload summaries and application health endpoints.

### Data, Profit, And Context Evidence

- `/db-check` reported `ok=true`, current Alembic head `0029_whitepaper_embedding_dimension_4096`, and schema signature
  agreement between expected and current heads.
- Schema lineage warnings remained for known parent forks after
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/readyz` reported proof floor `repair_only`, route state `repair_only`, capital state `zero_notional`, and
  `max_notional=0`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `simple_submit_disabled`.
- Alpha readiness had 3 total hypotheses, 0 promotion-eligible hypotheses, and 2 rollback-required hypotheses.
- Execution TCA included 7,334 orders and 7,245 filled executions, but aggregate absolute slippage exceeded the 8 bps
  guardrail.
- The route reacquisition board covered 8 scoped symbols: `AAPL` probing, `AMD`, `AVGO`, `INTC`, and `NVDA` blocked,
  and `AMZN`, `GOOGL`, and `ORCL` missing.
- Route board output had `jangar_broker_ref=null` and all max notional values were zero.
- Market context reported expected closed-market staleness, but fresh Kubernetes jobs for provider domains reached
  `BackoffLimitExceeded`. That is retry debt, not a capital receipt.
- Quant evidence had recent rows and a short metrics lag, but pipeline stages were missing and remained informational.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` is 718 lines and already composes proof dimensions, repair ladder
  priority, capital state, and blockers.
- `services/torghut/app/trading/route_reacquisition_board.py` is 286 lines and already emits route repair board rows,
  required receipts, zero-notional capital state, and optional Jangar refs.
- `services/torghut/app/trading/route_reacquisition.py` is 374 lines and owns the route state classification behind
  the board.
- `services/torghut/app/trading/submission_council.py` is 1,202 lines and already blocks live submission on proof,
  configuration, and promotion conditions.
- `services/jangar/src/agents/torghut-market-context-agents.ts` already classifies provider failures and circuit state.
  The missing contract is Torghut consumption of Jangar terminal debt refs as a priced repair input.
- Existing tests cover proof floor, route reacquisition, route board receipts, submission council, market context,
  hypotheses, quant readiness, and trading health. The missing test surface is failure cost propagation from
  provider/Kubernetes failure to route custody and capital gates.

## Problem

Torghut currently separates market-context health, route reacquisition, proof floor, and submission gates. That
separation is useful, but it lets context failure cost fall between components.

When provider jobs fail, the system can see the failure in Kubernetes and in Jangar provider orchestration. The route
board can still rank symbols by route state and expected unblock value. The proof floor can still say repair-only and
zero-notional. What is missing is the price of retrying context for a specific symbol/domain and the custody rule that
connects that retry to Jangar material action authority.

That matters for profitability. A missing `AMZN` route with a cheap context repair is different from a blocked `NVDA`
route with a provider circuit open and no alpha readiness. Both may be zero-notional today, but they should not consume
the same repair budget or carry the same paper eligibility.

## Alternatives Considered

### Option A: Re-Run Context Jobs Until Green

Let market-context schedules continue retrying and wait for provider snapshots to refresh.

Advantages:

- Operationally simple.
- Makes no schema or proof-floor changes.
- Can recover transient provider issues without architecture work.

Disadvantages:

- Repeats failure without pricing attempt cost.
- Does not distinguish closed-market stale snapshots from provider failure.
- Does not give route repair or capital gates a Jangar debt ref.

Decision: reject as the operating model. Blind retry is not a profitability strategy.

### Option B: Treat Market-Closed Context Staleness As Informational

Keep context staleness informational during market-closed windows and rely on route TCA, alpha readiness, and simple
submit settings for capital gates.

Advantages:

- Avoids false alarms during closed sessions.
- Matches part of the current proof-floor behavior.
- Keeps capital blocked through other dimensions while live submit is disabled.

Disadvantages:

- Lumps expected staleness together with failed provider jobs.
- Does not price context as a repair dependency for missing or blocked route symbols.
- Makes it hard to explain why a symbol is next in the repair queue.

Decision: keep the market-closed staleness rule, but promote provider failure into failure-costed repair.

### Option C: Failure-Costed Context Repair And Route Custody

Emit context repair packets, price expected retry cost against expected route/profit unblock value, and require Jangar
terminal debt custody before context repair can influence paper or live admission.

Advantages:

- Connects provider reliability to route profitability.
- Preserves zero-notional safety while allowing useful observe-only repair.
- Gives deployers a single packet tying context failure, route state, proof floor, and Jangar custody.
- Lets Torghut spend repair work on the highest-value constrained symbols first.

Disadvantages:

- Requires new packet output and tests.
- Adds another blocking reason while Jangar terminal debt exchange is rolling out.
- Requires careful handling so closed-market staleness does not overblock routine observation.

Decision: select Option C.

## Architecture

Torghut adds a `context_repair_packet` for each symbol/domain pair that is relevant to a route repair candidate or an
alpha dependency.

```text
context_repair_packet
  schema_version
  packet_id
  generated_at
  account_label
  symbol
  domain
  market_session_state
  last_snapshot_state
  last_snapshot_at
  last_run_status
  failure_category
  provider_circuit_state
  active_run_ref
  expected_unblock_value
  expected_retry_cost
  expected_net_repair_value
  data_freshness_effect
  route_packet_refs
  proof_floor_dimensions
  jangar_terminal_debt_ref
  retry_budget
  paper_probe_notional_limit
  max_notional
  rollback_target
```

The packet reducer applies these rules:

1. `BackoffLimitExceeded`, provider circuit open, attempt timeout, payload validation failure, and finalize callback
   failure produce failure-costed packets.
2. Expected closed-market staleness remains informational only when there is no failed provider job and the hypothesis
   dependency can tolerate the snapshot age.
3. `expected_net_repair_value = expected_unblock_value - expected_retry_cost`, capped at zero when proof-floor
   dependencies are missing.
4. Missing `jangar_terminal_debt_ref` forces `paper_probe_notional_limit=0` and `max_notional=0`.
5. A valid Jangar retry custody lease can allow observe-only repair and data refresh, but it cannot open live capital.
6. Proof floor `repair_only`, alpha readiness with 0 promotion-eligible hypotheses, route universe incompleteness, or
   disabled simple submit keeps all capital zero-notional.
7. Route board ranking must include context packet state when choosing the next repair candidate.

## Route Custody

Route repair packets consume context repair packets and Jangar debt refs:

```text
route_custody_packet
  route_packet_id
  symbol
  route_state
  expected_unblock_value
  context_packet_refs
  context_failure_cost
  proof_floor_state
  alpha_readiness_state
  jangar_terminal_debt_refs
  custody_decision
  custody_reason
  paper_probe_notional_limit
  live_notional_limit
  rollback_target
```

Custody decisions are:

- `observe_only`: repairs can collect evidence without paper/live notional.
- `context_retry_allowed`: a Jangar retry custody lease allows a bounded provider retry.
- `paper_candidate`: all required receipts are fresh, proof floor is not repair-only, and Jangar debt is settled.
- `live_blocked`: paper may be possible, but live capital remains blocked by live submission or proof-floor settings.
- `blocked`: missing or failed evidence prevents even bounded retry.

In the current sampled state, all active route custody packets remain `observe_only` or `blocked` with zero notional.
That is the correct decision.

## Implementation Scope

Engineer stage:

- Add `context_repair_packet` construction in the Torghut trading health/proof path or a nearby helper consumed by the
  route reacquisition board.
- Extend route board rows with `context_failure_cost`, `expected_net_repair_value`, `jangar_terminal_debt_refs`, and
  `custody_decision`.
- Add a readiness reason such as `context_repair_debt_unsettled` when failed provider jobs affect route or alpha
  dependencies.
- Consume Jangar terminal debt refs from the control-plane status/packet surface when available.
- Add tests for `BackoffLimitExceeded`, provider circuit open, expected market-closed staleness, missing Jangar debt
  ref, fresh Jangar retry custody, and proof-floor repair-only behavior.
- Keep all paper/live notional at zero while proof floor is repair-only or simple submit is disabled.

Deployer stage:

- Roll out context repair packets in shadow mode.
- Compare packet counts against the fresh market-context failed jobs and stale domains.
- Verify route board order changes only when expected net repair value is better than the current flat route ranking.
- Keep paper and live admission disabled until Jangar terminal debt refs are present and proof floor is no longer
  repair-only.
- Publish a rollback plan that disables packet consumption while preserving packet output for audit.

## Validation Gates

Engineer acceptance:

- Unit tests prove a failed provider job creates a failure-costed context packet with zero notional.
- Unit tests prove expected closed-market staleness alone does not create capital-blocking failure cost.
- Route board tests prove missing `jangar_terminal_debt_ref` blocks paper/live even when route state is probing.
- Proof-floor tests prove `repair_only` and `zero_notional` dominate any context repair success.
- Submission council tests prove `context_retry_allowed` is observe-only and cannot bypass simple-submit disabled.

Deployer acceptance:

- `/readyz` or trading health exposes context repair packet freshness and counts.
- Fresh `BackoffLimitExceeded` provider jobs for `INTC`, `AMZN`, `ORCL`, or their current successors map to context
  repair packets with provider failure category.
- The route board shows `jangar_terminal_debt_ref` or an explicit missing-ref blocker for each repair candidate.
- `AAPL` remains zero-notional unless proof floor, alpha readiness, simple submit, and Jangar custody all pass.
- Missing symbols `AMZN`, `GOOGL`, and `ORCL` are ranked by expected net repair value, not simply by missing status.

## Rollout Plan

1. Emit context repair packets in shadow mode with no route board ordering changes.
2. Add packet counts and top blockers to `/readyz` and `/trading/health`.
3. Join packets into the route reacquisition board while leaving existing order unchanged.
4. Enable failure-costed ordering for observe-only repair candidates.
5. Require Jangar terminal debt refs before a packet can become `paper_candidate`.
6. Keep live capital blocked until proof floor passes, simple submit is enabled, and alpha readiness has promotion
   eligible hypotheses.
7. Run one full market session in observe-only mode before enabling paper candidates.

## Rollback Plan

Rollback is data-preserving:

1. Disable context repair packet consumption in route ordering.
2. Keep packet emission on for audit unless packet generation itself is the failure.
3. Revert route board ordering to the previous route state and expected unblock value fields.
4. Keep proof-floor and submission council zero-notional gates unchanged.
5. Clear only shadow packet caches after exporting the last packet summary for deployer evidence.

## Risks And Mitigations

- Risk: context failure cost overblocks during market-closed periods. Mitigation: separate expected market-closed
  staleness from provider job failure and require hypothesis dependency before treating stale context as blocking.
- Risk: Jangar debt refs are missing during rollout, so all paper candidates stay closed. Mitigation: shadow first and
  allow observe-only repair with explicit missing-ref reasons.
- Risk: route ranking becomes too complex to debug. Mitigation: expose expected unblock value, retry cost, net repair
  value, and custody reason on each row.
- Risk: provider retries burn budget without improving route eligibility. Mitigation: retry custody leases carry
  attempt budgets and cooldowns and must be tied to expected net repair value.
- Risk: DB access limitations slow validation. Mitigation: validate through `/readyz`, `/trading/health`, route board
  output, and tests instead of requiring direct `psql` from the agent service account.

## Handoff To Engineer

Implement this as a shadow packet and route-board extension first. Do not change live submission behavior in the first
pass. The useful first milestone is proving that a failed provider job and a stale-but-expected closed-market snapshot
produce different packet states and different custody decisions.

Acceptance gates:

- Context packet builder tests for provider failure, circuit open, market-closed staleness, and missing Jangar ref.
- Route board tests proving failure cost affects observe-only ranking and missing Jangar refs force zero notional.
- Proof floor tests proving repair-only and simple-submit disabled still dominate all packet outcomes.
- Trading health output includes packet freshness, packet counts, and top custody blockers.

## Handoff To Deployer

Deploy shadow packet output first and compare it with live evidence. The deployer should be able to point at a failed
provider job, the Jangar terminal debt note, the Torghut context repair packet, and the route custody decision for the
same symbol/domain.

Promotion gates:

- Context repair packet counts reconcile with failed provider jobs and stale domains.
- Route board rows carry Jangar terminal debt refs or explicit missing-ref blockers.
- Proof floor remains the final capital gate and reports non-repair-only state before paper candidates open.
- Paper probe notional remains zero until Jangar custody, context receipts, route receipts, alpha readiness, and simple
  submit settings all pass.
- Live notional remains zero through at least one successful paper observation window with rollback-required
  hypotheses cleared.
