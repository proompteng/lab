# 170. Torghut Data Witness Capability Bonds And Capital Observation Gates (2026-05-07)

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

I am selecting **data witness capability bonds with capital observation gates** as the next Torghut profitability
architecture step.

Torghut is alive, but it is still in a repair-only capital posture. `/db-check` reports schema head
`0029_whitepaper_embedding_dimension_4096`, one schema branch, lineage ready, no missing or unexpected heads, and
account-scope checks ready. `/trading/status` reports live mode, recent scheduler activity, and a route reacquisition
book with one probing symbol, four blocked symbols, three missing symbols, seven repair candidates, and zero paper
probe notional. `/trading/health` remains degraded because alpha readiness has zero promotion-eligible hypotheses and
three rollback-required hypotheses, while quant evidence is informational for the active 15-minute account/window.

The missing piece is capital-grade observation. A trading system should not release capital because the application can
read its own database and a control-plane actor can reach the TCP port. It should release capital only when the
specific witnesses needed for the route and hypothesis are fresh: database schema, ClickHouse/TCA summary, market
context, quant stages, route book, hypothesis state, and Jangar observer leases. Torghut will emit data witness
capability bonds that cite the companion Jangar lease IDs and say whether each bond is direct, delegated, synthetic, or
missing.

The tradeoff is slower paper and live reentry. Some route repairs can be ranked today, especially high-history symbols
like `NVDA`, `AMD`, `AVGO`, and `INTC`. I still do not want capital to move until the data witnesses say which
evidence is independently observed and which evidence is delegated. Profitability depends on not confusing route repair
activity with capital readiness.

## Success Metrics

Success means:

- `/trading/health` and `/trading/status` emit `data_witness_capability_bonds`.
- Each bond includes `bond_id`, `witness_surface`, `account_label`, `window`, `symbol_scope`, `observation_mode`,
  `confidence`, `fresh_until`, `jangar_lease_id`, `capital_effect`, and `smallest_unblocker`.
- Route reacquisition rows cite the bonds that allow or block their next state transition.
- `repair_only` stays the default capital state while any mandatory bond is missing, stale, delegated-only for a
  capital-critical surface, or contradicted.
- A symbol can move from `blocked` to `probing` only when route/TCA, market-context, scoped quant, and rollback bonds
  are fresh enough for zero-notional repair.
- A symbol can move from `probing` to `capital_eligible` only when the Jangar observer leases are high confidence,
  promotion-eligible hypotheses are nonzero, rollback-required hypotheses are zero, and post-cost TCA is within
  guardrail.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07.

### Cluster And Runtime Evidence

- Torghut live `torghut-00284-deployment` and sim `torghut-sim-00384-deployment` were both `1/1` in the first
  rollout pass, with additional revision services appearing as newer revisions were created.
- Torghut pods were running for live, sim, ClickHouse, Keeper, TA, TA sim, options catalog, options enricher,
  WebSocket, and guardrail exporters. One retained whitepaper autoresearch pod remained in `Error`.
- The Torghut migration job log said the app database was ready, the postgres superuser database was ready, Alembic was
  using transactional DDL, and simulation runtime privileges were granted.
- Direct pod exec into Torghut Postgres and ClickHouse was forbidden to the current runtime. ClickHouse HTTP returned
  `401`, proving the service is reachable but not semantically observable without credentials.

### Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, expected and current head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, one schema branch, and lineage
  ready.
