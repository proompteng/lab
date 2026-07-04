# 202. Torghut Alpha Evidence Foreclosure And Routeable Candidate Reentry (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant revenue repair, alpha evidence-window foreclosure, no-delta debt settlement, routeable candidate
reentry, zero-notional capital safety, validation, rollout, rollback, and Jangar handoff.

Companion Jangar contract:

- `docs/agents/designs/197-jangar-alpha-evidence-foreclosure-governor-and-runner-custody-2026-05-14.md`

Extends:

- `201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`
- `200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md`
- `199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`
- `198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`
- `197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`
- `190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`

## Decision

I am selecting an **alpha evidence foreclosure and routeable candidate reentry contract** as the next Torghut quant
architecture increment.

The live business surface has moved again, but the revenue blocker has not cleared. On 2026-05-14 at 04:10 UTC,
`GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned
`business_state=repair_only`, `revenue_ready=false`, active revision `torghut-00376`, accepted routeable candidate
count `0`, `zero_notional_or_stale_evidence_rate=1.0`, `max_notional=0`, and top queue item
`repair_alpha_readiness`. That queue item still targets `routeable_candidate_count`, still cites
`hypothesis_not_promotion_eligible`, and still requires `torghut.executable-alpha-receipts.v1`.

The difference is that Torghut now publishes the alpha evidence foundry, alpha repair closure board, closure settlement
market, and executable alpha repair receipts. Those contracts make the work visible. They also expose a new failure
mode: the foundry is producing no-delta evidence-window receipts for the same blocker set. Three
`torghut.alpha-evidence-window-receipt.v1` receipts reported measured routeable candidate delta `0` and
`no_delta_reason=routeable_candidate_count_unchanged`. `H-MICRO-01` remains the only lineage-ready lane, but it is
still blocked by `drift_checks_missing`, `feature_rows_missing`, and `required_feature_set_unavailable`; `H-CONT-01`
and `H-REV-01` remain shadow lanes with non-positive post-cost evidence or missing lineage.

The next architecture should not create yet another alpha-readiness receipt type. It should foreclose unchanged
evidence windows, reserve one reentry path for the lineage-ready H-MICRO-01 feature replay, and require a terminal
settlement receipt before the same dedupe key can spend another zero-notional repair slot. The tradeoff is strict:
some useful repair work will wait behind no-delta custody. That is the right trade while the business metric is
routeable post-cost profit evidence and live trading readiness without weakening capital safety.

## Governing Runtime Requirements

This design follows the active Torghut quant validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

The value-gate mapping is explicit:

- `routeable_candidate_count`: primary gate. A foreclosure window may reopen only when H-MICRO-01 produces fresh
  feature rows, drift checks, required feature-set evidence, or a promotion receipt that can change routeability.
- `zero_notional_or_stale_evidence_rate`: each no-delta receipt must either retire stale evidence or be carried as
  foreclosure debt until its source key changes.
- `fill_tca_or_slippage_quality`: AAPL is the only probing symbol; AMD, AVGO, INTC, and NVDA remain blocked by route
  TCA quality, and AMZN, GOOGL, and ORCL remain missing TCA. Reentry cannot count a routeable candidate while those
  route constraints block the selected path.
- `post_cost_daily_net_pnl`: H-CONT-01 and H-REV-01 remain behind non-positive post-cost expectancy; H-MICRO-01 must
  settle a current post-cost or rejection-drag receipt before promotion custody can graduate.
- `capital_gate_safety`: live submit remains disabled, capital stage remains shadow, and every foreclosure or reentry
  object carries `max_notional=0`.

## Read-Only Evidence Snapshot

I collected this evidence read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading flags,
broker state, GitOps resources, AgentRuns, or market data.

### Cluster And Rollout

- The working branch was `codex/swarm-torghut-quant-discover`, based on `origin/main` at
  `29f0d1c9fd417fc65666896b6b5433be668c78a5`.
- Argo reported `torghut`, `jangar`, and `agents` as `Synced` and `Healthy` at revision
  `29f0d1c9fd417fc65666896b6b5433be668c78a5`.
- Torghut live revision `torghut-00376` and sim revision `torghut-sim-00474` were running and available. The serving
  image digest was `sha256:6077dc8dc64721d4772b0d10c8e1a0b567e2c7f2475686bf323f7d211941b750`, source commit
  `9292518f9a313af097a24f7fd50f912676740a9e`.
- Postgres `torghut-db-1`, ClickHouse, Keeper, TA, TA sim, options catalog, options enricher, WebSocket services, and
  guardrail exporters were running.
- Recent Torghut events showed normal Knative replacement behavior: image pulls, migrations completed, startup and
  readiness probe warnings during revision replacement, then `RevisionReady` for `torghut-00376` and
  `torghut-sim-00474`.
- The cluster still has reliability noise outside the live capital path: many Torghut whitepaper autoresearch pods and
  several Jangar/Torghut AgentRun pods were in `Error` or `OOMKilled` while current attempts were running or
  completed. That tail is evidence for stricter no-delta runner custody.

### Database And Data Quality

- Direct CNPG cluster listing and `kubectl cnpg psql` were forbidden to this service account for `torghut` and
  `jangar`. That least-privilege boundary means the architecture lane must use application-level database witnesses.
- `GET /db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, one schema graph branch, no missing heads, no unexpected
  heads, lineage ready, and account-scope ready.
