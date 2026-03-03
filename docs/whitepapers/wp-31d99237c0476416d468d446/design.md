# Whitepaper Design: DiffLOB (arXiv:2602.03776)

- Run ID: `wp-31d99237c0476416d468d446`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/3906`
- Source PDF: `https://arxiv.org/pdf/2602.03776.pdf`
- Ceph object: `s3://torghut-whitepapers/raw/checksum/fb/fbde1a622419f1c93e6b9263209da1f12c75ab69dd7f5294c7c2fabd88dea94a/source.pdf`
- Full-paper review: complete (main manuscript `ijcai26.tex` + appendix `appendix.tex` from official arXiv source bundle)
- Review date (UTC): `2026-03-03`

## 1) Executive Summary

DiffLOB proposes a conditional diffusion model for generating future limit-order-book (LOB) trajectories under intervened future regime controls: trend, volatility, liquidity, and order-flow imbalance. The paper claims three outcomes: realistic controlled generation, valid response to counterfactual interventions, and usefulness of generated counterfactual samples for downstream extreme-regime prediction.

For Torghut, the paper is methodologically relevant but not directly production-ready. The strongest reusable idea is explicit regime-conditioned generation for stress testing and scenario augmentation. The weakest point is deployment fit: DiffLOB requires full-depth LOB trajectory data and a diffusion training/inference stack that the current Torghut runtime does not host.

Implementation decision: **conditional_implement** for research-only scaffolding and offline experimentation; **reject immediate production strategy integration**.

## 2) Paper Synthesis

## 2.1 Problem Formulation

The model learns:

`p(x_{t+1:t+tau} | x_{1:t}, c_{t+1:t+tau})`

where controls `c` include future trend, volatility, liquidity, and order-flow imbalance (Sec. 3.1; Eq. problem formulation). Counterfactual generation is defined as intervening on these future controls and sampling alternate LOB futures.

## 2.2 Model and Training

1. Backbone: WaveNet-style residual stack with skip/residual paths and FiLM conditioning (Sec. 3.2, Fig. 1).
2. Condition encoding split:
- `Local`: history + per-step liquidity/imbalance/time features.
- `Global`: horizon-level trend/volatility features.
3. Control pathway: ControlNet-like additive module with zero-initialized 1x1 convs, trained in stage 2 after freezing base network (Sec. 3.2).
4. Diffusion training: DDPM objective with classifier-free guidance; 100 noise levels; ancestral sampling (Sec. 4.2, Appendix A.1-A.2).

## 2.3 Data and Evaluation

1. Data source: LOBSTER snapshots (top-10 bid/ask levels), sampled at 1-second frequency.
2. Universe: AMZN, AAPL, GOOG.
3. Split: 16 train days, 1 validation day, 2 test days (Feb 2023 window).
4. Evaluation axes:
- Controllable realism (distributional distances + stylized facts).
- Counterfactual validity under extreme regime interventions.
- Counterfactual usefulness for regime prediction (Sec. 5; Tables 1-3 and appendix full table).

## 3) Key Findings (Evidence-Backed)

1. **Controlled realism is strong under observed regimes.**
- DiffLOB is usually best or near-best across KS/Wasserstein/KL/JS for price and volume realism across three tickers (Table 1).
- Removing control module degrades most metrics (Table 1).

2. **Counterfactual validity is mixed but generally favorable.**
- For volatility/liquidity/imbalance interventions, DiffLOB often leads.
- Trend interventions are weaker; cGAN beats DiffLOB on AMZN high/low trend in Table 2.
- Appendix full table confirms non-uniform wins across assets/regimes.

3. **Downstream usefulness is plausible but noisy.**
- `Real + CF` improves many extreme-regime subsets in Table 3, especially low-regime cases.
- Several baseline absolute metrics remain poor/unstable (for example negative `R^2`), so robustness is not proven.

## 4) Novelty Assessment

1. Regime-conditioned counterfactual LOB diffusion is a meaningful systems contribution relative to prior observational LOB generators.
2. Two-stage base-then-control optimization is a practical stabilization mechanism.
3. Novelty is moderate rather than foundational: components (DDPM, WaveNet, FiLM, ControlNet-like residual control, classifier-free guidance) are existing techniques assembled for this market microstructure use case.