- The schema graph still reports parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`. Those are warnings while lineage is ready, not a capital-release proof.
- `/trading/status` returned `running=true`, `mode=live`, `last_run_at=2026-05-07T22:09:58Z`, and
  `live_submit_enabled=null` from the trimmed payload.
- The route book state was `repair_only` with `live_zero_notional_unchanged`: `AAPL` was probing, `AMD`, `AVGO`,
  `INTC`, and `NVDA` were blocked on `execution_tca_route_universe_incomplete`, and `AMZN`, `GOOGL`, and `ORCL` were
  missing TCA symbols.
- Route repair candidates were ranked by filled history and route debt: `NVDA`, `AMD`, `INTC`, `AVGO`, `AMZN`,
  `GOOGL`, and `ORCL`. Expected unblock value was `14`.
- `/trading/health` returned `status=degraded`. Alpha readiness had three hypotheses, zero promotion-eligible, and
  three rollback-required. Quant evidence for account `PA3SX7FYNUTF` and window `15m` had 144 latest metrics but
  remained `degraded` with stale ingestion stage lag.

### Source Evidence

- `services/torghut/app/main.py` already owns `/db-check`, `/trading/status`, `/trading/health`, route reacquisition,
  proof floor, alpha readiness, dependency quorum, TCA input summaries, and trading health assembly.
- `services/torghut/app/db.py` validates Alembic head state and account-scope invariants with SQLAlchemy inspectors.
- `services/torghut/app/trading/submission_council.py` already consumes typed Jangar quant health and classifies
  missing stages, empty latest stores, degraded quant, and capital-stage state.
- `services/torghut/app/trading/proof_floor.py` and the route book already keep capital at zero notional while proof is
  repair-only. Capability bonds should feed those decisions instead of bypassing them.

## Problem

Torghut has a strong capital hold, but it does not yet explain observation quality. The current status can show that a
database schema is current, a route is blocked, or a hypothesis is not promotable. It does not yet show whether the
evidence was read directly, delegated from another service, inferred from reachability, or unavailable to the actor.

That distinction matters for money:

1. A delegated `/db-check` is enough to know the app believes its schema is current.
2. A direct read-only database witness is stronger when capital depends on a migration-sensitive table.
3. A ClickHouse `401` means the data surface exists but the observer lacks semantic read rights.
4. A route book with ranked repair candidates is useful for zero-notional repair, not live capital.
5. A quant store with fresh metrics but stale ingestion is informational, not a promotion receipt.

Without capability bonds, repair work can look more complete than it is. The system may rank repairs correctly while
still lacking the observation rights that prove a repair improved post-cost edge.

## Alternatives Considered

### Option A: Trust Torghut Internal Status For Capital

Let `/trading/health` and `/trading/status` decide every capital gate without separate witness bonds.

Advantages:

- Simple and already partly implemented.
- Keeps proof logic close to trading data.
- Avoids new payload fields.

Disadvantages:

- Does not tell Jangar which evidence was direct, delegated, or unavailable.
- Cannot price missing ClickHouse or SQL observation rights.
- Makes it too easy to treat repair-only route data as capital readiness.

Decision: keep the routes, but add witness bonds.

### Option B: Require Direct SQL And ClickHouse Credentials For Every Capital Decision

Make independent database and ClickHouse queries mandatory before any paper or live action.

Advantages:

- Strong evidence.
- Clear audit trail.
- Easier to catch projection bugs.

Disadvantages:

- Expands credential handling.
- Can block useful zero-notional repair when typed projections are sufficient.
- Does not scale to every observer or stage without brittle secret distribution.

Decision: use direct witnesses for capital-critical surfaces when available, but do not make broad credentials the base
architecture.

### Option C: Data Witness Capability Bonds

Emit per-surface bonds that cite Jangar observer leases and determine capital effect.

Advantages:

- Separates repair readiness from capital readiness.
- Preserves least privilege while keeping missing access visible.
- Lets Torghut optimize repairs by expected profit effect and evidence quality.
- Gives deployers precise unblockers instead of broad credential requests.

Disadvantages:

- Adds more status payload and tests.
- Requires stable mapping from Jangar leases to Torghut trading surfaces.
- Some profitable-looking repairs will wait for observation proof.

Decision: select Option C.

## Architecture

### DataWitnessCapabilityBonds

Torghut emits:

```text
data_witness_capability_bonds
  schema_version
  generated_at
  account_label
  trading_mode
  active_revision
  jangar_ledger_ref
  bonds
  capital_observation_gate
  repair_observation_gate
  rollback_target
```

Each bond includes:

```text
data_witness_bond
  bond_id
  witness_surface
  account_label
  window
  symbol_scope
  observation_mode
  confidence
  observed_at
  fresh_until
  source_ref
  jangar_lease_id
  current_state
  missing_receipts
  capital_effect
  smallest_unblocker
