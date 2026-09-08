# 109. Torghut Profit Proof Budget Consumer And Options Runway (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: options data/control lane exists; options trading authority remains separate and gated.
- Matched implementation area: Options lane.
- Current source evidence:
  - `services/torghut/app/options_lane/settings.py`
  - `services/torghut/app/options_lane/catalog_service.py`
  - `services/torghut/app/options_lane/enricher_service.py`
  - `argocd/applications/torghut-options/ws/deployment.yaml`
  - `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
- Design drift note: March/options text must be checked against current `options_lane` source and `torghut-options` GitOps before use.


## Decision

I am choosing **profit proof budgets over direct capital widening** for the next Torghut architecture step.

The current Torghut data plane has useful energy. The options catalog has about `2.38M` rows, fresh `last_seen_ts`
around `2026-05-06T07:16Z`, and roughly `2.35M` active tradable contracts. The latest live and simulation revisions are
ready, and the options catalog, options enricher, TA, ClickHouse, Postgres, and websocket services are running.

That is not a reason to widen live capital. The hypothesis-governance tables are empty, promotion decisions are empty,
and the latest persisted trade decisions are from `2026-05-04T17:25:57Z`. Jangar's proof database is also paying for a
`110 GB` quant series and a `17 GB` pipeline-health table. Torghut needs to exploit the fresh options plane by creating
bounded shadow proof, not by converting route health into live sizing.

The selected design makes Torghut a consumer of Jangar's evidence pressure runway. Torghut receives a per-account,
per-hypothesis proof budget that can allow shadow evidence, repair work, paper canaries, or live micro-canaries. Empty
hypothesis windows and empty promotion decisions keep live blocked. Fresh options data earns a shadow budget that must
produce measurable hypotheses, metric windows, promotion decisions, and bounded cost evidence before capital authority
can widen.

The tradeoff is slower capital re-entry. I accept that because the current evidence says Torghut has data, not profit
proof.

## Read-Only Evidence Snapshot

No database rows, Kubernetes resources, broker settings, trading flags, or runtime objects were mutated during this
assessment. CNPG pod exec was forbidden to the current service account, so database evidence used direct read-only
service connections.

### Cluster Evidence

- The latest Torghut live revision `torghut-00233-deployment` was `1/1` available and its pod was `2/2 Running`.
- The latest simulation revision `torghut-sim-00314-deployment` was `1/1` available and its pod was `2/2 Running`.
- ClickHouse pods, Keeper, Torghut Postgres, options catalog, options enricher, options TA, equity TA, simulation TA,
  websockets, guardrail exporters, Symphony, and Alloy were running.
- Rollout events still showed startup/readiness probe flaps during revision transition before the latest revisions
  became ready.
- ClickHouse pods still matched multiple PDBs, so deploy widening needs an explicit rollout proof budget and not only
  Knative ready state.

### Data Evidence

- `torghut_options_contract_catalog` had `2,385,276` exact rows with `max(last_seen_ts)` around
  `2026-05-06T07:16Z`.
- Active/tradable contracts accounted for `2,346,094` rows; active/non-tradable contracts accounted for `39,182` rows.
- `torghut_options_subscription_state` had `6,026` rows with `max(last_ranked_ts)` around `2026-05-06T07:16Z`.
- `torghut_options_watermarks` had `5,187` rows with `max(last_success_ts)` around `2026-05-06T07:27Z`.
- `position_snapshots` had `40,759` rows with newest `created_at` on `2026-05-05T20:59Z`.
- `strategies` had `16` rows, but `strategy_hypotheses`, `strategy_hypothesis_metric_windows`, and
  `strategy_promotion_decisions` had `0` rows.
- `trade_decisions` had `147,606` rows with latest `created_at` at `2026-05-04T17:25:57Z`.
- Jangar's Torghut projection path had fresh `quant_metrics_latest` rows but a large backing proof series, so Torghut
  must consume latest/materialized proofs for admission and reserve full series access for bounded analysis jobs.

### Source Evidence

- Torghut migration history includes hypothesis-governance tables:
  `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py`.
- Torghut tests already cover strategy hypothesis governance, empirical promotion manifests, strategy factory,
  autonomy gates, order firewall, quote quality, TCA, and portfolio sizing.
- Jangar exposes Torghut quant latest and health paths through
  `services/jangar/src/server/torghut-quant-metrics-store.ts`,
  `services/jangar/src/server/torghut-quant-runtime.ts`, and
  `services/jangar/src/routes/api/torghut/trading/control-plane/quant/*`.
- The missing cross-system behavior is a consumer contract that converts fresh options data into shadow proof budgets
  and blocks live promotion until hypothesis windows and promotion decisions exist.

## Problem

Torghut has a fresh options surface but no current profit proof loop.

If we treat options freshness as capital readiness, we will repeat the same pattern: decisions are created or sized
before the account, strategy, and hypothesis evidence has matured. If we freeze everything, we waste the useful fresh
options plane. The right answer is an intermediate runway: use fresh options to generate bounded shadow evidence, then
graduate only the hypotheses that produce measurable post-cost proof.

The system needs to separate these states:

1. Options data is fresh enough to rank contracts.
2. Hypothesis evidence is present and current enough to compare lanes.
3. Promotion decisions are explicit and reviewable.
4. Account/window quant latest is fresh enough for sizing.
5. TCA and execution proof are current enough to move beyond paper or micro-canary capital.

## Alternatives Considered

### Option A: Reopen Live Capital When Options Freshness Is Green

Pros:

- Fast path to market exposure.
- Uses the data plane that is currently freshest.
- Minimal implementation.

Cons:

- Hypothesis windows and promotion decisions are empty.
- Trade decisions are not fresh.
- It would route around Jangar's proof pressure instead of reducing it.

Decision: reject.

### Option B: Freeze Torghut Until Every Proof Table Is Populated

Pros:

- Conservative and easy to enforce.
- Avoids live capital mistakes.
- Keeps proof pressure from growing.

Cons:

- Wastes fresh options data.
- Does not produce the missing hypothesis windows.
- Encourages manual bypasses when operators want evidence.

Decision: reject as the normal posture. Keep it as emergency fail-closed behavior.

### Option C: Consume Profit Proof Budgets From Jangar

Pros:

- Allows shadow evidence generation while live capital stays blocked.
- Makes fresh options data useful without over-trusting it.
- Creates measurable gates for hypothesis creation, metric windows, promotion decisions, quant latest freshness, and
  TCA coverage.
- Keeps expensive proof reads behind Jangar's query budget contract.

Cons:

- Requires Torghut and Jangar status schemas to agree on budget semantics.
- Requires new tests for empty hypothesis tables and fresh options data.
- Adds a shadow operating mode that deployer must monitor before enforcement.

Decision: select Option C.

## Chosen Architecture

Torghut consumes a `profit_proof_budget` projection from Jangar:

```text
profit_proof_budget
  budget_id
  account_label
  hypothesis_id
  strategy_id
  data_surface                         # options, equity, market_context, tca
  action_class                         # shadow_rank, shadow_decide, paper_canary, live_micro_canary, live_scale
  options_freshness_state
  hypothesis_window_state
  promotion_decision_state
  account_quant_state
  tca_state
  max_contracts_to_rank
  max_symbols_to_promote
  max_notional
  decision                             # allow, shadow_only, repair_only, hold, block
  reason_codes[]
  evidence_refs[]
  fresh_until
```

Initial reducer rules:

- Fresh options data with empty hypotheses allows `shadow_rank` and `shadow_decide`.
- Empty `strategy_hypothesis_metric_windows` blocks `paper_canary`, `live_micro_canary`, and `live_scale`.
- Empty `strategy_promotion_decisions` blocks capital promotion even if options and quant latest are fresh.
- Stale trade decisions force the next run to produce fresh shadow decisions before promotion.
- Account/window quant latest must be fresh and read from latest/materialized projections before sizing can occur.
- TCA coverage must be non-empty before any action above paper canary.
- Any Jangar proof-query pressure red state can hold Torghut live actions even when Torghut route health is green.

For the current evidence, expected decisions are:

```text
options_shadow_rank                 allow
options_shadow_decide               allow
paper_canary                        block
live_micro_canary                   block
live_scale                          block
profit_repair                       allow
```

## Implementation Scope

Engineer stage should:

1. Add a Torghut budget consumer fixture that maps Jangar runway decisions to Torghut action classes.
2. Populate shadow hypothesis evidence from the fresh options catalog before any capital promotion path is enabled.
3. Add tests for the current state: fresh options data, empty hypothesis windows, empty promotion decisions, stale trade
   decisions, and fresh quant latest.
4. Keep proof admission reads on latest/materialized paths and push deep series analysis to bounded offline jobs.

Deployer stage should:

1. Deploy the consumer in shadow mode.
2. Verify shadow budgets create hypothesis metric windows and promotion decisions.
3. Keep live capital blocked until at least one hypothesis has current windows, an explicit promotion decision, fresh
   account quant, and current TCA coverage.
4. Roll back live enforcement by flag while keeping shadow ranking active if the consumer misclassifies budgets.

## Validation Gates

- A regression test proves fresh options catalog plus empty hypothesis tables yields `shadow_only`, not live.
- A regression test proves stale trade decisions require a new shadow decision window before promotion.
- A query-budget test proves Torghut admission does not count or scan the Jangar quant series table.
- A rollout gate proves duplicate ClickHouse PDB warnings and readiness probe debt keep deploy widening under review.
- A promotion gate proves no live action is allowed without metric windows and promotion decisions.

## Rollout And Rollback

Rollout sequence:

1. Ship shadow budget consumption and expose budget decisions in status.
2. Generate hypothesis windows from fresh options catalog rankings.
3. Require explicit promotion decisions before paper canary.
4. Require account quant latest and TCA coverage before live micro-canary.
5. Widen only after Jangar runway pressure is green.

Rollback sequence:

1. Disable budget enforcement for shadow ranking only if it blocks evidence generation.
2. Keep live actions fail-closed when budget projection is missing or stale.
3. Revert to previous submission gates for paper/live if the budget consumer regresses.
4. Preserve generated shadow evidence and promotion decisions for audit; do not delete proof artifacts as rollback.

## Risks

- Shadow evidence may grow faster than promotion review if budgets are too loose. Cap contracts and symbols per run.
- Empty hypothesis tables could be a migration or ingestion issue rather than a research issue. Engineer must verify
  write paths before using emptiness as business signal.
- Options freshness may be market-hours sensitive. Budget decisions need session-aware freshness windows.
- Query-budget enforcement can hide useful diagnostics. Deep diagnostics should remain available through explicit,
  bounded repair jobs.

## Handoff Contract

Engineer handoff:

- Build the budget consumer as shadow-only first.
- Prove the current evidence snapshot maps to shadow allowed and live blocked.
- Keep admission reads on latest/materialized paths.
- Emit budget reason codes that Jangar and Torghut can both display.

Deployer handoff:

- Watch shadow hypothesis creation, metric-window population, promotion decisions, quant latest freshness, and TCA
  coverage.
- Do not widen live capital while hypothesis windows or promotion decisions are empty.
- Keep a flag to disable enforcement without stopping shadow evidence generation.
