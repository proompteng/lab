# 69. Torghut Harness v2, Strategy Discovery, and Whitepaper Research Factory (2026-04-07)

Status: Proposed (`design`)
Date: `2026-04-07`
Owner: Codex (repository-local design draft)
Scope: Define the next iteration after the current breakout-plus-washout promotion: replace replay-heavy parameter
grids and paper-afterthought workflows with a discovery system that is tape-aware, distribution-aware, and
research-linked.

Extends:

- `docs/torghut/design-system/v6/68-torghut-strategy-factory-formal-validity-and-sequential-promotion-2026-04-04.md`
- `docs/torghut/design-system/v6/54-torghut-research-backed-sleeves-and-this-week-holdout-proof-2026-03-27.md`
- `docs/torghut/design-system/v6/53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md`
- `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
- `docs/torghut/design-system/v6/67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md`

## Executive summary

Torghut is in a transitional state.

The current `search_consistent_profitability_frontier.py` harness is a real improvement over the older train-only
selection path, but it is still a transitional tool:

- it sweeps parameter grids over hand-authored sleeves;
- it scalarizes consistency into one replay penalty after the fact;
- it does not fail closed on stale or missing tape;
- it can still reward lucky day concentration;
- and it does not use whitepaper research as a structured input to discovery.

That is not enough for the next iteration.

The next system should be built around three hard truths established by recent work and by the repo’s own runtime
evidence:

1. a strategy that clears an average PnL target with one dominant day is not a satisfactory discovery result;
2. a harness that optimizes on stale `PT1S` tape is not trustworthy, even if the replay code is otherwise correct;
3. a whitepaper corpus that is only semantically searchable is still too weak to drive research-grade hypothesis
   generation.

This document proposes a concrete next architecture:

1. **Harness v2**:
   - immutable tape snapshots,
   - freshness witnesses,
   - replay-once/cache-many execution,
   - and multi-objective scoring that treats activity, filled notional, drawdown, and PnL concentration as first-class.
2. **Strategy Discovery v2**:
   - family templates instead of raw threshold soup,
   - matched-filter feature variants,
   - day-veto and regime-veto controllers,
   - and contribution-aware search over families rather than blind parameter grids.
3. **Whitepaper Research Factory**:
   - relation-aware retrieval over papers,
   - structured claim extraction,
   - claim-to-experiment compilation,
   - contradiction tracking,
   - and explicit links from papers to candidate families, evaluation contracts, and invalidation clauses.

The key design decision is this:

Torghut should stop treating whitepapers as narrative background and stop treating replay as a scalar leaderboard.

The new source of truth should be:

- **paper claims** compiled into **experiment specs**,
- run against **authoritative tape snapshots**,
- scored by **distribution-aware objectives**,
- promoted only when the resulting strategy behaves like a repeatable business and not like a lottery ticket.

## Why the current state is still unsatisfying

### What improved

Current source already has useful pieces:

- a consistency-oriented replay harness in
  `services/torghut/scripts/search_consistent_profitability_frontier.py`;
- a strategy-factory validation layer in
  `services/torghut/app/trading/discovery/validation.py`;
- a sequential promotion helper in
  `services/torghut/app/trading/discovery/sequential_trials.py`;
- the promoted breakout-plus-washout catalog in
  `argocd/applications/torghut/strategy-configmap.yaml`;
- semantic indexing and synthesis persistence in
  `services/torghut/app/whitepapers/workflow.py` and
  `services/torghut/scripts/backfill_whitepaper_semantic_index.py`.

Those are real steps forward.

### What is still structurally wrong

The current system still has six major weaknesses.

#### 1. The search surface is still mostly code-first and sleeve-first

`services/torghut/app/trading/research_sleeves.py` remains a monolithic set of hand-authored sleeve evaluators.
Even when the harness scores them better, discovery is still downstream of manually written sleeve logic.

#### 2. The harness is still fundamentally a replayed parameter sweep

`services/torghut/scripts/search_consistent_profitability_frontier.py` improved the objective, but it still:

- enumerates parameter combinations from YAML;
- replays them directly;
- and ranks with a scalar penalty over ex-post metrics.

That is a better brute-force loop, not a mature discovery engine.

#### 3. The validation layer is still too proxy-heavy

`services/torghut/app/trading/discovery/validation.py` is currently:

- TSMOM-shaped,
- partially based on offline proxies,
- and still suppresses several strict Pyright diagnostics at the module level.

This means the current “strategy factory” exists, but it does not yet validate the broader family space with the
rigor implied by the design.

#### 4. Tape freshness is not yet a hard prerequisite for search

During the April 2026 investigation, the replay window stayed stale because `torghut-ws` was false-ready and
ClickHouse `PT1S` data did not advance to April 6. The current harness does not treat that as a hard contract
violation. It should.

If the expected trading day is missing, the system must block discovery or explicitly mark the run as `stale_tape`.
Anything else invites false confidence.

#### 5. “Consistent” is still encoded too weakly

The current harness penalizes:

- inactive days,
- negative days,
- worst day loss,
- drawdown,
- and best-day share.

That is directionally correct, but it still compresses all of that into one scalar penalty. The next system should
optimize a constrained multi-objective frontier rather than letting one giant day buy its way past other failures.

#### 6. Whitepapers are indexed, not operationalized

`services/torghut/app/whitepapers/workflow.py` can:

- store full text,
- chunk content,
- embed and search semantically,
- persist syntheses,
- and persist verdicts.

But it still does not compile papers into:

- testable claims,
- family templates,
- feature requirements,
- evaluation contracts,
- or contradiction graphs.

That means Torghut can search papers, but not yet run a disciplined research program from them.

## Design goals

1. make stale or incomplete tape a fail-closed condition for discovery;
2. rank candidate behavior across the full distribution of days, not only by aggregate PnL;
3. turn whitepaper research into structured claims with explicit support, conflict, and lineage;
4. make strategy discovery operate on families and templates rather than arbitrary threshold sweeps;
5. preserve replay realism and runtime compatibility;
6. let Torghut conclude that a family is not good enough and stop expanding it.

## Non-goals

1. unconstrained black-box search over arbitrary programs;
2. paper-triggered direct promotion into live capital;
3. “AI summary” whitepaper ingestion without explicit claim extraction;
4. treating reinforcement learning as the default next strategy family;
5. silently searching on stale market data.

## Research grounding from the last six months

The next iteration is anchored in recent papers that are directly relevant to the problems Torghut actually has.

### 1. Rigorous walk-forward honesty matters more than headline profitability

[Interpretable Hypothesis-Driven Trading](https://arxiv.org/abs/2512.12924) (December 15, 2025) argues for strict
information-set discipline, rolling walk-forward validation, realistic costs, and explicit interpretability. Its most
useful implication for Torghut is not that the reported returns are exciting; it is that the framework reports modest
results honestly and shows regime dependence clearly. Torghut’s next harness should adopt that honesty as a design
constraint rather than optimizing it away.

### 2. Feature normalization must match the execution mechanism

[Optimal Signal Extraction from Order Flow](https://arxiv.org/abs/2512.18648) (latest revision February 20, 2026)
shows that normalization should match the scaling behavior of the signal-generating process. For Torghut, this means
the strategy search space should include matched-filter variants of microstructure features instead of assuming one
normalization convention for every sleeve.

### 3. Dynamic eligibility and bounded tilts are more robust than unconstrained optimization

[Dynamic Inclusion and Bounded Multi-Factor Tilts](https://arxiv.org/abs/2601.05428) (January 8, 2026) emphasizes
dynamic asset eligibility, hard structural bounds, and robustness to estimation error. This is directly aligned with
what Torghut needs: family templates should specify eligibility logic and bounded exposure rules before replay.

### 4. Liquidity-aware portfolio construction belongs upstream in candidate generation

[Sharpe-Driven Stock Selection and Liquidity-Constrained Portfolio Optimization](https://arxiv.org/abs/2511.13251)
(November 17, 2025) reinforces that universe selection and liquidity constraints should be part of the candidate
definition rather than an afterthought. Torghut should compile liquidity assumptions into family templates and reject
families whose activity profile cannot support the desired daily notional.

### 5. Regime-aware portfolio construction should use structural state, not just raw performance splits

[Correlation Structures and Regime Shifts in Nordic Stock Markets](https://arxiv.org/abs/2601.06090) (December 31,
2025) uses correlation eigenstructure as a regime indicator and allocation guard. Torghut already has HMM and regime
machinery, but the next harness should score candidates by regime-conditioned contribution and regime-conditioned
failure, not just aggregate net PnL.

### 6. Scientific retrieval must be relation-aware, not just semantic

[SciNetBench](https://arxiv.org/abs/2601.03260) (December 16, 2025) shows that relation-aware retrieval materially
improves literature-review quality over content-only retrieval. This matters for Torghut because the current whitepaper
semantic index can answer “what sounds similar,” but not “what contradicts this claim,” “what extends it,” or “what
evidence chain supports it.”

### 7. Deep RL remains a weak default for this phase

[Risk-Aware Deep Reinforcement Learning for Dynamic Portfolio Optimization](https://arxiv.org/abs/2511.11481)
(November 14, 2025) is useful here mostly as a caution. It reports volatility stabilization but degraded risk-adjusted
returns under conservative convergence. The correct lesson for Torghut is that DRL is not the right default answer
while the system still lacks strong family templates, rigorous tape control, and claim-linked evaluation.

## Design principles

1. **No stale tape, no search.**
2. **No scalar leaderboard without constraint witnesses.**
3. **No whitepaper claim without structured lineage and contradiction context.**
4. **No family promotion without day-level and regime-level decomposition.**
5. **No new strategy family without an explicit economic mechanism.**

## Proposed architecture

### 1. Harness v2: authoritative replay and distribution-aware scoring

### 1.1 Tape authority layer

Add a dedicated tape authority contract ahead of all discovery runs.

Required inputs:

- ClickHouse latest day and row counts by source/window;
- Kafka topic freshness witnesses;
- websocket freshness witness;
- TA materialization freshness witness;
- expected trading-day calendar.

Required output:

`dataset_snapshot_receipt.json`

Fields:

- `snapshot_id`
- `source`
- `window_size`
- `start_day`
- `end_day`
- `expected_last_trading_day`
- `is_fresh`
- `missing_days`
- `row_count`
- `witnesses`

Hard rule:

- if `expected_last_trading_day > end_day`, the harness must either:
  - block the run with `stale_tape`, or
  - require an explicit `allow_stale_tape=true` override that is persisted in the run ledger.

This is the direct fix for the April 6, 2026 false-ready data incident.

### 1.2 Replay-once, score-many

Harness v2 should stop re-querying raw rows candidate-by-candidate when the dataset window is fixed.

Instead:

1. build one snapshot receipt;
2. materialize one immutable replay rowset;
3. replay candidates against that in-memory or archived snapshot;
4. persist one `dataset_snapshot_id` on every candidate attempt.

The system already has part of this in the cached-row patching logic inside
`services/torghut/scripts/search_consistent_profitability_frontier.py`. Harness v2 should elevate that from an
optional optimization to the default execution model.

### 1.3 Multi-objective candidate scorecard

Replace the current scalar consistency penalty with a constrained frontier and dominance ranking.

Candidate scorecards must include:

- `net_pnl_per_day`
- `active_day_ratio`
- `positive_day_ratio`
- `avg_filled_notional_per_day`
- `avg_filled_notional_per_active_day`
- `worst_day_loss`
- `max_drawdown`
- `best_day_share`
- `negative_day_count`
- `rolling_3d_lower_bound`
- `rolling_5d_lower_bound`
- `regime_slice_pass_rate`
- `symbol_concentration_share`
- `entry_family_contribution_share`

Selection rule:

1. first apply hard vetoes;
2. then compute Pareto dominance over the surviving objective vector;
3. only then use a tie-breaker score.

This prevents one massive day from compensating for structurally bad day coverage.

### 1.4 Required vetoes

Before ranking, a candidate must fail closed if any of the following is true:

- `active_day_ratio < required_min_active_day_ratio`
- `avg_filled_notional_per_day < required_min_daily_notional`
- `best_day_share > required_max_best_day_share`
- `worst_day_loss > required_max_worst_day_loss`
- `max_drawdown > required_max_drawdown`
- `regime_slice_pass_rate < required_min_regime_slice_pass_rate`
- `dataset_snapshot_receipt.is_fresh == false` and no explicit stale override exists

### 1.5 Decomposition-first diagnostics

Every replay result must decompose by:

- day,
- symbol,
- strategy family,
- entry motif,
- regime slice,
- and normalization regime.

The current harness already computes daily and symbol-level contributions. Harness v2 should make those decompositions
mandatory artifacts and use them for:

- pruning,
- regime veto construction,
- and paper-claim attribution.

### 2. Strategy discovery v2: family templates instead of raw sleeve sweeps

### 2.1 Family template registry

Introduce a first-class family template layer between whitepaper claims and replay configs.

Each family template should declare:

- `family_id`
- `economic_mechanism`
- `supported_markets`
- `required_features`
- `allowed_normalizations`
- `entry_motifs`
- `exit_motifs`
- `risk_controls`
- `activity_model`
- `liquidity_assumptions`
- `regime_activation_rules`
- `day_veto_rules`

Examples for the immediate Torghut context:

- `breakout_reclaim_v2`
- `washout_rebound_v2`
- `opening_drive_leader_reclaim_v1`
- `microstructure_continuation_matched_filter_v1`

### 2.2 Matched-filter feature variants

Based on the matched-filter order-flow paper, the discovery engine should stop assuming one normalization scheme.

For any family using flow or microstructure features, the template must explicitly enumerate candidate feature families
such as:

- `price_scaled`
- `shares_scaled`
- `trading_value_scaled`
- `market_cap_scaled`
- `opening_window_scaled`

These become structured family branches rather than ad-hoc code edits.

### 2.3 Day-veto and regime-veto controllers

The current discovery loop proved that “bad days” matter more than another notch of leverage.

Therefore each family template should support a companion veto controller with:

- market-breadth vetoes,
- quote-quality vetoes,
- volatility-shock vetoes,
- correlation-stress vetoes,
- and symbol-specific vetoes.

The family and veto controller are evaluated jointly, not independently.

### 2.4 Contribution-aware search, not only parameter grids

The next search loop should have three search modes:

1. **template parameter search**
2. **attribution-guided pruning**
3. **controller synthesis**

The current contribution-aware pruning in
`services/torghut/scripts/search_consistent_profitability_frontier.py` should become one stage inside a larger search
program, not the whole search story.

### 2.5 Required family-level honesty checks

A family cannot be called “good” if:

- one day contributes more than a configured share of total PnL;
- one symbol contributes more than a configured share of total PnL;
- activity depends on fewer than a configured number of trading days;
- profits vanish when the controller is frozen on a prior subwindow.

### 3. Whitepaper Research Factory: from chunks to claim programs

### 3.1 Problem statement

Today Torghut can ingest and semantically search papers, but it still does not turn them into research programs with
operational structure.

That is the central change in this document.

### 3.2 New whitepaper outputs

Add structured outputs on top of the existing workflow:

- `whitepaper_claims`
- `whitepaper_claim_relations`
- `whitepaper_strategy_templates`
- `whitepaper_experiment_specs`
- `whitepaper_contradiction_events`

Each extracted claim must include:

- `claim_id`
- `paper_run_id`
- `claim_type`
  - `signal_mechanism`
  - `normalization_rule`
  - `regime_condition`
  - `risk_control`
  - `execution_constraint`
  - `portfolio_construction_rule`
  - `negative_result`
- `asset_scope`
- `horizon_scope`
- `data_requirements`
- `expected_direction`
- `required_activity_conditions`
- `liquidity_constraints`
- `validation_notes`
- `confidence`

### 3.3 Relation-aware retrieval

Augment semantic search with explicit relation search:

- supporting papers
- contradicting papers
- extension papers
- lineage predecessors
- similar-mechanism but different-market papers

This is the design response to SciNetBench: Torghut needs research retrieval that understands scientific relations,
not just vector proximity.

### 3.4 Claim-to-template compilation

A whitepaper should not directly generate code. It should generate a research object.

Compilation steps:

1. extract claim cards;
2. map claims to one or more family templates;
3. generate an `experiment_spec`;
4. attach required features and invalidation clauses;
5. submit into the discovery queue.

Example:

- paper claim:
  - “normalization should match execution mechanism”
- compiled experiment:
  - run `microstructure_continuation_matched_filter_v1`
  - compare `trading_value_scaled` vs `market_cap_scaled`
  - require minimum activity threshold
  - segment by liquidity regime and information-arrival regime

### 3.5 Contradiction tracking

If a new paper conflicts with an older claim already linked to a live or canary family, Torghut should emit a
`whitepaper_contradiction_event` and enqueue a revalidation task.

That is how papers affect live discovery safely:

- not by direct promotion,
- but by forcing a new experiment or invalidation review.

### 3.6 Negative-result handling

Whitepaper and internal research should both be allowed to emit negative claims:

- “works only under elevated information arrival”
- “fails after conservative cost model”
- “stabilizes volatility but degrades risk-adjusted return”

Negative claims are valuable because they shrink the search space and prevent repeated rediscovery of bad ideas.

### 4. Unified experiment contract

Every discovery run should be created from one `experiment_spec`.

Required sections:

- `dataset_snapshot_policy`
- `family_template_id`
- `template_overrides`
- `feature_variants`
- `veto_controller_variants`
- `selection_objectives`
- `hard_vetoes`
- `paper_claim_links`
- `expected_failure_modes`
- `promotion_contract`

That contract becomes the join key across:

- paper research,
- replay harness,
- strategy factory,
- and promotion evidence.

### 5. Concrete implementation plan

### Phase 1: Harness v2 data authority

Add:

- `services/torghut/app/trading/discovery/dataset_snapshot.py`
- `services/torghut/app/trading/discovery/objectives.py`
- `services/torghut/app/trading/discovery/decomposition.py`

Extend:

- `services/torghut/scripts/search_consistent_profitability_frontier.py`
- `services/torghut/scripts/local_intraday_tsmom_replay.py`

Main outputs:

- dataset snapshot receipts
- mandatory fresh/stale gating
- constrained multi-objective ranking

### Phase 2: Family template registry

Add:

- `services/torghut/app/trading/discovery/family_templates.py`
- `services/torghut/config/trading/families/*.yaml`

Refactor:

- `services/torghut/app/trading/research_sleeves.py`

Target:

- move strategy shape out of the monolith and into template contracts with smaller evaluation primitives.

### Phase 3: Whitepaper claim graph

Add:

- `whitepaper_claims`
- `whitepaper_claim_relations`
- `whitepaper_experiment_specs`

Extend:

- `services/torghut/app/whitepapers/workflow.py`
- `services/torghut/scripts/backfill_whitepaper_semantic_index.py`

Target:

- convert chunked paper text into machine-actionable claims and experiments.

### Phase 4: Strategy discovery v2 runner

Add:

- `services/torghut/scripts/run_strategy_factory_v2.py`

This runner should:

- load claim-linked experiment specs,
- resolve dataset snapshot policy,
- enumerate family-template branches,
- run replay-once/cache-many evaluation,
- and persist decomposition-first candidate artifacts.

### Phase 5: Promotion integration

Extend:

- `services/torghut/app/trading/discovery/validation.py`
- `services/torghut/app/trading/discovery/sequential_trials.py`
- `services/torghut/app/trading/portfolio.py`

Target:

- promote only candidates that satisfy distribution-aware objectives and paper-linked invalidation review.

### 6. Success criteria

The next iteration is successful only if it produces the following behavior:

1. a stale tape blocks discovery automatically;
2. replay artifacts expose day, symbol, regime, and family contributions by default;
3. a family can clear the target only if it also clears activity, notional, and concentration constraints;
4. whitepapers create experiment specs and contradiction events, not only searchable chunks;
5. Torghut can reject an attractive aggregate-PnL candidate because the day distribution is bad.

### 7. Kill criteria

Stop expansion of this program if any of the following happens:

1. the whitepaper claim graph produces mostly low-confidence or low-utility experiment specs;
2. the family template registry becomes a disguised threshold soup with no economic mechanism;
3. the new multi-objective frontier still promotes one-day lottery winners;
4. the tape authority layer is repeatedly bypassed for convenience;
5. the new system cannot beat the current promoted composite on both honesty and reproducibility.

### References

Recent primary sources:

- [Interpretable Hypothesis-Driven Trading: A Rigorous Walk-Forward Validation Framework for Market Microstructure Signals](https://arxiv.org/abs/2512.12924)
- [Optimal Signal Extraction from Order Flow: A Matched Filter Perspective on Normalization and Market Microstructure](https://arxiv.org/abs/2512.18648)
- [Dynamic Inclusion and Bounded Multi-Factor Tilts for Robust Portfolio Construction](https://arxiv.org/abs/2601.05428)
- [Sharpe-Driven Stock Selection and Liquidity-Constrained Portfolio Optimization: Evidence from the Chinese Equity Market](https://arxiv.org/abs/2511.13251)
- [Correlation Structures and Regime Shifts in Nordic Stock Markets](https://arxiv.org/abs/2601.06090)
- [SciNetBench: A Relation-Aware Benchmark for Scientific Literature Retrieval Agents](https://arxiv.org/abs/2601.03260)
- [Risk-Aware Deep Reinforcement Learning for Dynamic Portfolio Optimization](https://arxiv.org/abs/2511.11481)

Foundational references retained from the previous strategy-factory design:

- [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
- [Deflated Sharpe Ratio papers directory](https://www.davidhbailey.com/dhbpapers)
- [Time-uniform, nonparametric, nonasymptotic confidence sequences](https://arxiv.org/abs/1810.08240)
- [Syntax-Guided Synthesis](https://sygus.org)
