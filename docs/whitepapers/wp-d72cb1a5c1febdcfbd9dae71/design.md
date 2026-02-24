# Whitepaper Design: Janus-Q (arXiv:2602.19919)

- Run ID: `wp-d72cb1a5c1febdcfbd9dae71`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/3589`
- Source PDF: `https://arxiv.org/pdf/2602.19919.pdf`
- Ceph object: `s3://torghut-whitepapers/raw/github/proompteng-lab/issue-3589/wp-d72cb1a5c1febdcfbd9dae71/source.pdf`
- Reviewed end-to-end: yes (16 pages, main text + appendix)
- Review date (UTC): `2026-02-24`

## 1) Executive Summary

Janus-Q proposes an event-driven trading framework where financial news events are first-class decision units instead of auxiliary text features. The method has two stages: (1) build an event-centric dataset with CAR-based market-impact labels and semantic event labels, then (2) fine-tune an LLM with supervised learning plus GRPO reinforcement learning using a Hierarchical-Gated Reward Model (HGRM).

The strongest contribution is the explicit reward decomposition and gating logic for direction correctness, event-type consistency, cost-aware PnL, and CAR magnitude shaping (Sec. 3.2.1-3.2.6, Eq. 6-10, Alg. 1). Reported results show improved Sharpe Ratio and decision metrics versus listed baselines (Sec. 4.5, Table 2).

Implementation relevance is high for research pipelines that need event-aware decision supervision. Production readiness is moderate due to unresolved risks: short evaluation horizon, limited market scope, unclear significance testing, no full reproducibility package, and possible benchmark comparability concerns.

## 2) Methodology Synthesis

## 2.1 Stage I: Event-Centric Data Construction

- Data target: 62,400 Chinese financial news articles with event type, associated stock, sentiment semantics, and CAR (Sec. 1, Sec. 3.1, Table 1, Table 7).
- Event impact labeling:
  1. Estimate market-model abnormal return (Eq. 1-2).
  2. Neutralize residual systematic factors via multi-factor risk model (Eq. 3-4).
  3. Aggregate over event window into CAR (Eq. 5).
- Labels represented as `y = {c, d, s, e}` where direction/sign and strength threshold are derived from CAR magnitude (Sec. 3.1.2).

## 2.2 Stage II: Decision-Oriented Finetuning

- Training sequence: SFT -> GRPO (Sec. 3.2, App. A.1.1).
- HGRM reward design:
  1. Hard direction gate with stronger opposite-direction penalty (Sec. 3.2.2, Eq. 6).
  2. Soft event-type gate with multiplicative discount on trading reward when event-type prediction is wrong/missing (Sec. 3.2.3, Eq. 7).
  3. Cost-aware PnL reward with clipping and strength regularization (Sec. 3.2.4, Eq. 8).
  4. Magnitude shaping and process reward (Sec. 3.2.5, Eq. 9).
  5. Hierarchical final reward composition (Sec. 3.2.6, Eq. 10; Alg. 1).

## 2.3 Evaluation Protocol

- Task: generate long/short/hold event signals, aggregate by event-type weights estimated from pre-open historical stats, execute next-open entry and two-day hold exit (Sec. 4.1).
- Data range: news 2023-01-01 to 2025-01-25; prices to 2025-02-06; chronological split 4:4:1:1 (Sec. 4.3, Table 8).
- Metrics: MAE, RMSE, DA, ETA, SR, MDD (Sec. 4.3, App. A.1.3).

## 3) Key Findings

1. Event-driven formulation outperforms reported baselines on risk-adjusted return in this setup.
- Janus-Q SR = 1.3088 vs runner-up QwQ-32B SR = 0.6481 (about +102.0% relative), with DA = 0.5869 and ETA = 0.8009 (Sec. 4.5, Table 2).

2. SFT is a critical base layer; RL adds incremental gains.
- Removing SFT collapses SR from 1.3088 to -5.2848 and DA from 0.5869 to 0.4429.
- Removing GRPO reduces SR from 1.3088 to 1.1330 (Sec. 4.6.1, Table 3).

3. Diversified reward components are complementary.
- Removing direction, event-type, magnitude, or PnL objectives lowers full-model SR (Sec. 4.6.2, Table 4).

4. Appendix sensitivity tests support short-horizon event effects.
- Performance degrades at longer holding horizons; moderate position limits improve the trade-off between capital efficiency and stale-signal risk (App. A.4, Fig. 9-10).

## 4) Novelty Claims Assessment

1. Claim: first end-to-end event-driven framework mapping financial events directly to trading actions.
- Assessment: moderately novel systems integration claim.
- Basis: explicit event-first dataset + decision-oriented HGRM training pipeline (Sec. 1, Sec. 3, Fig. 2).

2. Claim: HGRM aligns semantic reasoning with financially valid behavior.
- Assessment: technically plausible and reasonably supported by ablations.
- Basis: hierarchical gating and reward decomposition; full model beats ablations in Table 4 (Sec. 3.2, Sec. 4.6.2).

3. Claim: strong outperformance over broad baselines.
- Assessment: directionally supported in reported window, but external validity is limited.
- Basis: Table 2 gains exist, but one market (CN A-share), one main test interval, and limited significance analysis (Sec. 4.3-4.5).