- Known schema graph parent-fork warnings remain under `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; they did not block schema currentness.
- `GET /readyz` returned HTTP 503 with `status=degraded`, while Postgres, ClickHouse, Alpaca, database schema,
  universe, empirical jobs, DSPy runtime, and optional quant evidence were healthy or acceptable.
- The readiness failures were capital-safe: `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`.
- Runtime profitability over 72 hours reported 68 decisions, 0 executions, 6250 TCA samples, and
  `realized_pnl_proxy_notional=-1726.06230727`. Every recent decision path remained blocked; this is evidence, not a
  tradable profit certificate.
- Promotion table counts showed 1242 autoresearch candidate specs, 1242 proposal scores, 5 portfolio candidates,
  0 portfolio-ready rows, and 5 blocked portfolio candidates. H-MICRO-01 had ready strategy lineage; H-CONT-01 and
  H-REV-01 did not.

### Source And Test Surface

- `services/torghut/app/main.py` is 6925 lines and remains the high-risk integration surface for `/readyz`,
  `/trading/status`, `/trading/revenue-repair`, `/trading/consumer-evidence`, and zero-notional repair execution.
- `services/torghut/app/trading/revenue_repair.py` is 1111 lines and builds the live revenue digest, queue, foundry,
  closure board, and repair settlement projections.
- `services/torghut/app/trading/alpha_evidence_foundry.py` is 608 lines and now emits the evidence-window receipt set
  that exposes no-delta debt.
- `services/torghut/app/trading/alpha_repair_closure_board.py` is 820 lines and implements the closure board and
  market described by docs 198 and 201.
- `services/torghut/app/trading/executable_alpha_receipts.py` is 1146 lines and remains the launch-candidate receipt
  producer.
- `services/torghut/app/trading/routeability_repair_acceptance.py` is 768 lines and is the routeable count authority
  that must consume terminal closure receipts before increasing accepted candidate count.
- `services/torghut/app/trading/repair_bid_settlement.py` is 716 lines and compacts raw repair bids into dispatchable
  lots.
- The test suite already has focused coverage for executable alpha repair receipts, alpha evidence foundry, alpha
  repair closure board, routeability repair acceptance, repair-bid settlement, and revenue repair digest. The missing
  coverage is foreclosure behavior: unchanged evidence-window receipts should deny repeat runner spend until source,
  evidence window, blocker digest, or required receipt set changes.

### Trading Evidence

- `/trading/revenue-repair` reported `repair_only`, `revenue_ready=false`, and active revision `torghut-00376`.
- Capital stayed closed: `live_submission_allowed=false`, `live_submission_reason=simple_submit_disabled`,
  `capital_stage=shadow`, `proof_floor_state=repair_only`, `route_state=repair_only`,
  `capital_state=zero_notional`, and `max_notional=0`.
- Top repair queue item:
  - `code=repair_alpha_readiness`
  - `reason=hypothesis_not_promotion_eligible`
  - `value_gate=routeable_candidate_count`
  - `expected_unblock_value=4`
  - `required_output_receipt=torghut.executable-alpha-receipts.v1`
  - `required_receipts=alpha_readiness_receipt,hypothesis_promotion_receipt,capital_replay_board`
  - `max_notional=0`
- Routeability acceptance was blocked with `accepted_routeable_candidate_count=0` and
  `zero_notional_or_stale_evidence_rate=1.0`.
- Repair-bid settlement had 33 raw bids, 6 compacted lots, 5 selected lots, 3 dispatchable lots, and
  `routeable_candidate_count=0`.
- Alpha readiness had 3 hypotheses, 0 promotion-eligible hypotheses, 2 rollback-required shadow lanes, and 3 blocked
  repair targets.
- H-MICRO-01 was the only lineage-ready target. It remained blocked by drift checks, feature rows, required feature
  set evidence, and closed-session signal hold.
- Route reacquisition had `routeable_symbol_count=0`, `probing_symbol_count=1`, `blocked_symbol_count=4`,
  `missing_symbol_count=3`, candidate symbol `AAPL`, and expected unblock value `14`.
- Execution TCA held the route universe: 7334 orders, 7245 filled executions, latest execution created at
  `2026-04-02T19:00:29.586040+00:00`, average absolute slippage `13.8203637593029676` bps against an 8 bps guardrail,
  AAPL probing, AMD/AVGO/INTC/NVDA blocked, and AMZN/GOOGL/ORCL missing.

## Problem

Torghut has enough architecture to name the alpha repair, but not enough custody to prevent repeated no-delta work.
That is now the system-level blocker.

The concrete failure modes are:

1. An unchanged alpha evidence-window receipt can be regenerated and relaunched even when it previously preserved every
   blocker.
2. Routeability remains zero while repair-bid settlement reports dispatchable work, so runner dispatch can look busy
   while the business metric does not move.
3. H-MICRO-01 is the only lineage-ready lane, but the current payload does not make its stale feature window the sole
   foreclosure release key.
4. H-CONT-01 and H-REV-01 can consume attention even though their immediate blockers are non-positive post-cost
   expectancy or missing lineage.
5. Jangar can see current Torghut evidence but needs a compact foreclosure decision to deny duplicate launch keys.
6. Operators can misread `/readyz` degradation as a submit-gate problem; the correct next blocker is alpha evidence
   foreclosure and feature-replay after-receipt settlement.

The design must convert no-delta evidence into debt with release conditions, then define the only reentry path that can
move routeable candidate count without opening capital.

## Alternatives Considered

### Option A: Keep Launching Existing Alpha Evidence Receipts

Continue to let the alpha evidence foundry and closure board produce the same receipt set, with Jangar deciding whether
to launch another repair run from dispatchable lots.

Advantages:

- No new Torghut schema.
- Uses live reducers and tests already present.
- Keeps all capital fields at zero.

Disadvantages:

- Repeats no-delta work against unchanged blocker sets.
- Does not give routeability acceptance a terminal after-receipt.
- Keeps failed AgentRun and OOM risk detached from business impact.
- Leaves routeable candidate count at zero while work appears active.

Decision: reject. Existing receipts remain inputs, not repeat authorization.

### Option B: Switch Priority To TCA Route Repair

Spend the next architecture and runner capacity on route TCA quality for AMD, AVGO, INTC, NVDA, and missing route
coverage for AMZN, GOOGL, and ORCL.

Advantages:

- Directly improves `fill_tca_or_slippage_quality`.
- Route quality is a real capital-safety guardrail.
- The evidence is concrete and symbol-scoped.

Disadvantages:

- It is not the live top `/trading/revenue-repair` queue item.
- It cannot increase routeable candidate count while alpha readiness remains not promotion eligible.
- It can improve downstream execution quality without producing a promotion-ready hypothesis.

Decision: reject as the lead lane. TCA remains a required reentry gate after alpha foreclosure releases H-MICRO-01.

### Option C: Alpha Evidence Foreclosure With H-MICRO-01 Reentry

Create a foreclosure read-model that marks unchanged alpha evidence-window receipts as active no-delta debt, reserves
H-MICRO-01 as the only current reentry lane, and requires terminal feature-replay and promotion-custody receipts before
routeability acceptance can change.

Advantages:

- Targets the live top queue item and primary business gate.
- Prevents repeat runner spend on unchanged no-delta keys.
- Uses H-MICRO-01 because it is the only lineage-ready lane.
- Keeps H-CONT-01 and H-REV-01 behind post-cost and lineage blockers.
- Preserves `max_notional=0` and live submit disabled.
- Gives Jangar a compact admission and denial contract.

Disadvantages:

- Adds another reducer and test family.
- Holds some useful repairs until the foreclosure key changes.
- Requires careful source/evidence-window keying so legitimate fresh evidence is not blocked.

Decision: select Option C.

## Architecture

Torghut publishes an `alpha_evidence_foreclosure_book` in `/trading/revenue-repair` and mirrors a compact
`alpha_evidence_foreclosure_ref` in `/trading/consumer-evidence`.

```text
torghut.alpha-evidence-foreclosure-book.v1
  book_id
  generated_at
  fresh_until
  account_id
  window
  trading_mode
  source_commit
  active_revision
  source_revenue_repair_ref
  source_alpha_evidence_foundry_ref
  source_alpha_closure_board_ref
  routeability_acceptance_ref
  capital_rule = zero_notional_repair_only
  foreclosure_state = open | released | superseded
  selected_reentry_hypothesis_id
  selected_reentry_lane_id
  selected_value_gate = routeable_candidate_count
  active_no_delta_debts[]
  release_conditions[]
  required_after_receipts[]
  denied_repeat_keys[]
  validation_commands[]
  rollback_target
