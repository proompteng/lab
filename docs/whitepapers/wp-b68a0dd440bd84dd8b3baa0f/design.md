# Whitepaper Design: AlphaPROBE (arXiv:2602.11917)

- Run ID: `wp-b68a0dd440bd84dd8b3baa0f`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/3955`
- Issue title: `Analyze whitepaper: AlphaPROBE (arXiv:2602.11917)`
- Source PDF: `https://arxiv.org/pdf/2602.11917.pdf`
- Ceph object URI: `s3://torghut-whitepapers/raw/checksum/c2/c28dae26c4e5963f86448f47829eba2a755fe3012b4e592a73843e1887fa1ea6/source.pdf`
- Source PDF SHA256: `c28dae26c4e5963f86448f47829eba2a755fe3012b4e592a73843e1887fa1ea6`
- Reviewed end-to-end: yes (20 pages, main text + references + appendix)
- Review date (UTC): `2026-03-06`

## 1) Executive Summary

AlphaPROBE proposes a closed-loop formulaic alpha mining system that treats factor discovery as navigation over a directed
acyclic graph (DAG) instead of either isolated sampling or single parent-child chains (Sec. 1, Sec. 4, Fig. 2). The two
core ideas are:

1. a Bayesian Factor Retriever that scores parent candidates using both local quality and global graph structure, and
2. a DAG-aware Factor Generator that uses full ancestry traces to propose non-redundant mutations through a multi-agent
workflow.

The paper is implementation-relevant for `services/torghut` because this repository already contains offline alpha research,
backtest, cost-model, and evaluation primitives. However, AlphaPROBE is not a drop-in extension of the current codebase.
The existing `alpha/` lane is a deterministic parameter-search workflow over time-series momentum, not a symbolic factor
mining engine with expression ASTs, lineage graphs, semantic diversity scoring, or LLM-backed factor generation.

Verdict: **conditional_implement** for research infrastructure only. The paper contains a coherent architecture and strong
in-scope results, but it does not justify immediate production trading deployment due to limited external validity, no
reported statistical significance, incomplete deterministic reproduction detail, and simplified execution assumptions.

## 2) Full-Paper Synthesis

## 2.1 Problem Statement

The paper argues that current automated alpha mining methods fall into two families:

1. Decoupled Factor Generation (DFG), which treats each candidate as an isolated draw from a global distribution (Sec. 3.1).
2. Iterative Factor Evolution (IFE), which refines one parent into one child but usually lacks a global view of the overall
factor library (Sec. 3.2).

The authors claim both families miss the structural information encoded by the entire discovered factor pool. AlphaPROBE
addresses this by modeling factors as DAG nodes and parent-child derivations as directed edges (Sec. 4, Eq. 2-3).

## 2.2 Methodology Summary

### 2.2.1 Bayesian Factor Retriever

The retriever ranks parent factors by an approximate posterior over expected descendant quality (Sec. 4.1, Eq. 4).

The prior term combines:

1. normalized factor quality,
2. a depth penalty for over-optimized lineages, and
3. a retrieval-count penalty to avoid repeatedly mining the same region of the graph

(Sec. 4.1.1, Eq. 5).

The likelihood term differs by graph role (Sec. 4.1.2):

1. Leaf factors are scored by value, semantic, and syntactic diversity:
   `ValDiv * SemDiv * SynDiv` (Eq. 6-9).
2. Non-leaf factors are scored by historical percent gain from parent to children and by child sparsity:
   `PG * Spar`, where `Spar = Spar_p-c * Spar_c-c` (Eq. 10-13).

### 2.2.2 DAG-aware Factor Generator

Generation is a three-stage workflow (Sec. 4.2, Eq. 14-15; Appendix A.2.1):

1. Strategy/Analyst agent: proposes context-aware modifications from the full ancestry trace.
2. Execution agent: turns strategies into concrete symbolic expressions.
3. Validator agent: admits factors only if they either improve quality over the parent or clear a novelty gate with
adequate quality.

The appendix is materially important here because it defines the actual operator set, prompt contracts, validator gate, and
JSON-only response formats used by the generation loop (Appendix A.2.1, A.3).

### 2.2.3 Dynamic Factor Integration

After discovery, the paper follows AlphaForge for a dynamic re-selection of recently effective factors into a “Mega”
factor for portfolio construction (Sec. 4.3). This means AlphaPROBE is not just a factor generator; it also depends on an
integration policy over the evolving factor pool.

## 2.3 Experimental Protocol

1. Datasets: CSI 300, CSI 500, CSI 1000 (Sec. 5.1).
2. Split: train `2010-01-01` to `2020-12-31`, validation `2021-01-01` to `2022-06-30`, test `2022-07-01` to
`2025-06-30` (Sec. 5.1).
3. Signals/metrics:
   - predictive: IC, ICIR, RIC, RICIR against 20-day forward returns (Sec. 5.1, Appendix A.1.1),
   - portfolio: annualized return, maximum drawdown, Sharpe ratio (Sec. 5.1, Appendix A.1.1).
