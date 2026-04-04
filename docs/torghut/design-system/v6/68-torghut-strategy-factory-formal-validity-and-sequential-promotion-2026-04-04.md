# 68. Torghut Strategy Factory, Formal Validity, and Sequential Promotion (2026-04-04)

Status: Proposed (`design`)
Date: `2026-04-04`
Owner: Codex (repository-local design draft)
Scope: Replace heuristic strategy discovery with an offline strategy factory that uses constrained synthesis, formal
validity checks, robust statistical ranking, and sequential promotion before capital reaches the live allocator.

Extends:

- `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`
- `docs/torghut/design-system/v6/64-torghut-hypothesis-vaults-and-post-cost-profit-tapes-contract-2026-03-21.md`
- `docs/torghut/design-system/v6/67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md`

## Executive summary

Torghut has become stronger at gating, evidence packaging, and capital safety than it is at generating good strategies.
That is the wrong asymmetry.

The current architecture already knows how to:

- persist research runs, candidates, fold metrics, stress metrics, and promotion records;
- gate capital based on post-cost evidence and freshness;
- route deterministic forecasts into runtime decisions; and
- keep live submission fail-closed.

But the current discovery path is still weak:

- `services/torghut/app/trading/research_sleeves.py` is hand-authored sleeve logic, not a discovery engine.
- `services/torghut/app/trading/evaluation.py` runs walk-forward folds, but it is still mostly a replay harness rather
  than a multiple-testing-aware research validator.
- `services/torghut/app/trading/empirical_manifest.py` validates artifact presence and shape, but not enough of the
  statistical substance behind a candidate.

The design decision in this document is to stop treating discovery as a side effect of the trading service.

Instead, Torghut should adopt a dedicated **Strategy Factory**:

1. generate only constrained, economically interpretable candidate families;
2. prove implementation-level validity before backtesting;
3. rank candidates with robust post-cost statistics rather than raw in-sample performance;
4. promote candidates through sequential evidence in paper and bounded live canary windows;
5. feed only approved posterior edge estimates into the existing Torghut hypothesis governor and capital allocator.

This is the architecture I would be happy with because it uses math where math is actually strong:

- formal validity for correctness and leakage prevention;
- statistical validity for falsification and selection-bias control;
- sequential validity for real-time promotion decisions;
- portfolio math for capital sizing after costs.

It does **not** pretend that mathematics can prove future profitability in an open market.

This proposal also adopts five hard constraints that were missing from the weaker draft:

- every attempted candidate must be ledgered, including failures and manual variants;
- the strategy language must have an explicit out-of-grammar challenge lane;
- cost models must be continuously calibrated against realized TCA;
- candidates must declare regime envelopes and invalidation clauses;
- the whole program must start as a narrow pilot with explicit kill criteria.

## Why the current state is unsatisfying

### What is already good

Torghut already has useful research and governance scaffolding:

- research persistence:
  - `ResearchRun`, `ResearchCandidate`, `ResearchFoldMetrics`, `ResearchStressMetrics`, and `ResearchPromotion` in
    `services/torghut/app/models/entities.py`
- promotion and capital governance:
  - hypothesis capital staging in `services/torghut/app/trading/hypotheses.py`
  - live-submission gate assembly in `services/torghut/app/trading/submission_council.py`
  - lane-aware capital allocation scaffolding in `services/torghut/app/trading/portfolio.py`
- execution realism:
  - TCA and shortfall metrics in `services/torghut/app/trading/tca.py`
- runtime consumption:
  - forecast contracts embedded into decisions in `services/torghut/app/trading/decisions.py`

### What is still poor

The discovery core remains too heuristic and too optimistic:

1. the search space is not governed by a disciplined strategy language;
2. candidates are not eliminated early enough for leakage, redundancy, or economic incoherence;
3. ranking remains too close to "best replay result wins";
4. promotion evidence is more mature than candidate generation;
5. the runtime is carrying too much discovery responsibility.

This produces the worst possible operating pattern:

- many mediocre candidates,
- weak statistical differentiation,
- high governance overhead,
- low trust in research outputs.

