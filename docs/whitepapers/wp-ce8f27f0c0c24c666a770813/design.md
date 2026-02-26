# Whitepaper Design: QuantEval (arXiv:2601.08689)

- Run ID: `wp-ce8f27f0c0c24c666a770813`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/3665`
- Primary PDF: `https://arxiv.org/pdf/2601.08689.pdf`
- Ceph object URI: `s3://torghut-whitepapers/raw/checksum/1a/1adcfd825a74908d475739f0ebee37234105c592dd8bc9f603db7046a1cfed44/source.pdf`
- Review status: full paper reviewed end-to-end (16 pages, including references + appendices A-F)
- Review date (UTC): `2026-02-26`

## 1) Executive Summary

QuantEval proposes a three-part benchmark for finance LLM capability: knowledge QA, quantitative mathematical reasoning, and quantitative strategy coding under execution-based evaluation (Sec. 1-3). The central contribution is not just question accuracy, but a deterministic CTA-style backtesting harness with fixed universe/cost/risk assumptions to score generated strategy code using executable rate and finance metrics (Table 1, Table 2, Appendix B).

Empirical claims are directionally strong as a benchmark paper: 13 LLMs were tested, and the paper reports a persistent gap to human experts, especially in multi-step reasoning and strategy coding (Sec. 3.2, Table 2, Appendix D.1). The authors also report that domain-aligned SFT+GRPO improves QuantEval performance relative to base/SFT-only in their setup (Sec. 4.1, Table 3).

For this repository, QuantEval is implementation-relevant as an evaluation framework and regression gate for finance-model quality, but not yet directly drop-in for production trading decisions. The paper itself limits scope to research usage and highlights constraints (English-only, fixed backtest assumptions, small coding subset) (Limitations section).

## 2) Full-Paper Synthesis

## 2.1 Problem Statement

Existing finance benchmarks are skewed toward QA-style knowledge recall and do not adequately test the end-to-end quantitative workflow of real quant teams, especially executable strategy implementation and financially meaningful backtest behavior (Sec. 1).

## 2.2 Methodology Summary

1. Benchmark design:
- Knowledge QA
- Quantitative Mathematical Reasoning
- Quantitative Strategy Coding with CTA-style execution checks

2. Dataset construction:
- 1,575 total samples: 660 QA, 855 reasoning, 60 coding (Sec. 2.1, 2.7).
- Hybrid human-expert plus multi-agent generation pipeline with iterative validation (Sec. 2.3-2.4, Fig. 2).

3. Evaluation protocol:
- 13 LLMs evaluated, temperature 0 and top-p 1.0 (Sec. 3.1).
- QA/reasoning scored by accuracy.
- Coding scored by executable rate plus MAE on return, drawdown, Sharpe, return/drawdown (Table 1).

4. Reproducibility controls:
- Deterministic backtesting config with fixed NYSE daily data window (2010-01-01 to 2025-01-01), fixed 15-asset universe, fixed commission/slippage/risk constraints, and explicit failure criteria (Appendix B).
- De-dup and leakage checks with thresholds (0.92 for QA/reasoning semantic near-duplicates, 0.85 AST similarity for code), plus overlap scanning against public benchmarks (Appendix C).

## 2.3 Key Findings (from paper evidence)

1. Gap to human experts remains material.
- Human experts: ~91.75% QA, ~89.05% reasoning.
- Best model reasoning remains much lower (Table 2, Appendix D.1).

2. Strategy coding is the hardest dimension.
- Many open-source models show 0% executable rate under CTA constraints (Table 2).

3. CoT improves coding executability substantially versus direct prompting.
- Example ablation: Claude-4.5-sonnet 63.3% (CoT) vs 4.2% (direct), GPT-5 51.7% vs 2.5% (Appendix E.3, Table 11).

4. Domain-aligned post-training helps but does not close the human gap.
- DianJin-R1-7B improved after SFT+GRPO in reported results (Sec. 4.1, Table 3).

5. Existing finance QA benchmark gains do not transfer fully to QuantEval.
- Cross-benchmark results indicate QuantEval is harder, especially on reasoning depth and execution constraints (Sec. 4.2, Table 4).

## 3) Novelty Assessment

1. Execution-grounded coding evaluation for financial strategies is the strongest contribution.
- Prior finance benchmarks emphasized QA/numerical extraction; QuantEval adds deterministic strategy execution metrics (Sec. 1, Sec. 3, Appendix B).
- Assessment: `supported_in_scope`.