4. Backtest rule: buy top 20% daily, sell after 20 days, long-only, 0.1% round-trip cost (Appendix A.1.3).
5. Backbone models:
   - DeepSeek V3.1 for AlphaPROBE and LLM baselines,
   - Qwen3 Embedding-4B for semantic similarity in Eq. 8 (Sec. 5.1).

## 3) Key Findings

1. AlphaPROBE leads all reported baselines across the headline predictive metrics on all three datasets.
- Evidence: Table 1.
- CSI 300: IC `5.84`, ICIR `39.02`, RIC `7.20`, RICIR `46.94`.
- CSI 500: IC `6.26`, ICIR `52.39`, RIC `8.78`, RICIR `73.18`.
- CSI 1000: IC `9.04`, ICIR `70.49`, RIC `11.35`, RICIR `88.02`.

2. Portfolio-level results also lead in reported return and Sharpe while keeping drawdown competitive.
- Evidence: Table 1.
- CSI 300: AR `7.50%`, MDD `22.25%`, SR `0.4411`.
- CSI 500: AR `17.45%`, MDD `22.98%`, SR `0.8262`.
- CSI 1000: AR `16.68%`, MDD `31.95%`, SR `0.6475`.

3. Both the retriever and the DAG-aware generator matter materially.
- Evidence: Table 2.
- Replacing retrieval with random or heuristic choices sharply reduces IC/ICIR/RIC/RICIR.
- Replacing the DAG-aware generator with a simpler CoT generator lowers all reported predictive metrics.

4. The method appears fairly robust to moderate settings of the topology penalties.
- Evidence: Sec. 5.5, Fig. 4.
- Best operating range is reported around `0.05` to `0.15` for both depth and retrieval penalties.

5. AlphaPROBE is reported as more sample-efficient than the two compared LLM-based methods.
- Evidence: Sec. 5.7, Fig. 5.
- The claim is that topology-aware retrieval finds promising parents faster, so fewer factor-evaluation iterations are
needed to reach stronger IC.

## 4) Novelty Claims Assessment

1. Claim: modeling alpha mining as DAG navigation is the central novelty.
- Assessment: **supported_in_scope**.
- Why: the posterior-style parent retrieval plus ancestry-aware generation is a concrete systems contribution, not just a
prompt tweak (Sec. 4, Eq. 4-15, Fig. 2).

2. Claim: global topology beats local-chain refinement.
- Assessment: **supported_in_scope**.
- Why: the MCTS/local alternatives and topology-removal ablations degrade results in Table 2.

3. Claim: full ancestry traces reduce redundant mutations and increase diversity.
- Assessment: **plausible but only indirectly measured**.
- Why: the paper gives a coherent mechanism and qualitative case study, but there is no direct quantitative diversity metric
showing trace conditioning alone caused the effect.

4. Claim: the framework is broadly robust and efficient.
- Assessment: **partially_supported**.
- Why: supported inside the single reported market family and one main split, but not statistically stress-tested across
multiple independent runs or broader market regimes.

## 5) Repository Viability (Current-State Check)

This repository contains relevant trading and research building blocks, but not the specific AlphaPROBE machinery yet.

### 5.1 Existing Integration Points

1. Deterministic offline alpha lane and artifact lineage:
- `services/torghut/app/trading/alpha/lane.py`
- `services/torghut/tests/test_alpha_lane.py`

2. Offline alpha search and metric primitives:
- `services/torghut/app/trading/alpha/search.py`
- `services/torghut/app/trading/alpha/metrics.py`
- `services/torghut/app/trading/alpha/tsmom.py`

3. Backtest, cost, and evaluation infrastructure:
- `services/torghut/app/trading/backtest.py`
- `services/torghut/app/trading/costs.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/main.py`
- `services/torghut/app/lean_runner.py`

4. Prior paper-driven research artifacts in trading autonomy:
- `services/torghut/app/trading/autonomy/janus_q.py`

### 5.2 Gaps Relative to AlphaPROBE

1. No symbolic factor intermediate representation:
- no formula AST parser, operator registry, or expression validator aligned to the paper’s operator set in Appendix A.3.

2. No factor-lineage DAG store:
- current alpha lane stores stage manifests for whole runs, not node-level parent-child factor graphs.

3. No Bayesian retriever implementation:
- current `alpha/search.py` performs deterministic parameter grid search over a TSMOM baseline, not posterior scoring over
leaf/non-leaf factor states.

4. No semantic diversity subsystem:
- the paper requires explanation generation plus embedding-based semantic similarity for Eq. 8.

5. No prompt-versioned multi-agent factor generator:
- current repo has LLM/trading infrastructure, but nothing specific to strategy/execution/validator contracts for symbolic
factor evolution.

6. No AlphaPROBE-specific evaluation harness:
- current alpha code summarizes equity curves and TSMOM candidates, but does not compute the paper’s factor-pool metrics
and dynamic Mega-factor integration loop.

