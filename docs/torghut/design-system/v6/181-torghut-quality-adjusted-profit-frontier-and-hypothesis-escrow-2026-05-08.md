# 181. Torghut Quality-Adjusted Profit Frontier And Hypothesis Escrow (2026-05-08)

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

I am selecting a **quality-adjusted profit frontier with hypothesis escrow** for Torghut.

Torghut is producing data, but quality is the current profitability bottleneck. On 2026-05-08 at about 03:30Z, the
Jangar quant health endpoint reported `status=ok`, `latestMetricsCount=4284`, latest update lag around 13 seconds,
runtime enabled, and runtime alerts enabled. A scoped account/window call for account `PA3SX7FYNUTF` and window `1d`
also returned `status=ok`, but it returned no recent pipeline stage rows. The direct Jangar database read showed the
missing piece: 4,163 of 4,284 latest quant metrics had degraded quality. Open quant alerts included 2 critical and 10
warning alerts from April. Freshness alone is not a profitable signal.

Market context tells the same story. The latest database pass found 14 fundamentals snapshots and 23 news snapshots.
Nine fundamentals rows and 15 news rows were older than one day. All fundamentals rows and 16 news rows carried risk
flags. Recent runs succeeded, so a naive latest-run model would look better than the underlying receipt quality. The
simulation cache was last updated on March 19, which makes it a poor authority for current capital. Torghut should not
promote hypotheses or paper probes from evidence that is fresh enough to display but degraded enough to misprice risk.

The selected design makes every hypothesis and route packet carry a quality-adjusted expected value. Jangar's
evidence-quality ledger becomes a required upstream input. Torghut can still run zero-notional repair and observation
when quality is dirty, but paper and live capital require quality-good quant, market-context, route/TCA, simulation,
and hypothesis receipts.

The tradeoff is fewer apparent opportunities in the short term. I accept that. The profitable system is not the one
that reacts to the newest receipt. It is the one that knows when a new receipt should not be spent.

## Success Metrics

Success means:

- Torghut emits a `quality_adjusted_profit_frontier` in shadow mode.
- Each packet records `packet_id`, `symbol`, `hypothesis_ref`, `capital_class`, `raw_expected_edge`,
  `quality_discount`, `resource_discount`, `staleness_discount`, `route_discount`, `tca_discount`,
  `quality_adjusted_edge`, `jangar_evidence_quality_ref`, `decision`, and `rollback_target`.
- Each hypothesis has an escrow entry that names required clean receipts before it can move from repair to paper.
- Fresh-but-degraded quant metrics cannot improve `paper_probe_notional_limit`.
- Market-context receipts with risk flags can create repair work, but they cannot promote capital unless Jangar marks
  the receipt quality-good and non-stale for the target capital class.
- Simulation cache older than its configured horizon cannot satisfy current hypothesis promotion.
- Paper/live gates stay zero-notional while the Jangar quality ledger is dirty, alpha readiness has no eligible
  hypotheses, or route/TCA evidence is degraded.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, Jangar database rows, Torghut records,
trading flags, or GitOps manifests.

### Runtime And Cluster Evidence

- Jangar and Agents serving deployments were available on image family `9e7b87d8`.
- The Agents namespace held 61 failed pods, including Jangar control-plane schedule failures and Torghut
  market-context plus quant schedule failures.
- Recent Jangar and Torghut schedule-runner failures ended in Bun `AbortError`, indicating route or admission
  transients were still being converted into failed pods.
- Agents events showed readiness timeouts and temporary failed scheduling, so repair work should account for upstream
  launch quality before treating a receipt as capital-safe.
- Jangar control-plane status reported empirical services degraded for Torghut and material action receipts held or
  blocked paper/live classes under proof-floor repair-only conditions.

### Data And Profit Evidence

- Jangar quant health returned `status=ok`, `latestMetricsCount=4284`, `metricsPipelineLagSeconds=13`, and runtime
  enabled.