```

Witness surfaces:

- `postgres_schema_head`
- `postgres_account_scope`
- `clickhouse_tca_summary`
- `route_reacquisition_book`
- `market_context_freshness`
- `quant_stage_account_window`
- `hypothesis_promotion_state`
- `jangar_observer_lease_set`
- `alpaca_route_authority`
- `paper_rollback_target`

### Capital Observation Gates

Capital effects:

- `observe_only`: usable for dashboards and audits.
- `zero_notional_repair`: usable for repair ranking and bounded reruns.
- `paper_probe_candidate`: usable only for paper rehearsal with notional limit `0` until TCA and context receipts
  improve.
- `capital_hold`: explicitly blocks paper or live notional.
- `capital_eligible`: allows the next capital gate only when all mandatory bonds are high confidence.

Initial gate rules:

- Missing ClickHouse semantic read or stale TCA keeps symbols `blocked` or `missing`.
- Fresh route book with blocked symbols allows `zero_notional_repair`, not paper capital.
- Fresh DB schema plus parent-fork warnings remains `observe_only` unless account-scope and migration lineage are
  clean for the route tables being used.
- Quant metrics with stale ingestion remain informational.
- Any missing Jangar observer lease keeps `capital_hold` for paper and live gates.

## Measurable Trading Hypotheses

The bond system starts with these hypotheses:

- High-history blocked routes have higher repair value than missing routes only when ClickHouse/TCA bonds are fresh.
- A `401` from direct ClickHouse observation should reduce capital confidence but not block zero-notional repair based
  on delegated route book data.
- Quant compute freshness without ingestion freshness should not improve capital state.
- Parent-fork schema warnings should require lineage-ready proof before promotion-sensitive capital, even when heads
  match.
- A route can only graduate after the bond set proves the same symbol, account, and window across DB, TCA, market
  context, quant, and hypothesis surfaces.

## Implementation Scope

Engineer stage should:

- Add `data_witness_capability_bonds` to `/trading/health` and `/trading/status`.
- Consume Jangar `evidence_capability_ledger.capability_leases` when configured.
- Map current `/db-check`, route book, proof floor, quant evidence, market context, alpha readiness, and TCA summary
  into bonds.
- Add tests for direct, delegated, synthetic, missing, stale, and contradicted bonds.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and capital zero notional unless bond gates are explicitly satisfied.

## Validation Gates

Required local validation:

- Targeted Torghut tests for bond generation and capital observation gates.
- Existing trading health and route-reacquisition tests still pass.
- `bunx oxfmt --check docs/agents/designs/166-jangar-evidence-capability-ledger-and-observer-lease-gates-2026-05-07.md docs/torghut/design-system/v6/170-torghut-data-witness-capability-bonds-and-capital-observation-gates-2026-05-07.md docs/torghut/design-system/v6/index.md`

Required deployer validation:

- `/trading/status` shows bonds for DB schema, route book, TCA, quant, market context, hypothesis, rollback, and
  Jangar lease set.
- The current route partition remains one probing, four blocked, and three missing unless fresh receipts explain a
  change.
- `capital_observation_gate` stays `capital_hold` while alpha promotion is zero, rollback-required is nonzero, direct
  ClickHouse is unauthorized, or Jangar leases are missing.
- A zero-notional repair cites the bond it is trying to improve and emits a success or failure receipt.

## Rollout

1. **Observe-only**: emit bonds with no submission behavior change.
2. **Repair-ranked**: use bonds to rank zero-notional repairs while capital remains held.
3. **Paper-gated**: permit paper rehearsal only when all mandatory paper bonds are fresh and high confidence.
4. **Live-gated**: permit live capital only after paper bond settlement, alpha promotion, rollback clearance, and
   Jangar lease settlement.

## Rollback

Rollback is conservative:

- Disable bond enforcement and keep bonds visible for audit.
- Keep live submission disabled and notional zero.
- Fall back to the existing proof floor and route reacquisition book.
- Mark in-flight bond-driven repairs `blocked` if their Jangar lease expires or becomes contradicted.

## Risks

- Bonds can create false precision if confidence is not tied to real evidence. Every bond must cite a source ref and
  freshness time.
- Direct credential requirements can slow useful repairs. Let delegated projections support zero-notional repair while
  reserving direct witnesses for capital.
- A route can look profitable with stale market context. Require context bonds before any paper or live notional.
- The same symbol must not mix account/window evidence. Bond IDs must include account and window.

## Handoff To Engineer

Implement bonds as a read model first. The first regression should start from the current live state: schema current,
route book repair-only, one probing symbol, four blocked symbols, three missing symbols, alpha promotion zero,
rollback-required three, quant ingestion stale, ClickHouse direct read unauthorized, and Jangar observer leases not yet
available. Expected output: bonds rank zero-notional repairs but keep paper and live capital held.

## Handoff To Deployer

Deploy observe-only, compare bonds against `/db-check`, `/trading/status`, Jangar capability leases, and the direct
ClickHouse `401` observation. Do not enable paper or live capital because a route repair candidate exists. Enable
capital only after the bond set is fresh, high confidence, account/window consistent, and settled by Jangar.