## Goals

1. make candidate generation small, interpretable, and falsifiable;
2. fail bad candidates before expensive replay whenever possible;
3. make overfitting visible and first-class in the research ledger;
4. make post-cost expectancy, not backtest beauty, the primary ranking target;
5. make live progression sequential and anytime-safe rather than threshold-and-hope;
6. preserve Torghut's current runtime safety model and capital governor.
7. allow the system to conclude that no durable edge exists and stop cleanly.

## Non-goals

1. fully formal proof that a strategy will be profitable in the future;
2. unconstrained search over arbitrary expression trees or black-box RL policies;
3. replacing Torghut's live runtime with a research engine;
4. moving capital authority from Torghut into Jangar;
5. adding another LLM-first discovery lane with weak statistical discipline.
6. building a large platform before one narrow family proves it can beat the incumbent process.

## Research grounding

This architecture is grounded in five external ideas that fit the Torghut problem well.

### 1. Backtest overfitting is the default failure mode when many variants are tried

Bailey, Borwein, Lopez de Prado, and Zhu define the Probability of Backtest Overfitting (PBO) and propose
Combinatorially Symmetric Cross-Validation (CSCV) to estimate how often the in-sample winner underperforms
out-of-sample. The practical implication for Torghut is direct: the research system must estimate whether the selected
candidate is likely to be a data-mined winner rather than a durable edge.

### 2. Selection bias and non-normal returns inflate Sharpe-based ranking

Bailey and Lopez de Prado's Deflated Sharpe Ratio (DSR) adjusts the observed Sharpe ratio for selection bias,
non-normality, and repeated trials. Torghut should not promote candidates on naive Sharpe or raw net PnL leaderboards.

### 3. Strategy rules should be derived with structure, not only brute-force backtests

Carr and Lopez de Prado show that some trading-rule optimization can be framed without brute-force backtesting of every
configuration. The lesson is not "never backtest"; it is that the search should be constrained by model structure and
economic assumptions before replay is allowed to spend compute.

### 4. Constrained synthesis is a better generator than open-ended heuristic soup

Syntax-guided and counterexample-guided synthesis work shows that search becomes tractable when the language of valid
programs is explicit. Torghut should search over a grammar of valid strategy forms rather than arbitrary threshold
combinations.

### 5. Promotion should be sequentially valid, not fixed-horizon wishful thinking

Confidence sequences and related sequential methods provide time-uniform error control as evidence arrives. Torghut's
paper-canary and live-canary progression should rely on sequential evidence rather than a single fixed evaluation
window that invites repeated peeking.

## Decision

Adopt a **Torghut Strategy Factory** that sits offline from the trading service and outputs only:

- formally valid candidate specifications,
- robust statistical evidence bundles,
- sequential promotion state,
- posterior post-cost edge estimates,
- and bounded capital bid inputs for the existing hypothesis governor and allocator.

The trading service remains the execution and capital authority. The strategy factory becomes the discovery and
falsification authority.

## Proposed architecture

### 1. Split the system into four layers

#### Layer A: Strategy Language

Define a small canonical strategy DSL with the following components:

- universe selector
- entry predicate
- exit predicate
- position direction policy
- horizon / timeout policy
- risk stop policy
- capacity assumptions
- regime applicability
- required feature contract
- execution assumptions

The DSL must be:

- canonicalizable into a stable JSON form;
- hashable by semantics, not just text;
- restricted to economically interpretable primitives;
- compilable into the existing Torghut runtime decision interfaces.

Examples of primitives:

- breakout above opening range high with spread and participation constraints
- continuation after momentum confirmation with quote-quality guard
- mean reversion after volatility spike with bounded holding horizon
- regime-conditioned sleeves that explicitly declare when they are inactive

This replaces open-ended threshold soup with a limited hypothesis class.

#### Layer A1: Challenge lane for out-of-grammar ideas

The DSL must not silently become the definition of all possible alpha.

Add a bounded `challenge` lane for ideas that do not fit the grammar:

- requires a human-authored economic validity card;
- must still pass provenance and timestamp checks;
- uses its own search budget and leaderboard;
- cannot become capital-eligible until it is either translated into a canonical family or survives one full validation
  cycle with explicit operator approval.

This keeps the main system tractable without confusing tractability for completeness.

##### Challenge-lane operating workflow

The challenge lane must be operationally real, not just a policy escape hatch.

Required workflow:

1. intake:
   - submit `economic-validity-card-v1.json`
   - declare why the idea cannot be represented in the current DSL
   - declare the minimum extension needed to represent it canonically
2. bounded sandbox:
   - candidate may consume only a fixed challenge budget
   - all attempts still land in `research_attempts`
   - candidate cannot consume shared live-promotion capacity
3. translation checkpoint:
   - if the idea survives first validation, the team must either:
     - add a canonical family to the DSL, or
     - explicitly approve one more challenge cycle with justification
4. expiry:
   - challenge-lane candidates expire after a bounded number of cycles if they are not canonicalized
   - expired challenge-lane ideas remain searchable in the ledger but cannot re-enter promotion without a fresh intake

This prevents the challenge lane from becoming an unbounded side door around the DSL.

#### Layer B: Formal Validity Engine

Before replay, every candidate must pass a static validity pass:

- no lookahead: candidate references only features available at decision time;
- no forbidden fields: candidate cannot read realized future prices, later bars, or post-execution outcomes;
- monotone risk constraints: loosening risk parameters cannot make the candidate safer on paper than in runtime;
- finite-action semantics: candidate always yields one of `{buy, sell, hold}` under valid inputs;
- runtime compatibility: candidate can compile into the Torghut feature/runtime contract;
- resource boundedness: candidate complexity stays within a configured node and feature budget.

This pass may be implemented by a mix of:

- AST validation,
- schema/type checking,
- symbolic checks over feature timestamps and field provenance,
- and counterexample-driven simplification for invalid candidates.

The output is a `formal_validity_bundle` with:

- `spec_hash`
- `semantic_hash`
- `proof_status`
- `reason_codes`
- `counterexamples[]`
- `required_features[]`
- `forbidden_features[]`
- `complexity_score`

Candidates that fail here never consume replay budget.

#### Layer B1: Economic validity card

Formal validity is necessary but not sufficient. Every candidate must also declare:

- the economic mechanism it claims to exploit;
- the market structure assumptions it depends on;
- why the effect should persist long enough to matter;
- what conditions invalidate the mechanism;
- and which observable diagnostics imply the mechanism is weakening.

Required artifact:

- `economic-validity-card-v1.json`

Candidates without this card may be explored in sandbox mode but may not enter promotion.

#### Layer C: Research and Ranking Engine

The research engine runs only on formally valid candidates and must evaluate them in this order:

1. cheap dominance pruning
2. purged / embargoed walk-forward replay
3. CSCV / PBO estimation
4. DSR and related selection-bias adjustment
5. cost-aware stress tests
6. posterior edge estimation
7. benchmark and null-model comparison

The ranking objective is not raw net PnL. It is:

`posterior_expected_edge_after_cost * robustness_multiplier * capacity_multiplier`

where:

- `posterior_expected_edge_after_cost` shrinks noisy estimates toward zero;
- `robustness_multiplier` penalizes high PBO, weak DSR, split instability, and stress brittleness;
- `capacity_multiplier` penalizes turnover, spread sensitivity, and market-impact vulnerability.

The ranking engine must also compare each candidate against:

- naive null families;
- incumbent production sleeves;
- random or permuted controls where appropriate;
- and a do-nothing baseline.

If a candidate cannot beat those comparators after costs and bias correction, it should not enter sequential
promotion.

#### Layer D: Sequential Promotion Engine

Promotion is no longer decided by one replay closeout.

Each promoted candidate enters:

1. `paper_shadow`
2. `paper_canary`
3. `live_probe`
4. `live_canary`
5. `allocator_eligible`

Progression requires sequential evidence with time-uniform control:

- posterior edge remains positive after costs,
- realized slippage stays within modeled bounds,
- calibration error remains bounded,
- drift / contamination monitors stay green,
- and confidence sequence lower bounds do not cross zero for the required metric bundle.