## 5) Repository Fit and Viability

## 5.1 Current Torghut Constraints

1. Ingestion schema is indicator-centric, not full depth-L2 trajectory centric:
- Flat signal columns include `microstructure_signal_v1` but no complete top-K LOB tensor stream ([services/torghut/app/trading/ingest.py](/workspace/lab/services/torghut/app/trading/ingest.py)).

2. Microstructure contract is compact execution metadata (`spread_bps`, `depth_top5_usd`, `order_flow_imbalance`, etc.), not sequence-generation-ready state tensors ([microstructure.py](/workspace/lab/services/torghut/app/trading/microstructure.py)).

3. Service dependencies currently omit diffusion-training stack requirements (for example `torch`), and runtime is designed as trading API/orchestration service, not GPU model training host ([pyproject.toml](/workspace/lab/services/torghut/pyproject.toml)).

4. Positive fit: repo already supports deterministic whitepaper-derived scaffolds and evidence artifacts (example Janus-Q scaffold), which is a viable integration pattern for DiffLOB-adjacent research contracts ([janus_q.py](/workspace/lab/services/torghut/app/trading/autonomy/janus_q.py)).

## 5.2 Decision

- Verdict: **conditional_implement**
- Score: **0.58 / 1.00**
- Confidence: **0.83 / 1.00**
- Policy: `whitepaper_v1`

Interpretation: Implement as a bounded research lane with deterministic artifacts and offline model experimentation. Do not promote to live trading logic without major data/infrastructure additions and stronger empirical validation.

## 6) Assumptions and Unresolved Risks

## 6.1 Explicit Assumptions

1. Regime controls computed from future windows are acceptable for counterfactual simulation experiments.
2. Limited 2023 3-stock evidence is directionally informative for architecture ranking.
3. Offline training pipelines can be added without coupling diffusion workloads to Torghut serving runtime.

## 6.2 Unresolved Risks

1. **Data availability risk (high):** No existing in-repo source for full per-second top-10 LOB tensor history compatible with paper setup.
2. **External validity risk (high):** Results come from short time span and small ticker set.
3. **Benchmark consistency risk (medium):** Some counterfactual trend regimes favor non-diffusion baseline (cGAN), reducing dominance claims.
4. **Operational fit risk (high):** Diffusion training/inference and artifact lifecycle are not yet productionized in current Torghut runtime.
5. **Usefulness metric instability (medium):** Downstream table includes weak absolute regression outcomes; improvement claims are relative and regime-local.

## 7) Implementation Plan (Phased, Deterministic)

Phase A (research contract, low-risk integration)
1. Add DiffLOB experiment spec doc + artifact schema under `services/torghut/app/trading/autonomy/`.
2. Define deterministic run manifest fields: data snapshot hash, config hash, seed, model artifact hash, and metric bundle hash.
3. Add parser/validator tests for the artifact contract only (no model training in runtime path).

Phase B (offline model lane)
1. Build external/offline training job for diffusion model with frozen input schema.
2. Emit signed artifact package consumed by Torghut as read-only analysis evidence.
3. Add CI checks for artifact schema compliance and reproducibility metadata completeness.

Phase C (promotion gate experiments)
1. Evaluate counterfactual usefulness in walk-forward slices aligned to Torghut horizons.
2. Require regime-wise stability thresholds and fail-closed gating before any execution-policy linkage.
3. Keep usage limited to simulation/paper-trading diagnostics until gates pass.

## 8) Section-Level Citation Map

1. Introduction and contribution framing: Sec. 1.
2. Conditioning formulation and objective: Sec. 3.1, Eq. formulation.
3. Architecture and dual-stage control training: Sec. 3.2, Fig. 1.
4. Data/splits/hyperparameters: Sec. 4.1-4.2.
5. Realism metrics and outcomes: Sec. 5.1, Table 1, Figs. 2-4.
6. Counterfactual validity: Sec. 5.2, Table 2, Figs. 5-7.
7. Usefulness outcomes: Sec. 5.3, Table 3.
8. Diffusion theory + algorithms: Appendix Sec. A.1-A.2.
9. Complete three-stock counterfactual table: Appendix Sec. A.4, Table 4.