- Scoped Jangar quant health for `account=PA3SX7FYNUTF&window=1d` returned `status=ok`, `latestMetricsCount=144`,
  `metricsPipelineLagSeconds=185`, `pipelineHealthScoped=true`, and an empty `stages` array.
- Direct read-only Jangar SQL showed 4,163 degraded-quality rows out of 4,284 quant latest rows.
- Quant latest rows existed across aggregate account `''` and account `PA3SX7FYNUTF` for windows `1m`, `5m`, `15m`,
  `1h`, `1d`, `5d`, and `20d`. Every account/window group had a high degraded-quality ratio.
- Open quant alerts were stale but unresolved: 2 critical and 10 warning open alerts, latest opened in April.
- Market-context fundamentals snapshots had count 14, average quality `0.8914`, 9 stale-over-one-day rows, and risk
  flags on all rows.
- Market-context news snapshots had count 23, average quality `0.7826`, 15 stale-over-one-day rows, and risk flags on
  16 rows.
- Market-context runs in the last 24 hours succeeded for 5 fundamentals and 15 news runs, proving run success is not
  enough to prove receipt quality.
- Market-context evidence contained 105 rows with latest created at `2026-05-08T03:24:42.839Z`.
- Torghut simulation dataset cache had 19 rows, 37 hits, and max update at `2026-03-19T10:08:32.208Z`.

### Source Evidence

- `services/jangar/src/server/torghut-quant-metrics-store.ts` already persists metric `quality`, `status`,
  `formula_version`, `as_of`, and `freshness_seconds`, so Torghut can consume quality without a schema reset.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` currently lets status remain `ok`
  when degraded-quality ratio is high. Torghut must not use that top-line status as a capital permit.
- `services/jangar/src/server/torghut-market-context-agents.ts` already records quality score, citations, risk flags,
  runs, run events, and evidence. The missing behavior is hypothesis-level receipt escrow.
- `services/torghut/app/trading/proof_floor.py`, `services/torghut/app/trading/route_reacquisition.py`,
  `services/torghut/app/trading/submission_council.py`, and `services/torghut/app/trading/hypotheses.py` are the
  likely consumers. Scoring should land in a pure module first, not inside the submission council.

## Problem

Torghut can receive fresh data while still being unprofitable to act on.

The current failure modes are:

1. Quant health can say `ok` while most latest metrics are degraded.
2. Scoped pipeline health can be empty without becoming an action-grade blocker.
3. Recent market-context runs can succeed while snapshot age and risk flags remain capital-relevant.
4. Open alerts from prior sessions can be ignored by freshness-only gates.
5. Simulation cache can be too old to support a current hypothesis while still existing as a dataset artifact.
6. Hypothesis promotion can be blocked globally while repair work still spends resources without a quality-adjusted
   expected return.

Torghut needs to discount expected profit by evidence quality before it spends repair capacity or capital authority.

## Alternatives Considered

### Option A: Keep Proof Floor As The Sole Capital Gate

Continue relying on the current proof-floor decision and leave quality interpretation inside each existing dimension.

Advantages:

- Lowest implementation cost.
- Keeps one familiar capital gate.
- Avoids new packet scoring.

Disadvantages:

- Does not explain why fresh quant health with degraded rows should be non-promoting.
- Does not rank repairs by quality-adjusted expected value.
- Keeps hypothesis escrow implicit.

Decision: reject as the next architecture step.

### Option B: Add More Hard Thresholds To Existing Health Routes

Patch quant, market-context, and simulation health with stricter thresholds and let the existing council consume those
states.

Advantages:

- Directly addresses observed false optimism.
- Gives dashboards clearer status.
- Easier to deploy incrementally.

Disadvantages:

- Still treats all failing evidence equally.
- Does not connect a repair packet to a hypothesis and a capital class.
- Does not price the expected profit impact of fixing one evidence path before another.

Decision: required implementation work, but incomplete.

### Option C: Quality-Adjusted Profit Frontier With Hypothesis Escrow

Build a pure frontier that discounts expected edge by quality, resource cleanliness, staleness, route/TCA state,
simulation age, and Jangar quality-ledger state. Hypotheses graduate only when their escrow contains clean receipts.

Advantages:

- Keeps capital safe while ranking useful repairs.
- Makes fresh-but-degraded evidence explicitly non-promoting.
- Creates a measurable bridge from Jangar quality to Torghut profit.
- Lets repair continue without pretending repair evidence is paper/live evidence.

Disadvantages:

- Adds a reducer and score calibration.
- Requires new tests around evidence quality, not just proof-floor status.
- May reduce short-term paper opportunities until quality improves.

Decision: select Option C.

## Architecture

Torghut adds a pure `quality_adjusted_profit_frontier` reducer. It consumes proof floor, Jangar evidence-quality
ledger, quant latest metrics, quant alerts, market-context receipts, route reacquisition, execution TCA, simulation
cache state, and alpha readiness.

```text
quality_adjusted_profit_frontier
  frontier_id
  generated_at
  account_label
  capital_state
  jangar_evidence_quality_ref
  packets[]
  hypothesis_escrows[]
  next_safe_action
  rollback_target