```

The active no-delta debt key is:

```text
account_id + window + source_commit + hypothesis_id + repair_class + blocker_digest + required_receipt_digest
```

The book records one row per active no-delta receipt:

```text
alpha_evidence_foreclosure_debt
  debt_id
  source_receipt_id
  hypothesis_id
  candidate_id
  strategy_id
  lane_id
  repair_class
  value_gate
  blocker_digest
  preserved_reason_codes[]
  retired_reason_codes[]
  measured_routeable_candidate_delta
  no_delta_reason
  release_conditions[]
  repeat_launch_decision = deny | allow_after_change
  max_notional = 0
```

The first release policy is intentionally narrow:

- H-MICRO-01 is the selected reentry hypothesis while it is the only lineage-ready lane.
- H-MICRO-01 release requires a current feature replay receipt, drift check receipt, required feature set receipt,
  alpha readiness receipt, and promotion custody receipt.
- H-MICRO-01 may not count as routeable while route/TCA remains outside the selected symbol path guardrail.
- H-CONT-01 and H-REV-01 stay foreclosed until post-cost expectancy or lineage status changes.
- Any repeat launch with the same debt key is denied.
- A repeat launch becomes eligible only when source commit, evidence window, blocker digest, required receipt set, or
  selected top queue item changes.

Routeability acceptance consumes only terminal foreclosure outcomes:

```text
routeability_repair_acceptance_input
  alpha_evidence_foreclosure_book_ref
  terminal_foreclosure_receipt_ref
  selected_hypothesis_id
  selected_route_symbol
  measured_routeable_candidate_delta
  release_state
  capital_rule
