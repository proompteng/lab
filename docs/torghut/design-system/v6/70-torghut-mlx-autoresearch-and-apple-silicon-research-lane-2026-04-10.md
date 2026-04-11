# 70. Torghut MLX Autoresearch and Apple Silicon Research Lane (2026-04-10)

Status: Proposed (`design`)
Date: `2026-04-10`
Owner: Codex (repository-local design draft)
Scope: Define an Apple Silicon local research lane for Torghut that borrows the discipline of
`karpathy/autoresearch`, uses Apple MLX for GPU-accelerated candidate generation, and preserves
runtime-parity approval as the only promotion authority.

Extends:

- `docs/torghut/design-system/v6/69-torghut-harness-v2-strategy-discovery-and-whitepaper-research-factory-2026-04-07.md`
- `docs/torghut/design-system/v6/68-torghut-strategy-factory-formal-validity-and-sequential-promotion-2026-04-04.md`
- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `docs/torghut/design-system/v6/67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md`

## Executive summary

Torghut needs two things at once:

1. a faster local research loop for discovering new candidate families; and
2. a stricter wall between research candidates and promotable runtime strategies.

The recent research failures made the core problem obvious: the system can still produce discovery
results that look strong in a research backend and then fail when expressed through the real runtime
path. That means the current search stack is usable for hypothesis generation, but not sufficient as
the final source of truth.

This document proposes a concrete split of responsibilities:

1. **MLX-backed Apple Silicon research lane**
   - runs locally on Mac hardware,
   - uses immutable snapshot tensors and an append-only experiment ledger,
   - learns proposal models and regime/motif scorers with Apple MLX,
   - and proposes new candidate families or parameter mutations quickly.
2. **Runtime-native approval lane**
   - remains the only authority for parity, approval replay, and promotion,
   - uses the checked-in Torghut runtime family code and scheduler-v3 replay path,
   - and blocks promotion unless parity and shadow requirements are met.

The key design decision is simple:

**MLX is for research acceleration, not for promotion authority.**

Torghut should use MLX to search better, not to weaken the honesty contract.

## Why this is the right next move

### The useful lesson from `karpathy/autoresearch`

`karpathy/autoresearch` is valuable because it is disciplined, not because it is fully autonomous.

Its strongest ideas are:

- one narrow mutable surface;
- one explicit research charter in `program.md`;
- one fixed experiment budget;
- one append-only result ledger;
- and one keep-or-discard loop with rollback.

Those ideas transfer well to Torghut.

What does **not** transfer well is the single-scalar winner logic. Torghut cannot honestly optimize
one number and call it done. It still needs:

- daily activity gates,
- concentration gates,
- drawdown and worst-day controls,
- runtime parity,
- approval replay,
- and shadow validation.

### Why MLX specifically

Apple’s official MLX documentation and repository describe MLX as an array framework for machine
learning on Apple Silicon with:

- unified memory across CPU and GPU;
- lazy computation;
- composable function transforms;
- dynamic graph construction;
- and support for both CPU and GPU devices.

Those properties are a good fit for Torghut’s local discovery workload because the problem is
increasingly a tensor-search and proposal-ranking problem, not only a pure Python threshold-sweep
problem.

Primary references:

- [MLX repository](https://github.com/ml-explore/mlx)
- [MLX documentation](https://ml-explore.github.io/mlx/)

## Design goals

1. increase local candidate-generation throughput on Apple Silicon without weakening replay honesty;
2. make research mutation surfaces explicit and narrow;
3. keep experiment comparison deterministic under one immutable snapshot contract;
4. use MLX to learn proposal policies, surrogate scorers, and regime/motif models over Torghut data;
5. keep scheduler-v3 parity and shadow validation as mandatory promotion gates;
6. preserve append-only evidence for every experiment, including failures and crashes.

## Non-goals

1. replacing the Torghut runtime with MLX;
2. using MLX as the execution engine for live trading;
3. promoting a strategy directly from an MLX score;
4. unconstrained arbitrary code mutation during autoresearch;
5. using Apple Silicon acceleration as an excuse to skip runtime realism.

## Current problem statement

Today, Torghut has two mismatched loops:

1. a discovery loop that can search many family variants quickly enough to generate interesting
   candidates; and
2. a runtime path that remains the only honest representation of actual strategy behavior.

That mismatch produces four concrete failures:

1. research-only families can look stronger than runtime-valid families;
2. replay-intensive search is still too slow for broad hypothesis exploration on a local machine;
3. mutation surfaces are still too broad and not governed by one narrow research contract;
4. experiment history is recorded, but candidate generation is not yet learning efficiently from it.

## Proposed architecture

The architecture has five layers.

### 1. Immutable snapshot compiler

The research lane begins from one frozen dataset snapshot for a declared window:

- symbols,
- microbar or `PT1S` rows,
- quote-quality masks,
- cross-sectional features,
- regime labels or regime evidence,
- and runtime-approval metadata.

The snapshot compiler emits:

- a canonical manifest;
- Arrow or Parquet backing files for auditability;
- and MLX-ready tensor bundles for local training and scoring.

No candidate may compare itself against a different snapshot unless the run id changes.

### 2. Research charter

Torghut should add a checked-in, `program.md`-style research charter for each autoresearch program.

That charter defines:

- allowed family templates;
- allowed mutation knobs;
- forbidden mutation surfaces;
- objective gates;
- required evidence fields;
- crash-handling policy;
- and keep/discard rules.

The charter is the human-authored control plane for the research loop. The agent does not get to
invent its own mutation authority.

### 3. MLX candidate-generation lane

MLX is used only for **candidate generation** and **proposal ranking**.

The initial MLX lane should support three workloads:

1. **Surrogate scoring**
   - fit a compact model over prior experiments to predict which family/mutation combinations are
     more likely to satisfy activity, concentration, and profitability gates.
2. **Motif and periodicity mining**
   - learn repeatable cross-sectional or intraday motifs from frozen snapshot tensors.
3. **Proposal policy**
   - produce the next candidate batch subject to novelty, diversity, and budget constraints instead
     of only enumerating static YAML grids.

Recommended MLX building blocks:

- `mlx.core` for tensor loading and transforms;
- `mlx.nn` for compact ranking or classification models;
- `mlx.optimizers` for fast local fitting;
- `mx.compile` only around stable scoring kernels once parity of inputs is proven.

### 4. Runtime-native approval lane

Every candidate that survives the MLX proposal stage must still be converted into:

- a checked-in family template;
- a runtime family mapping;
- and a scheduler-v3 replay job.

Approval is granted only if the candidate passes:

1. runtime parity replay;
2. scheduler-v3 approval replay on declared windows;
3. promotion-contract checks;
4. and shadow validation.

This keeps the current promotion contract intact and explicit.

### 5. Append-only experiment ledger

Every experiment writes one append-only row with at least:

- run id;
- snapshot id;
- candidate id;
- family template id;
- mutation lineage;
- MLX proposal score;
- runtime replay status;
- objective metrics;
- keep/discard/crash status;
- and promotion readiness state.

The ledger is not just for logging. It becomes the training set for the next MLX proposal pass.

## Exact MLX role in Torghut

MLX should accelerate the parts of the loop that are naturally tensorized on Apple Silicon.

### Good MLX fits

1. ranking candidate parameterizations by historical experiment outcomes;
2. learning day-level or regime-level failure predictors;
3. mining cross-sectional periodicity or reversal motifs from frozen tensors;
4. compressing high-dimensional microbar features into small proposal embeddings;
5. fast batched scoring over many candidate descriptors on-device.

### Bad MLX fits

1. authoritative fill simulation;
2. order classification truth;
3. quote-quality policy enforcement;
4. live scheduler behavior;
5. promotion decisions.

Those remain in the Torghut runtime and replay code paths.

## Why Apple Silicon changes the local loop

MLX is a good local fit because Apple Silicon gives Torghut a practical middle ground between:

- pure CPU-bound Python experimentation, which is too slow for broad search;
- and cluster-scale GPU infrastructure, which is too expensive and heavyweight for every idea.

The important operational consequence of MLX’s unified-memory model is that Torghut can keep frozen
feature matrices, candidate descriptors, and compact proposal models close to the same memory
surface without building a new CUDA-specific stack for local discovery.

This is specifically a **local research lane** optimization. It does not change the production
runtime deployment target.

## Research loop

The recommended loop is:

1. resolve one immutable snapshot id;
2. write or select one research charter id;
3. run baseline runtime-native seed candidates;
4. featurize the experiment ledger and snapshot into MLX tensors;
5. train or update the MLX proposal models locally on Apple Silicon;
6. generate the next candidate batch under charter constraints;
7. replay only the top bounded candidate set through the real Torghut approval path;
8. append outcomes to the ledger;
9. keep only candidates that improve under the same approval contract;
10. repeat.

This is the right adaptation of `autoresearch`: automatic iteration with rollback, but under a
fixed and honest evaluation contract.

## Candidate representation

To make MLX useful, Torghut needs a stable tensor representation for family candidates.

Each candidate should compile into:

- family id;
- directionality and side eligibility;
- entry-window geometry;
- exit policy geometry;
- rank or selector policy;
- notional and budget policy;
- feature normalization choices;
- regime gates;
- and expected execution prerequisites.

This representation should be explicit and serializable. If a candidate cannot compile into that
descriptor, it should not enter the MLX lane.

### Candidate descriptor schema v1

The first version should be deliberately narrow and fixed-width.

Required fields:

- `candidate_id`
- `family_template_id`
- `runtime_family`
- `strategy_name`
- `side_policy`
- `entry_window_start_minute`
- `entry_window_end_minute`
- `max_hold_minutes`
- `entry_type`
- `exit_type`
- `rank_policy`
- `rank_count`
- `gross_budget_usd`
- `per_leg_budget_usd`
- `normalization_regime`
- `regime_gate_id`
- `requires_prev_day_features`
- `requires_cross_sectional_features`
- `requires_quote_quality_gate`
- `expected_fill_mode`
- `approval_path`

Encoding rule:

- categorical fields compile to one stable dictionary or embedding index;
- bounded numeric fields compile to normalized scalar channels;
- forbidden or unavailable fields compile to explicit null-mask channels rather than being dropped.

If two candidates differ in runtime-relevant behavior, they must differ in descriptor space.

## Research charter schema

The research charter must be checked in and versioned. It should be a narrow YAML contract, not an
open-ended markdown note.

### Research charter schema v1

Required top-level fields:

- `program_id`
- `description`
- `snapshot_policy`
- `allowed_family_templates`
- `allowed_mutations`
- `forbidden_mutations`
- `proposal_model_policy`
- `objective`
- `replay_budget`
- `parity_requirements`
- `promotion_policy`
- `ledger_policy`

Required semantics:

1. `snapshot_policy`
   - defines exact windowing rules, symbol-universe policy, and whether prior-day features are
     allowed.
2. `allowed_family_templates`
   - enumerates the only family ids MLX may propose over.
3. `allowed_mutations`
   - enumerates mutable knobs, ranges, and step sizes.
4. `forbidden_mutations`
   - explicitly blocks evaluator changes, runtime code-path changes, and any live-config mutation.
5. `proposal_model_policy`
   - declares whether the MLX model is allowed to rank, classify, or cluster. Initial scope should
     be `ranking_only`.
6. `objective`
   - restates profitability, activity, drawdown, and concentration gates.
7. `replay_budget`
   - caps the number of candidates that may graduate from MLX proposal to runtime replay.
8. `parity_requirements`
   - points at scheduler-v3 parity and approval replay as mandatory gates.
9. `promotion_policy`
   - hardcodes `research_only` until promotion-contract evidence exists.
10. `ledger_policy`
   - requires append-only writes and forbids row rewrites.

## Snapshot manifest contract

The MLX lane must never learn over an ambiguous data bundle.

### Snapshot manifest schema v1

Required fields:

- `snapshot_id`
- `created_at`
- `source_window_start`
- `source_window_end`
- `train_days`
- `holdout_days`
- `full_window_days`
- `symbols`
- `bar_interval`
- `quote_quality_policy_id`
- `feature_set_id`
- `cross_sectional_feature_flags`
- `prior_day_feature_flags`
- `tape_freshness_receipt`
- `row_counts`
- `tensor_bundle_paths`
- `manifest_hash`

Required invariant:

The runtime replay path must be able to prove that a candidate replay consumed the same economic
window and feature contract that the MLX proposal layer saw. If that cannot be proven from the
manifest, the run is invalid.

## Required repo additions

### New design and config surfaces

1. one checked-in Torghut research charter format, analogous to `program.md`;
2. one immutable snapshot manifest format for MLX-friendly local research bundles;
3. one experiment-ledger schema that includes proposal-model metadata;
4. one candidate-descriptor compiler from family templates to tensors;
5. one checked-in notebook contract for MLX research diagnostics.

### New implementation surfaces

1. `services/torghut/app/trading/discovery/mlx_snapshot.py`
   - compile snapshot bundles for Apple Silicon local research.
2. `services/torghut/app/trading/discovery/mlx_features.py`
   - transform family descriptors and snapshot data into MLX arrays.
3. `services/torghut/app/trading/discovery/mlx_proposal_models.py`
   - define surrogate scorers, regime classifiers, and proposal policies.
4. `services/torghut/scripts/run_strategy_autoresearch_loop.py`
   - add a bounded MLX proposal phase before runtime replay.
5. `services/torghut/app/trading/discovery/promotion_contract.py`
   - continue to block promotion from any research-only output.
6. `services/torghut/notebooks/mlx-autoresearch-diagnostics.ipynb`
   - visualize snapshot health, proposal quality, replay outcomes, and parity drift.
7. `services/torghut/app/trading/discovery/mlx_notebook_exports.py`
   - export notebook-ready tables and stable plot inputs so the notebook does not reimplement
     business logic.

## Notebook requirements

The MLX lane must ship with a Python notebook for visualization and diagnostics. This is not
optional.

Reason:

- MLX proposal behavior will otherwise be too opaque;
- surrogate ranking quality will be too easy to misread;
- and parity failures will be discovered too late.

### Notebook contract

The first notebook must be:

- checked in;
- runnable on Apple Silicon with the local MLX environment;
- driven by exported JSON/Parquet artifacts rather than ad hoc database reads;
- and scoped to diagnosis, not to hidden business logic.

The notebook must never become the source of truth for candidate evaluation. It is a read-only
inspection surface over:

- snapshot manifests;
- candidate descriptors;
- experiment ledgers;
- MLX proposal outputs;
- and scheduler-v3 replay outcomes.

### Required sections

The notebook must contain these sections in order:

1. `Run summary`
   - run id, snapshot id, charter id, train/holdout/full-window definition, replay budget.
2. `Snapshot health`
   - row counts, symbol counts, feature flags, prior-day feature coverage, quote-quality coverage,
     freshness receipt summary.
3. `Descriptor coverage`
   - candidate count, family distribution, side distribution, entry-window distribution, missing or
     masked descriptor channels.
4. `Proposal model diagnostics`
   - proposal score distribution, top-K candidates, novelty/diversity summary, and ranking lift
     against naive baselines.
5. `Replay outcome comparison`
   - side-by-side table of MLX proposal rank versus actual runtime replay metrics.
6. `Calibration and error analysis`
   - calibration plot or rank-bucket success plot, false-positive review, and false-negative review.
7. `Parity and authority checks`
   - research candidate count, runtime-parity pass/fail count, approval replay pass/fail count,
     blocked promotion count.
8. `Open failures`
   - candidates with missing runtime mapping, missing parity evidence, or snapshot/descriptor
     contract violations.

### Required plots and tables

The notebook must render at minimum:

1. one histogram of proposal scores;
2. one family-by-family bar chart of proposal volume;
3. one top-K candidate table with both proposal and replay metrics;
4. one calibration curve or rank-decile lift chart;
5. one scatter plot of proposal score versus realized `net_pnl_per_day`;
6. one parity-status matrix showing `proposed -> replayed -> parity_pass -> approval_pass`;
7. one table of the worst false positives;
8. one table of the best false negatives.

### Notebook input contract

The notebook may only read:

- snapshot manifest files;
- exported descriptor bundles;
- exported proposal outputs;
- exported runtime replay summaries;
- and append-only experiment ledgers.

The notebook must not:

- query ClickHouse directly by default;
- derive new business rules;
- silently mutate candidate scores;
- or compute promotion status independently of the promotion contract.

### Notebook success criteria

The notebook requirement is satisfied only if:

1. a new engineer can open one run and understand why the model proposed the top candidates;
2. false positives are visible without reading raw logs;
3. parity failures are visible without diffing replay artifacts by hand;
4. the notebook agrees exactly with exported ledger totals and parity counts;
5. the notebook remains usable when there is no winner.

## First implementation slice

The first slice should be intentionally small.

### Scope

1. one frozen microbar snapshot bundle over one already-used Torghut evaluation window;
2. one descriptor compiler for checked-in runtime families only;
3. one MLX proposal model in `ranking_only` mode;
4. one diagnostics notebook backed only by exported run artifacts;
5. one bounded integration into `run_strategy_autoresearch_loop.py`;
6. zero changes to live execution behavior.

### Explicitly deferred

1. generative family synthesis;
2. arbitrary code mutation;
3. multi-model ensembles;
4. direct periodicity mining in the first ship;
5. any MLX-driven runtime decision path.

### First proposal model choice

The first MLX model should be **ranking-only**, not classification-plus-ranking.

Reason:

- ranking is enough to reorder replay budgets;
- it avoids pretending the model knows an absolute truth probability;
- and it is easier to calibrate against the append-only experiment ledger.

Classification can be added later only if calibration quality and replay lift justify it.

## Validation contract

The MLX lane is acceptable only if the following are true:

1. every replayed candidate still runs through the same runtime-native evaluator;
2. the MLX proposal score is visible but non-authoritative;
3. experiment rows remain append-only;
4. fixed snapshot ids make runs comparable;
5. promotion readiness remains blocked until runtime parity and shadow evidence exist.

### Parity gate

Before any MLX-nominated candidate is allowed to be called `keep`, the system must prove:

1. the candidate compiled into one checked-in runtime family or runtime family composition;
2. the runtime family was replayed through scheduler-v3 on the declared snapshot window;
3. the replay used the same feature contract and quote-quality policy recorded in the snapshot
   manifest;
4. the replay emitted a matching candidate id lineage into the experiment ledger;
5. the replay output satisfied the same objective gates that MLX was attempting to improve.

If any of those are missing, the candidate may be stored as `research_candidate`, but it must not be
stored as `winner`, `approved`, or `promotable`.

### Success criteria for phase 1

Phase 1 is complete only if:

1. a local Apple Silicon run can build one snapshot bundle and one descriptor bundle end to end;
2. the MLX ranking model can produce a bounded top-K proposal list;
3. the runtime replay path can consume those proposals without manual translation;
4. the notebook can visualize one full run from exported artifacts only;
5. the ledger records both MLX proposal metadata and runtime replay outcomes;
6. promotion readiness remains blocked by default for every MLX-generated result.

## Risks

### 1. Surrogate overfitting

If the MLX scorer becomes the real optimizer instead of a bounded proposal aid, Torghut will simply
learn a faster way to overfit.

Mitigation:

- keep replay as the authority;
- require novelty and diversity in proposal selection;
- retrain only on append-only evidence;
- and explicitly score calibration error of the proposal model.

### 2. Snapshot leakage

If snapshot construction leaks holdout information into the descriptor space, the local GPU loop
will optimize on contaminated evidence faster.

Mitigation:

- explicit snapshot manifests;
- declared train/holdout/full-window partitions;
- and snapshot ids embedded in every experiment row.

### 3. Local-only drift

Apple Silicon local results may diverge from Linux cluster runtime assumptions.

Mitigation:

- MLX is candidate generation only;
- all authoritative replays remain in the same runtime-native path used today.

### 4. Too-broad mutation surfaces

If the research charter allows arbitrary code mutation, the system becomes impossible to reason
about.

Mitigation:

- family-template and override-only mutation authority;
- immutable evaluator;
- keep/discard lineage with rollback.

## Rollout plan

### Phase 1. Contract and ledger

1. add the checked-in research charter format;
2. add the MLX snapshot manifest and candidate descriptor schema;
3. extend the experiment ledger with proposal-model metadata.

### Phase 2. Local MLX prototype

1. compile one frozen microbar snapshot for local Apple Silicon research;
2. implement compact MLX surrogate scorers over prior experiment history;
3. produce ranked candidate batches without touching runtime approval logic.

### Phase 3. Proposal integration

1. integrate MLX proposal generation into `run_strategy_autoresearch_loop.py`;
2. bound replay count to top-K MLX proposals plus exploration slots;
3. persist calibration and diversity diagnostics.

### Phase 4. Runtime-native family closure

1. require every promising research candidate to become a checked-in runtime family;
2. run parity replay and approval replay;
3. block anything else from promotion automatically.

## Rejected alternatives

### 1. Use PyTorch MPS as the primary local research path

Rejected for the first design because the goal is not only "GPU acceleration on a Mac." The goal is
to use a framework that is designed around Apple Silicon local research ergonomics. MLX is a better
fit for that local proposal-model lane.

### 2. Let MLX replace runtime replay for some families

Rejected because it would repeat the exact honesty failure that already happened with research-only
winners.

### 3. Let the agent mutate arbitrary runtime files during autoresearch

Rejected because it destroys comparability and makes rollback meaningless.

## Decision

Torghut should adopt a Karpathy-style autoresearch discipline, but not a Karpathy-style approval
rule.

The correct Apple Silicon design is:

- **MLX for local research acceleration**
- **scheduler-v3 replay for truth**
- **promotion contract for rollout authority**

That gives Torghut a faster local search loop without repeating the same “research artifact looked
good, runtime reality killed it” failure mode.