## 5) Risks, Assumptions, and Unresolved Questions

## 5.1 Core Assumptions

1. Event-to-CAR mapping can be learned robustly from this label pipeline and remains stable under regime changes.
2. Event-type weighting estimated from historical windows stays informative out-of-sample.
3. The chosen execution protocol (next open entry, fixed hold horizon) approximates deployable decision quality.

## 5.2 Technical and Empirical Risks

1. External validity risk (high): only Chinese A-share universe is evaluated (Sec. 4.3, Table 8).
2. Horizon risk (high): main backtest window is short, and sensitivity plots show degradation with longer holding periods (Sec. 4.5, App. A.4).
3. Statistical rigor risk (high): no confidence intervals, no statistical significance tests, and no multiple-run variance reporting for key leaderboard results.
4. Reproducibility risk (medium-high): paper provides hyperparameter ranges but not a complete deterministic artifact package (exact seeds, code commit, data snapshot checksum, full prompt/reward config bundles).
5. Cost-model realism risk (medium): transaction cost term exists (Eq. 8), but microstructure details (slippage model, turnover impact calibration) are not fully specified in main results.
6. Benchmark comparability risk (medium): baseline set includes heterogeneous model families and potentially different adaptation levels, making strict apples-to-apples conclusions uncertain.

## 5.3 Inconsistencies/Signals to Validate

1. Improvement wording differs across sections (for direction accuracy, numbers differ by reference baseline).
2. Drawdown is not uniformly best; Janus-Q is strongest on SR but some baselines have lower MDD (Table 2).
3. "Open source" dataset is claimed in Table 1; release location/versioning should be verified before direct reuse.

## 6) Implementation Implications (Implementation-Ready Outcomes)

## 6.1 What Can Be Adopted Now

1. Adopt the HGRM structure as a policy-shaping template:
- hard gate for wrong direction,
- soft gate for semantic mismatch,
- cost-aware reward,
- magnitude/process shaping.

2. Adopt event-centric sample schema for training records:
- `news`, `event_time`, `stock_id`, `event_type`, `direction`, `strength`, `car`, plus provenance metadata.

3. Adopt staged training flow:
- SFT for structured reasoning reliability,
- RL for objective alignment after SFT convergence.

## 6.2 Guardrails Required Before Any Production Trading Use

1. Add deterministic reproducibility controls:
- fixed seeds, frozen data snapshots, versioned prompts/reward configs, and immutable run manifests.

2. Add robust evaluation gates:
- rolling walk-forward splits,
- regime-segmented evaluation,
- bootstrap significance for SR/DA/ETA deltas,
- realistic slippage/impact and turnover constraints.

3. Add failure controls:
- directional calibration checks,
- stale-event suppression,
- max gross/net exposure and concentration limits,
- auto-disable on drift or unstable reward attribution.

## 6.3 Suggested Incremental Implementation Plan

Phase 1 (2-3 weeks): research replica
1. Implement event schema + CAR pipeline + baseline reward functions.
2. Reproduce Table 3/4 style ablations on internal infra.
3. Emit per-run JSON artifacts (data hash, config hash, metrics, error bars).

Phase 2 (2-4 weeks): robustness hardening
1. Expand evaluation to multi-period and multi-market slices.
2. Add significance testing and calibration diagnostics.
3. Introduce cost/slippage and turnover-aware policy constraints.

Phase 3 (ongoing): controlled pilot only
1. Paper-trading deployment with strict risk limits.
2. Promotion gate requires stability across regimes and reproducible replay.
3. Human sign-off required for any live capital transition.

## 7) Viability Verdict

- Verdict: **conditional_implement**
- Score: **0.67 / 1.00**
- Confidence: **0.76 / 1.00**
- Rejection reasons (for immediate full production rollout):
  1. Limited external validity (single primary market and narrow evaluation horizon).
  2. Insufficient statistical significance/reproducibility evidence for production confidence.
  3. Incomplete real-world execution realism documentation (cost/impact/turnover details).

Recommendation: implement as a controlled research and paper-trading program, not immediate live production strategy automation.

## 8) Concrete Section-Level Evidence Map

1. Problem framing and challenges: Sec. 1 (Ch1/Ch2), Fig. 1.
2. Two-stage framework overview: Sec. 1, Sec. 3, Fig. 2.
3. Event-to-CAR construction: Sec. 3.1.1, Eq. 1-5, Fig. 5, App. A.3.
4. Label structure (`c,d,s,e`) and taxonomy: Sec. 3.1.2, Table 7.
5. HGRM reward formulation: Sec. 3.2.1-3.2.6, Eq. 6-10, Alg. 1.
6. Experiment protocol and datasets: Sec. 4.1-4.4, Table 8.
7. Main benchmark outcomes: Sec. 4.5.1, Fig. 3, Table 2.
8. Component ablations: Sec. 4.6, Table 3-4.
9. Human alignment case study: Sec. 4.7, Fig. 4.
10. Holding-period and position-limit sensitivity: App. A.4, Fig. 9-10.
11. Training details and prompt templates: App. A.1.1, Table 5-6, App. A.5.