The key operational rule:

- repeated checking is allowed;
- capital does not widen until the sequential criterion passes;
- any persistent breach demotes the candidate without needing a new fixed-horizon study.

Sequential promotion must also include explicit invalidation semantics:

- each candidate declares `valid_regime_envelope`;
- each candidate declares `invalidation_clauses[]`;
- promotion pauses automatically when recent observations fall outside the declared envelope or when invalidation
  clauses trigger repeatedly.

This does not eliminate regime change risk. It makes regime mismatch explicit and auditable.

#### Layer D1: Sequential metric contract

Sequential promotion only works if the monitored statistic is fixed in advance.

Each candidate family must declare a preregistered `sequential-metric-contract-v1`:

- `primary_metric`
- `secondary_guard_metrics[]`
- `update_cadence`
- `minimum_sample_unit`
- `confidence_sequence_family`
- `promotion_threshold`
- `demotion_threshold`
- `max_peek_interval`
- `reset_conditions[]`

Rules:

- the primary metric cannot change mid-trial;
- threshold changes require a new trial id and restart;
- adding a new guard metric mid-trial is allowed only if it is strictly more conservative and is recorded as a trial
  amendment;
- dropping a guard metric mid-trial is not allowed;
- family defaults may exist, but every candidate must bind to one concrete contract version before paper-canary starts.

This removes the biggest source of sequential-testing abuse: moving the goalposts while pretending the test is fixed.

### 2. Candidate generation model

The strategy factory should use three generator classes, in descending priority.

#### Class A: economic templates

Human-authored, strongly opinionated families:

- opening-range continuation
- intraday mean reversion
- trend continuation
- liquidity / imbalance reversion
- regime-conditioned hybrid sleeves

These are the preferred source because they keep the search close to known economic mechanisms.

#### Class B: constrained symbolic synthesis

Search over the DSL using:

- bounded node count,
- bounded feature set,
- bounded predicate depth,
- canonical simplification,
- equivalence pruning,
- and explicit regime declarations.

This generator is allowed to discover novel combinations, but only inside the grammar.

#### Class C: parameter refinement

Once a family is valid, refine only a small set of parameters:

- thresholds,
- holding windows,
- stop widths,
- participation ceilings,
- regime routing values.

This is the only place where broad parameter search is allowed, and it remains inside a known family.

Torghut should not search arbitrary black-box policies as a default path.

### 2.1 Search accounting and attempt completeness

Research integrity depends on complete accounting of what was tried.

The strategy factory must record **every** attempted candidate, including:

- candidates rejected by static validity;
- candidates pruned as duplicates or dominated variants;
- challenge-lane candidates;
- manual candidate patches;
- and candidates that never reached replay.

Add an attempt ledger:

- `research_attempts`
  - `attempt_id`
  - `run_id`
  - `candidate_hash`
  - `generator_family`
  - `attempt_stage`
  - `status`
  - `reason_codes`
  - `artifact_ref`
  - `created_at`

Promotion and leaderboard logic may only consume candidates whose full attempt lineage is present. Unledgered research
is not promotable.

### 3. Robust validation contract

Each candidate must produce the following additive artifact set:

- `candidate-spec-v1.json`
- `formal-validity-bundle-v1.json`
- `purged-walkforward-report-v1.json`
- `cscv-pbo-report-v1.json`
- `deflated-sharpe-report-v1.json`
- `execution-reality-report-v1.json`
- `posterior-edge-report-v1.json`
- `promotion-readiness-report-v1.json`

#### Minimum required metrics

- out-of-sample decision count
- out-of-sample trade count
- gross and net PnL
- turnover
- capacity estimate
- realized cost assumptions
- PBO
- DSR
- probability edge <= 0 after cost
- fold instability
- stress-case pessimistic delta
- expected shortfall coverage
- TCA divergence estimate

#### Hard fail conditions