```

If terminal settlement reports no movement, routeability remains at zero and the no-delta debt stays active. If
terminal settlement retires the feature blockers but post-cost or TCA remains blocked, routeability remains zero and
the book moves the lane to the next explicit blocker. If terminal settlement retires feature, promotion, post-cost, and
route/TCA blockers, routeability acceptance may increase the routeable candidate count while still keeping
`max_notional=0` until capital gate safety separately clears.

## Implementation Scope

M1 is a pure Torghut reducer and tests:

- Add `services/torghut/app/trading/alpha_evidence_foreclosure.py`.
- Consume the current `alpha_evidence_foundry`, `alpha_repair_closure_board`, routeability acceptance ledger, and
  runtime build fields.
- Emit `alpha_evidence_foreclosure_book` from `/trading/revenue-repair`.
- Mirror compact `alpha_evidence_foreclosure_ref` from `/trading/consumer-evidence`.
- Add tests proving unchanged no-delta debts deny repeat keys and H-MICRO-01 is the selected reentry lane.

M2 is Jangar admission:

- Consume `alpha_evidence_foreclosure_ref`.
- Deny duplicate zero-notional repair AgentRuns when `repeat_launch_decision=deny`.
- Allow a new alpha-repair runner only when the release key changed or a terminal settlement receipt exists.

M3 is routeability reentry:

- Add a routeability acceptance input that consumes terminal foreclosure outcomes.
- Keep `accepted_routeable_candidate_count=0` until after-receipts retire the selected blockers.
- Emit a clear next-blocker state when H-MICRO-01 releases feature evidence but remains blocked by post-cost or TCA.

M4 is deployer verification:

- Verify image promotion, Argo sync, workload readiness, `/readyz`, `/trading/revenue-repair`, and
  `/trading/consumer-evidence`.
- Capture routeable candidate count, no-delta debt count, H-MICRO-01 release state, and capital notional.

## Validation Gates

Local engineer validation:

- `uv run --frozen pytest services/torghut/tests/test_alpha_evidence_foreclosure.py`
- `uv run --frozen pytest services/torghut/tests/test_alpha_evidence_foundry.py services/torghut/tests/test_alpha_repair_closure_board.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k alpha`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Runtime verification after deploy:

- `/trading/revenue-repair` includes `alpha_evidence_foreclosure_book.schema_version=torghut.alpha-evidence-foreclosure-book.v1`.
- `active_no_delta_debts.length >= 1` while current no-delta receipts preserve blockers.
- `selected_reentry_hypothesis_id=H-MICRO-01`.
- `repeat_launch_decision=deny` for unchanged H-MICRO-01 debt keys.
- `accepted_routeable_candidate_count` remains `0` until terminal after-receipts retire blockers.
- `max_notional=0`, `live_submission_allowed=false`, and `capital_stage=shadow`.

Business validation:

- Primary metric: `routeable_candidate_count`.
- Intermediate metric: `zero_notional_or_stale_evidence_rate`.
- Safety metric: `capital_gate_safety`.
- Smallest blocker if revenue does not move: H-MICRO-01 feature replay and promotion custody did not produce terminal
  after-receipts that retire `feature_rows_missing`, `required_feature_set_unavailable`, and the active no-delta debt
  key.

## Rollout

1. Ship the Torghut reducer in observe mode. Do not change live submission, proof-floor, or capital flags.
2. Verify the book appears in `/trading/revenue-repair` and compact ref appears in `/trading/consumer-evidence`.
3. Deploy Jangar consume-only parsing for the compact ref.
4. Enable Jangar shadow denial metrics for duplicate foreclosure keys.
5. Enable Jangar enforcement for repeat no-delta alpha repair launches only after at least one deploy cycle proves the
   ref is stable.
6. Keep all paper and live action classes held until routeability acceptance and capital gate safety separately pass.

## Rollback

Rollback is to ignore `alpha_evidence_foreclosure_book` and `alpha_evidence_foreclosure_ref`.

Safe rollback conditions:

- Keep existing alpha evidence foundry, alpha repair closure board, executable alpha repair receipts, and repair-bid
  settlement payloads intact.
- Keep `max_notional=0`.
- Keep `simple_submit_disabled`.
- Keep routeability acceptance at its current authority state.
- Do not delete or rewrite no-delta history; stop consuming the foreclosure book until the reducer is fixed.

Emergency rollback triggers:

- Foreclosure book emits nonzero notional.
- Foreclosure book selects a hypothesis other than H-MICRO-01 while H-MICRO-01 is the only lineage-ready lane and the
  live top queue remains alpha readiness.
- Repeat keys are denied after source commit, evidence window, blocker digest, or required receipt set changes.
- Routeability acceptance increases candidate count without terminal after-receipts.

## Risks

- Over-foreclosure can block useful repair work if the key omits a legitimate source or evidence-window change.
- Under-foreclosure can repeat no-delta runner work and increase failed AgentRun rate.
- H-MICRO-01 can retire feature blockers and still fail post-cost or TCA; the book must report the next blocker rather
  than imply revenue readiness.
- Direct DB introspection is unavailable to this worker; application-level witnesses must remain trustworthy and
  schema-versioned.
- The live AgentRun error tail means Jangar enforcement should start in shadow mode before denying real runner starts.

## Handoff

Engineer:

- Implement M1 as a pure read-model with focused tests.
- Do not mutate trading records, broker state, or Kubernetes resources from the reducer.
- Keep every emitted object at `max_notional=0`.
- Add regression tests for unchanged no-delta keys, changed release keys, H-MICRO-01 selection, and routeability count
  preservation.

Deployer:

- Roll out only after Torghut pyright profiles and targeted tests pass.
- Prove image promotion, Argo sync, active revision, `/readyz` degraded-for-capital-only state, revenue-repair book
  presence, consumer-evidence ref presence, and unchanged `max_notional=0`.
- Do not enable paper or live action classes from this rollout.

Next bounded milestone:

- Build `torghut.alpha-evidence-foreclosure-book.v1` and the compact consumer-evidence ref, then hand Jangar the
  duplicate-denial key for shadow enforcement.