2. End-to-end deterministic backtesting spec included in paper appendices.
- Fixed universe, costs, risk caps, and failure criteria are explicitly specified (Appendix B).
- Assessment: `supported_in_scope`.

3. Human + multi-agent hybrid dataset construction at this scale in this niche is useful but not unprecedented.
- Assessment: `moderately_novel`.

## 4) Risk Assessment and Assumptions

## 4.1 Key Risks

1. External validity risk (high).
- Coding subset is only 60 samples; may underrepresent strategy diversity (Limitations).

2. Configuration lock-in risk (high).
- Fixed CTA assumptions (cost/slippage/universe) can bias outcomes to one regime and execution model (Limitations, Appendix B).

3. Leakage uncertainty risk (medium-high).
- Authors note zero overlap with proprietary model corpora cannot be strictly guaranteed (Appendix C.1).

4. Annotation/evaluation drift risk (medium).
- Automated graders report >95% agreement on 200-question subset, but broad grading robustness still depends on prompt stability and normalization logic (Appendix E.1-E.2).

5. Data-source/implementation portability risk (medium-high).
- Paper code examples align with VeighNa-style CTA patterns in examples, while this repo uses Torghut trading/LEAN-oriented components; direct task portability is non-trivial.

## 4.2 Explicit Assumptions for Repo Adoption

1. QuantEval artifacts (dataset + harness) are accessible under the claimed released resources.
2. We adopt QuantEval as an offline evaluation gate, not as direct live-trading policy.
3. Existing Torghut backtesting and cost model modules can host a compatibility adapter without changing production execution semantics.

## 5) Repository Viability (Current-State Check)

Observed repository state indicates viable integration points but no native QuantEval pipeline yet:

1. Existing trading evaluation primitives:
- `services/torghut/app/trading/backtest.py` (minimal PnL/cost evaluation primitives).
- `services/torghut/app/trading/costs.py` (cost model).
- LEAN backtest lane endpoints in `services/torghut/app/main.py` and `services/torghut/app/lean_runner.py`.

2. Gap versus QuantEval requirements:
- No current QuantEval dataset/task schema in repo.
- No CTA-interface executability validator aligned with QuantEval failure criteria (Appendix B.2).
- No explicit benchmark runner that emits QuantEval-compatible leaderboard metrics.

Conclusion: implementation is **conditionally viable** as a research/evaluation adapter project, not as immediate production trading logic.

## 6) Implementation-Ready Plan for This Repo

## Phase 0: Contract + fixtures (low risk)
1. Define immutable QuantEval task schema (QA/reasoning/coding) and result schema in `services/torghut`.
2. Add fixed fixture subset for CI smoke tests.
3. Add deterministic config object matching Appendix B fields.

## Phase 1: Evaluation adapter (core)
1. Build benchmark runner for:
- QA/reasoning exact/normalized scoring.
- Coding executability checks with explicit failure taxonomy matching Appendix B.2.
2. Implement metric emitters for executable rate and coding MAE metrics.
3. Persist run manifests and metrics for reproducibility.

## Phase 2: Reliability and auditability
1. Add overlap/de-dup scanners for ingestion-time checks.
2. Add prompt-template versioning and deterministic inference settings.
3. Add regression gates in CI for metric regressions on fixed fixtures.

## Phase 3: Optional training experimentation lane
1. Add opt-in SFT/RL experiment manifests using internal safety policies.
2. Keep all outputs in research-only lanes; no automatic trading promotion based on benchmark gain alone.

## 7) Verdict

- Verdict: **conditional_implement**
- Score: **0.67 / 1.00**
- Confidence: **0.83 / 1.00**

Interpretation:
- Adopt QuantEval methodology as a deterministic offline evaluation framework.
- Do not treat it as sufficient evidence for autonomous production trading rollout.

## 8) Section-Level Evidence Map

1. Sec. 1 + Fig. 1: benchmark motivation and three task dimensions.
2. Sec. 2.1-2.7 + Fig. 2: construction pipeline and dataset composition.
3. Sec. 3.1 + Table 1-2: model set, prompting protocol, and primary metrics.
4. Sec. 3.2: main findings and human/model gaps.
5. Sec. 4.1 + Table 3: SFT/GRPO exploratory gains.
6. Sec. 4.2 + Table 4: cross-benchmark transfer gap.
7. Limitations: scope constraints and sample-size caveat.
8. Appendix B: deterministic backtesting configuration + failure criteria.
9. Appendix C: de-dup/leakage procedures and caveats.
10. Appendix D/E: human baseline and evaluation reliability details.