1. formal validity failure
2. missing feature provenance or timestamp proof
3. PBO above configured threshold
4. DSR below configured threshold
5. posterior probability of non-positive edge above configured threshold
6. positive gross edge turning non-positive after realistic cost assumptions
7. stress-case collapse beyond allowed drawdown or edge degradation
8. missing sequential promotion contract
9. inability to beat declared null and incumbent baselines
10. missing or contradictory economic validity card

### 4. Runtime integration with existing Torghut

The runtime should consume strategy-factory outputs through the current research and promotion path rather than inventing
another promotion system.

#### What stays

- `research_runs`
- `research_candidates`
- `research_fold_metrics`
- `research_stress_metrics`
- `research_promotions`
- hypothesis staging in `hypotheses.py`
- live submission gating in `submission_council.py`
- capital allocation in `portfolio.py`

#### What changes

- `research_sleeves.py` becomes a library of curated runtime sleeves, not the discovery engine;
- `evaluation.py` becomes a replay primitive that the strategy factory orchestrates, rather than the full validation
  story by itself;
- promotion decisions require statistical and sequential evidence, not just artifact presence;
- the allocator receives posterior edge and sequential state, not just regime and fragility multipliers.
- challenge-lane candidates remain visible in the ledger but cannot directly become capital-eligible without explicit
  canonicalization or operator-approved exception handling.

### 5. Data model changes

Reuse the existing research ledger and add the missing research truth instead of building a separate parallel store.

#### Extend `research_runs`

Additive fields:

- `discovery_mode`
- `generator_family`
- `grammar_version`
- `search_budget`
- `selection_protocol_version`
- `pilot_program_id`
- `kill_criteria_version`

#### Extend `research_candidates`

Additive fields:

- `candidate_family`
- `canonical_spec`
- `semantic_hash`
- `economic_rationale`
- `complexity_score`
- `discovery_rank`
- `posterior_edge_summary`
- `economic_validity_card`
- `valid_regime_envelope`
- `invalidation_clauses`
- `null_comparator_summary`

#### Extend `research_fold_metrics`

Additive fields:

- `stat_bundle`
- `purge_window`
- `embargo_window`
- `feature_availability_hash`

#### Add `research_validation_tests`

One row per candidate per validation battery:

- `candidate_id`
- `test_name`
- `status`
- `metric_bundle`
- `artifact_ref`
- `computed_at`

Expected tests:

- `formal_validity`
- `cscv_pbo`
- `deflated_sharpe`
- `selection_bias_adjustment`
- `execution_reality`
- `posterior_edge`
- `baseline_comparison`
- `economic_validity`

#### Add `research_sequential_trials`

One row per candidate per promotion lane:

- `candidate_id`
- `trial_stage`
- `account`
- `start_at`
- `last_update_at`
- `sample_count`
- `confidence_sequence_lower`
- `confidence_sequence_upper`
- `posterior_edge_mean`
- `posterior_edge_lower`
- `status`
- `reason_codes`

This table is the missing bridge between offline research and live capital eligibility.

#### Add `research_cost_calibrations`

One row per scope-specific cost-model refresh:

- `calibration_id`
- `scope_type`
- `scope_id`
- `window_start`
- `window_end`
- `modeled_slippage_bps`
- `realized_slippage_bps`
- `modeled_shortfall_bps`
- `realized_shortfall_bps`
- `calibration_error_bundle`
- `status`
- `computed_at`

This prevents a stale or optimistic cost model from quietly retaining authority.

##### Cost-calibration governance rules

Cost calibration must itself be governed.

Live capital eligibility requires:

- a calibration record whose scope matches the candidate family or a stricter parent scope;
- a calibration window recent enough for the target market regime;
- explicit upper bounds on modeled-versus-realized divergence;
- and a non-stale status in `research_cost_calibrations`.

If these conditions fail:

- paper trials may continue;
- live widening is blocked;
- and capital bids must downgrade to `paper_only` or `observe_only`.

Additional rules:

- cost-calibration models are versioned artifacts;
- changing the calibration model invalidates existing live-widening authority until the new model is itself calibrated;
- and the allocator must record which calibration record governed each approved bid.

### 6. Capital and promotion contract

The strategy factory does not directly allocate capital.