Conclusion: implementation is **conditionally viable** as a research-lane extension inside `services/torghut`, but it is a
new subsystem, not a small patch to the current alpha code.

## 6) Risks, Assumptions, and Unresolved Questions

## 6.1 Critical Assumptions

1. Formula-level ICIR quality during training is a stable enough objective to guide future factor discovery (Sec. 5.1).
2. The proposed diversity proxies, especially semantic similarity from LLM-generated explanations, are sufficiently well
calibrated to distinguish true novelty from paraphrase noise (Eq. 8).
3. The dynamic factor integrator adopted from AlphaForge does not dominate the observed gains relative to the retriever and
generator innovations.

## 6.2 High-Impact Risks

1. Statistical rigor risk (high).
- The paper reports point estimates only. It does not provide confidence intervals, significance tests, or repeated-run
variance for the main comparisons.

2. Reproducibility risk (high).
- The appendix gives prompts and operator lists, but the paper still lacks a full deterministic reproduction bundle:
exact seeds, immutable data snapshot hashes, code commit hash, prompt/config manifests, and full experiment scripts.

3. External validity risk (high).
- Evaluation is concentrated on Chinese equity universes and one primary chronological split.

4. Execution-realism risk (medium-high).
- Backtesting uses a simple long-only top-20% / hold-20-days rule with 0.1% round-trip cost. Market impact, capacity,
borrow, and more detailed slippage realism are not explored.

5. Notation and implementation consistency risk (medium).
- Appendix prompt/operator definitions are not perfectly aligned with the operator summary table. For example, the prompt
section uses `TsRatio`, while Appendix A.3 lists `TsDiv`; Appendix A.3 also lists `Inv`, which is absent from the prompt
contract. These are small but important implementation ambiguities.

## 6.3 Unresolved Questions

1. How much of the gain comes from the retriever versus the dynamic factor integrator inherited from AlphaForge?
2. How stable are results across independent runs with LLM stochasticity and different seed libraries?
3. Does the semantic diversity term remain useful once factor pools become large and explanations become repetitive?
4. Can the method transfer to Torghut’s existing market data and evaluation contracts without introducing silent formula
semantics drift?

## 7) Implementation-Ready Plan for This Repo

## Phase 0: Contracts and deterministic scaffolding

1. Add a symbolic alpha expression IR with:
- operator registry,
- parser/validator,
- canonical serialization,
- AST hash.

2. Define factor-node and factor-edge schemas:
- node payload = expression, explanation, metrics, hashes, lineage metadata,
- edge payload = parent, child, generation trace, generation strategy, validation outcome.

3. Reuse the manifest discipline already present in `services/torghut/app/trading/alpha/lane.py` for node-level lineage and
run-level replay.

## Phase 1: Retrieval and generation prototype

1. Implement Bayesian retrieval with explicit leaf/non-leaf scoring paths from Eq. 5-13.
2. Add explanation generation and embedding-backed semantic diversity.
3. Implement the strategy/execution/validator workflow with prompt hashing and JSON schema validation.

## Phase 2: Evaluation and integration

1. Build factor-level evaluation metrics:
- IC,
- ICIR,
- RIC,
- RICIR.

2. Implement portfolio construction comparable to the paper’s protocol.
3. Add AlphaPROBE-compatible factor-pool capacity management, retrieval counters, and topology maintenance.

## Phase 3: Robustness and promotion gates

1. Add repeated-run variance reporting and significance testing.
2. Add walk-forward and regime-sliced evaluation using existing Torghut evaluation patterns.
3. Add stronger cost, slippage, and capacity stress tests before any paper-trading promotion.

## 8) Viability Verdict

- Verdict: **conditional_implement**
- Score: **0.64 / 1.00**
- Confidence: **0.80 / 1.00**

Interpretation:

1. The paper is technically clear enough to drive a deterministic research implementation.
2. The repository already has enough trading/research substrate to host that work inside `services/torghut`.
3. The required system is still substantial and should be treated as a new research module, not as a safe production
upgrade.

## 9) Section-Level Evidence Map

1. Sec. 1: problem framing, DFG vs IFE critique, and contribution claims.
2. Sec. 4 + Eq. 2-4: DAG formulation and retrieval objective.
3. Sec. 4.1.1 + Eq. 5: prior score and topology penalties.
4. Sec. 4.1.2 + Eq. 6-13: leaf/non-leaf likelihood scoring and sparsity terms.
5. Sec. 4.2 + Eq. 14-15: DAG-aware generation pipeline.
6. Sec. 4.3: dynamic factor integration.
7. Sec. 5.1 + Appendix A.1.1-A.1.3: splits, metrics, and backtest rules.
8. Table 1: headline predictive and portfolio metrics.
9. Table 2 + Fig. 4-5: ablation, sensitivity, and efficiency evidence.
10. Appendix A.2.1-A.3: prompt contracts, validator gate, and operator set needed for implementation.