```

Each packet is explicit:

```text
quality_adjusted_packet
  packet_id
  symbol
  repair_class                 # quant | market_context | route | tca | simulation | alpha
  hypothesis_ref
  capital_class                # observe | zero_notional_repair | paper_probe | live_micro | live_scale
  raw_expected_edge
  quality_discount
  resource_discount
  staleness_discount
  route_discount
  tca_discount
  simulation_discount
  quality_adjusted_edge
  required_receipts
  missing_receipts
  non_promoting_receipts
  decision                    # observe | repair | hold | block
  stop_conditions
  rollback_target
```

Hypothesis escrow records why a strategy cannot graduate:

```text
hypothesis_escrow
  hypothesis_ref
  required_quant_receipts
  required_market_context_receipts
  required_route_receipts
  required_tca_receipts
  required_simulation_receipts
  jangar_quality_refs
  promotion_state             # repair_only | paper_eligible | live_micro_eligible | live_scale_eligible
  blockers
```

Initial score:

```text
quality_adjusted_edge =
  raw_expected_edge
  - quality_discount
  - resource_discount
  - staleness_discount
  - route_discount
  - tca_discount
  - simulation_discount
```

Rules:

- `quality_state=degraded` on any required receipt forces `capital_class=zero_notional_repair`.
- Missing Jangar quality ledger ref forces `paper_probe_notional_limit=0`.
- Open critical quant alerts force `decision=hold` for paper and live.
- Market-context risk flags can create repair packets but not promotion receipts.
- Simulation cache older than the promotion horizon forces a simulation repair packet.
- Hypotheses with no promotion-eligible evidence cannot receive paper/live notional.

## Measurable Trading Hypotheses

The frontier should test explicit hypotheses:

- H1: Quality-adjusted ranking retires proof-floor blockers faster than freshness-only ranking over the next five
  market sessions.
- H2: Excluding degraded quant receipts from paper candidates reduces false positive paper probes compared with
  latest-timestamp selection.
- H3: Symbols with stale market-context risk flags produce better repair ROI when refreshed before route sampling.
- H4: Hypotheses with clean quant and context receipts but stale simulation cache underperform until simulation cache
  is renewed.
- H5: Repair packets that cite a clean Jangar quality ledger ref have higher downstream promotion value than packets
  produced during route timeout or retry-debt windows.

## Implementation Scope

1. Add `services/torghut/app/trading/quality_adjusted_profit_frontier.py` as a pure reducer.
2. Add tests for degraded quant rows, missing pipeline stages, stale market context, open critical alerts, stale
   simulation cache, and missing Jangar quality refs.
3. Extend Jangar continuity parsing to accept `jangar_evidence_quality_ref`, `quality_state`, and
   `non_promoting_receipt`.
4. Add a shadow proof-floor section or endpoint for the frontier.
5. Feed the frontier into submission council as informational first.
6. Add receipt lineage for market-context and quant materialization jobs so clean retries can be distinguished from
   stale or degraded receipts.

Do not start by editing `submission_council.py`. Keep score calculation deterministic and fixture-driven.

## Validation Gates

Local validation:

- Unit test: 4,163 degraded rows out of 4,284 latest metrics blocks paper/live and creates quant repair packets.
- Unit test: scoped account/window health with no recent stages remains non-promoting.
- Unit test: stale market-context snapshots with risk flags cannot improve capital class.
- Unit test: open critical quant alerts hold paper/live even when latest metrics are fresh.
- Unit test: stale simulation cache creates a simulation repair packet before hypothesis promotion.
- Proof-floor test: current live state remains zero-notional while frontier runs in shadow mode.

Cluster validation:

- New frontier shadow payload cites the current Jangar quality ledger ref.
- The highest-ranked repair packet explains score components and stop conditions.
- Paper/live gates remain closed while Jangar quality is dirty or alpha readiness has no promotion-eligible
  hypotheses.
- One market-session shadow run shows repair ordering without changing live notional.

## Rollout

1. Shadow reducer with no submission-council enforcement.
2. Receipt lineage for quant and market-context producers.
3. Repair ordering by quality-adjusted edge.
4. Paper gate requiring clean Jangar quality and clean hypothesis escrow.
5. Live micro gate requiring proof floor, route/TCA, simulation, hypothesis, and quality ledger clearance.

## Rollback

Rollback ignores frontier decisions in submission council while keeping the shadow payload. The existing proof floor
remains authoritative and currently keeps capital zero-notional. If scoring is wrong, disable repair ordering and keep
quality cleanliness as a hard paper/live veto until thresholds are recalibrated.

## Risks

- Early score weights can look more precise than the evidence supports.
- Strict quality discounts can under-spend on repairs that would cheaply improve future quality.
- Fresh market-context runs can be misread as clean receipts unless risk flags and lineage are explicit.
- Simulation cache renewal can become expensive if it is not tied to a specific hypothesis escrow.
- Jangar quality-ledger outages must fail closed for capital but not block observe-only diagnostics.

## Handoff To Engineer

Build the reducer and tests first. Use fixtures from this assessment: degraded quant latest ratio, scoped health with
empty stages, stale market-context snapshots with risk flags, open April quant alerts, and March simulation cache.
Expose the frontier in shadow mode before touching paper or live submission.

Acceptance gates:

- Fresh-but-degraded evidence cannot increase paper/live notional.
- Every packet explains its quality-adjusted score.
- Hypothesis escrow names missing clean receipts.
- Current capital state remains zero-notional until proof-floor and quality-ledger blockers clear.

## Handoff To Deployer

Deploy only after Jangar evidence-quality ledger is visible in shadow mode. Watch repair ordering for at least one
market session. Do not enable paper/live enforcement until receipts carry Jangar quality refs and non-promoting flags.

Acceptance gates:

- Shadow frontier cites a current Jangar quality ledger ref.
- Degraded quant and market-context receipts are visible but non-promoting.
- The top repair packet has bounded stop conditions and a rollback target.
- Paper/live remain disabled while Jangar quality or hypothesis escrow is dirty.

## Implementation note: 2026-05-08 shadow reducer

The first Torghut-owned slice adds `torghut.quality-adjusted-profit-frontier.v1` in shadow mode on `/trading/status`
and `/readyz`. It ranks zero-notional repair packets and hypothesis escrows from proof-floor, route/TCA, quant-health,
market-context, simulation-cache, and Jangar evidence-quality inputs.

Degraded quant rows, empty scoped stages, market-context risk flags, open critical quant alerts, stale simulation
cache, or missing Jangar quality refs keep paper/live notional at zero. Rollback is to stop exposing the frontier
payload and leave the existing proof-floor/live-submission gates authoritative.