It emits a `candidate capital bid`:

- `candidate_id`
- `hypothesis_id`
- `posterior_edge_bps_after_cost`
- `edge_uncertainty_bps`
- `capacity_score`
- `robustness_score`
- `sequential_state`
- `max_allowed_capital_stage`
- `expires_at`

The existing Torghut hypothesis governor and profit-clock / auction logic then remain the only components allowed to:

- translate bid quality into capital stage,
- combine it with freshness and dependency evidence,
- and approve live execution.

This keeps the live engine disciplined while letting discovery become much stronger.

Capital bids must be pessimistic with respect to cost-model trust:

- if realized TCA shows the cost model is stale or optimistic, bid size is clipped using the worse of modeled and
  realized costs;
- if no valid calibration exists for the target scope, the candidate may remain paper-eligible but is not
  capital-eligible for live widening.

### 7. Ranking policy

The final candidate ranking policy should optimize for deployable edge, not replay heroics.

Suggested primary ranking score:

`rank_score = edge_lower_bound_bps_after_cost * robustness_score * capacity_score * implementation_score`

where:

- `edge_lower_bound_bps_after_cost` is a conservative lower bound, not the mean;
- `robustness_score` falls with PBO, weak DSR, instability, and stress fragility;
- `capacity_score` falls with turnover, spread sensitivity, and market impact;
- `implementation_score` falls with complexity and runtime fragility.

This will rank simpler, more durable candidates above noisy backtest winners.

To avoid false precision:

- every score component must be stored separately, not only as one scalar;
- operator payloads must show raw metrics, lower bounds, and dominant penalties;
- the final ranking must be reproducible from persisted artifacts without hidden weights.

### 8. What "proof" means in this system

The term "proof" must be narrowed so the architecture stays honest.

#### Proved

- candidate obeys the strategy DSL
- candidate does not leak future information
- candidate compiles into the runtime safely
- candidate passed configured statistical and sequential gates
- candidate has bounded post-cost edge under stated assumptions

#### Not proved

- future market profitability
- regime permanence
- broker/exchange invariance
- absence of model decay

The correct user-facing wording is:

- `formally valid`
- `statistically robust`
- `promotion eligible`
- `capital eligible`

not "mathematically guaranteed profitable."

## Pilot-first delivery rule

This architecture is only acceptable if it proves itself cheaply.

The first implementation must be limited to:

- one strategy family;
- one dataset slice;
- one purged / embargoed replay battery;
- one sequential paper-canary path;
- one allocator integration path;
- and one explicit incumbent baseline for comparison.

### Pilot success criteria

1. top candidates are materially fewer and more interpretable than the current discovery output;
2. the overfit rejection rate increases without collapsing all candidates;
3. at least one promoted candidate beats the incumbent baseline after costs in paper canary;
4. cost-model calibration error remains within the configured trust budget;
5. operator review time per candidate decreases.

### Pilot kill criteria

Stop the broader program if any of these hold after the pilot window:

1. candidate quality does not improve relative to the incumbent heuristic process;
2. the DSL excludes too many promising challenge-lane ideas and cannot be extended cleanly;
3. cost-model calibration remains too unstable for capital bidding;
4. sequential promotion adds churn without improving paper-to-live survival;
5. the system still produces mostly low-signal ideas despite stronger validation.

If the pilot fails, Torghut should not continue building the platform. It should revert to narrower human-led
research.

### Expansion gate after the pilot

Even a successful pilot is not enough to justify a platform rollout.

Expansion from one family to multiple families requires:

1. two consecutive pilot windows where the new process beats the incumbent baseline after costs;
2. stable cost-calibration quality across both windows;
3. no unresolved challenge-lane backlog caused by grammar gaps in the pilot family;
4. operator evidence that review burden did not increase materially;
5. a written post-pilot closeout that names which parts of the architecture were actually necessary.

This rule exists to stop the team from treating one encouraging pilot as proof that the full platform is justified.

## Implementation plan

### Phase 1: Strategy language and formal validity

Create a new offline package under `services/torghut/app/trading/discovery/`:

- `dsl.py`
- `canonicalize.py`
- `validity.py`
- `generator.py`
- `dominance.py`

Acceptance gates:

- candidate canonicalization stable across runs
- no-lookahead violations caught by tests
- equivalent candidates collapse to one semantic hash
- challenge-lane submissions either canonicalize or expire on schedule

### Phase 2: robust validation battery

Extend the replay path:

- orchestrate `evaluation.py` from the discovery engine
- emit purged and embargoed split artifacts
- add PBO and DSR reports
- add posterior edge report and ranking score

Acceptance gates:

- research ledger contains both candidate and statistical evidence
- ranking is reproducible for fixed data and search budget
- a deliberately overfit candidate fails with explicit reasons
- null and incumbent baselines are present for every promotable candidate

### Phase 3: sequential promotion

Create:

- `sequential_trials.py`
- `promotion_monitor.py`

Wire paper and bounded live stages to sequential evidence.

Acceptance gates:

- repeated peeking does not widen capital without passing the sequential rule
- deteriorating candidates auto-demote with explicit evidence
- allocator sees only candidates whose trial stage permits capital
- metric-contract changes force a new trial id instead of mutating a running trial

### Phase 4: allocator integration

Teach `portfolio.py` and the profit-clock auction path to consume:

- posterior edge lower bound
- robustness score
- sequential state
- capacity bid

Acceptance gates:

- two approved candidates with different uncertainty profiles receive different approved notionals
- weak but flashy candidates lose to stronger lower-bound candidates
- stale sequential evidence clamps bid validity
- stale or untrusted cost calibration clamps live widening even when paper evidence is positive

## Validation strategy

### Unit tests

- DSL parser and canonicalizer
- no-lookahead and provenance validator
- semantic hash stability
- dominance pruning
- sequential update math
- metric-contract freeze and restart rules
- cost-calibration downgrade rules

### Property / stateful tests

- candidate simplification preserves semantics
- equivalent strategies map to the same semantic hash
- forbidden feature access is always rejected
- sequential promotion never widens capital after negative evidence

### Integration tests

- end-to-end candidate discovery on a fixed dataset snapshot
- overfit candidate rejected by PBO / DSR gate
- clean candidate progresses to sequential paper trial
- allocator consumes posterior bid summary
- challenge-lane candidate expires when it is not canonicalized
- live widening blocked when calibration governance fails

### Manual verification

1. generate a bounded candidate batch from one family;
2. confirm invalid and redundant candidates are removed pre-replay;
3. inspect ranked candidates and verify top ranks are interpretable;
4. run a paper-canary sequential trial and verify time-uniform gating behavior;
5. confirm Torghut runtime continues to fail closed if research evidence is stale.

## Risks and tradeoffs

### Risk: too much formalism slows discovery

Mitigation:

- keep the DSL small;
- apply cheap static rejection before expensive replay;
- reserve heavier proofs for candidates that survive early pruning.

Residual risk:

- valid ideas may still be filtered out too early.

Acceptance:

- only acceptable because the challenge lane preserves a bounded escape hatch.

### Risk: the grammar is too narrow

Mitigation:

- start narrow intentionally;
- grow the language only when a new family has an explicit economic rationale and validation path.

Residual risk:

- some true edges will remain out of scope.

Acceptance:

- tolerated only if challenge-lane ideas are visibly tracked and compared.

### Risk: sequential promotion becomes operationally complex

Mitigation:

- keep the sequential state machine simple;
- expose clear operator payloads and hard stop reasons;
- integrate with current hypothesis and profit-clock surfaces rather than a new control plane.

Residual risk:

- the wrong monitored statistic may be chosen for a family.

Acceptance:

- sequential settings are family-scoped and versioned, not one global default.

Additional mitigation:

- require preregistered metric contracts and force new trial ids for material changes.

### Risk: research metrics become more sophisticated than the team can trust

Mitigation:

- keep all ranking features operator-visible;
- persist artifact hashes and test inputs;
- require top candidates to remain interpretable in English.

Residual risk:

- scorecards may still look more objective than they really are.

Acceptance:

- every leaderboard must expose uncertainty and dominant penalties, not just rank.

Additional mitigation:

- every promotable candidate must show incumbent and null comparators alongside its own score.

### Risk: platform ambition outruns actual edge

Mitigation:

- enforce the pilot-first rule;
- require an incumbent-baseline win before expanding the system;
- treat negative results as success if they stop bad capital deployment.

Residual risk:

- the correct answer may be that the target family has no durable edge.

Acceptance:

- the program is allowed to terminate with that conclusion.

Additional mitigation:

- even after a successful pilot, expansion requires a second gate rather than automatic rollout.

## Rejected alternatives

### Option A: keep heuristic discovery and add stronger gates

Rejected because it improves safety but not candidate quality.

### Option B: use a frontier reasoning model to invent strategies directly

Rejected because unconstrained generation creates too much search entropy and too little trust.

### Option C: move discovery into the live trading service

Rejected because discovery compute, experimentation, and model churn do not belong on the execution path.

### Option D: build the full platform before one family proves itself

Rejected because it front-loads platform cost before demonstrating any improvement in research quality.

## Concrete code implications

The design implies the following code ownership changes.

### Existing files to preserve but reposition

- `services/torghut/app/trading/research_sleeves.py`
  - keep for curated sleeves only
- `services/torghut/app/trading/evaluation.py`
  - keep as replay primitive
- `services/torghut/app/trading/hypotheses.py`
  - keep as capital governor input consumer
- `services/torghut/app/trading/portfolio.py`
  - extend to consume posterior edge bids
- `services/torghut/app/trading/tca.py`
  - keep as execution reality feedback path
- `services/torghut/app/trading/submission_council.py`
  - keep as live capital authority input, not discovery authority

### New files to add

- `services/torghut/app/trading/discovery/dsl.py`
- `services/torghut/app/trading/discovery/canonicalize.py`
- `services/torghut/app/trading/discovery/validity.py`
- `services/torghut/app/trading/discovery/generator.py`
- `services/torghut/app/trading/discovery/ranker.py`
- `services/torghut/app/trading/discovery/sequential_trials.py`
- `services/torghut/app/trading/discovery/contracts.py`
- `services/torghut/app/trading/discovery/baselines.py`
- `services/torghut/app/trading/discovery/cost_calibration.py`
- `services/torghut/app/trading/discovery/challenge_lane.py`

## Success criteria

This design succeeds when:

1. the top-ranked candidates are fewer, simpler, and more interpretable than today's outputs;
2. deliberately overfit strategies fail before promotion with explicit statistical reasons;
3. runtime capital decisions consume posterior edge lower bounds rather than backtest vanity metrics;
4. strategy discovery compute is mostly offline and no longer entangled with the live trading service;
5. Torghut promotes fewer candidates, but the promoted candidates survive paper and live canary windows at a higher
   rate.
6. the program can be shut down after the pilot with a clear, evidence-backed "not worth continuing" decision.

## Source notes

Internal code and docs read during this design:

- `services/torghut/app/trading/research_sleeves.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/empirical_manifest.py`
- `services/torghut/app/trading/hypotheses.py`
- `services/torghut/app/trading/submission_council.py`
- `services/torghut/app/trading/portfolio.py`
- `services/torghut/app/trading/tca.py`
- `services/torghut/app/models/entities.py`
- `docs/torghut/postgres-table-reference.md`
- `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`

External research used to shape the design:

- Bailey, Borwein, Lopez de Prado, Zhu, "The Probability of Backtest Overfitting"
  - https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf
- Bailey, Lopez de Prado, "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and
  Non-Normality"
  - https://www.davidhbailey.com//dhbpapers
- Carr, Lopez de Prado, "Determining Optimal Trading Rules without Backtesting"
  - https://arxiv.org/abs/1408.1159
- Alur et al., "Syntax-Guided Synthesis"
  - https://sygus.org
- Howard, Ramdas, McAuliffe, Sekhon, "Time-uniform, nonparametric, nonasymptotic confidence sequences"
  - https://arxiv.org/abs/1810.08240
