# Whitepaper Synthesis: Techniques and Discoveries for Torghut v5

## Purpose
This document provides a per-paper synthesis of primary research used in the v5 strategy build pack. For each paper,
it captures the main technique/discovery and the direct implementation implication for Torghut.

## Priority Mapping Legend
- `P1`: TSFM router + refinement + uncertainty outputs
- `P2`: conformal uncertainty + regime-shift gates
- `P3`: microstructure execution intelligence
- `P4`: LLM multi-agent committee + deterministic veto
- `P5`: fragility-aware regime allocation

## Synthesis Catalog
| Paper | Main Technique or Discovery | Torghut Implication | Priority |
| --- | --- | --- | --- |
| Chronos: Learning the Language of Time Series (arXiv:2403.07815) | Tokenization + language-model style pretraining for generic time-series forecasting. | Use as a baseline adapter in `ForecastRouterV5`; compare route-level quality by symbol/horizon. | P1 |
| MOMENT: A Family of Open Time-series Foundation Models (arXiv:2402.03885) | Open TSFM family with transferability across tasks and datasets. | Add as second model family in routing policy for diversity and fallback robustness. | P1 |
| Re(Visiting) Time Series Foundation Models in Finance (arXiv:2511.18578) | Finance-domain retraining can outperform generic TSFMs for financial excess returns. | Introduce financial fine-tuned adapter variants and require evidence against generic baseline. | P1 |
| RefineBridge (arXiv:2512.21572) | Bridge-style generative refinement improves financial forecasts from TSFM priors. | Implement optional refinement stage after base adapter inference with strict latency controls. | P1 |
| ProbFM (arXiv:2601.10591) | Single-pass decomposition of epistemic vs aleatoric uncertainty. | Emit decomposed uncertainty fields in forecast contract and use in gate thresholds. | P1, P2 |
| FinZero (arXiv:2509.08742) | Large reasoning model with uncertainty-aware optimization for financial forecasting. | Incorporate uncertainty-weighted evaluation metrics for route scoring and promotion decisions. | P1, P2 |
| Flow-based Conformal Prediction for Multi-dimensional Time Series (arXiv:2502.05709) | Conformalized predictive sets for multi-dimensional series with coverage guarantees. | Build `ConformalEngineV5` and calibrate per-symbol/horizon intervals. | P2 |
| Conformal Prediction for Time-series Forecasting with Change Points (arXiv:2509.02844) | Change-point-aware conformal procedure for non-stationary series. | Add shift-triggered recalibration and deterministic degrade/abstain policies. | P2, P5 |
| Temporal Conformal Prediction (TCP) (arXiv:2507.05470) | Distribution-free temporal risk forecasting with adaptive uncertainty handling. | Track temporal coverage drift and enforce uncertainty SLO gates in autonomy. | P2 |
| FR-LUX (arXiv:2510.02986) | Friction-aware, regime-conditioned optimization to make policies implementable under costs. | Add regime-conditioned execution/adaptation constraints and participation caps. | P3, P5 |
| A Deterministic LOB Simulator with Hawkes-Driven Order Flow (arXiv:2510.08085) | Reproducible LOB simulator for stress-testing execution assumptions. | Add simulator-backed TCA divergence monitoring and policy calibration lane. | P3 |
| Diffusive Limit of Hawkes Driven Order Book Dynamics With Liquidity Migration (arXiv:2511.18117) | Theoretical diffusion approximation for Hawkes LOB dynamics with migration effects. | Use as grounding for liquidity-state transitions and risk-aware execution throttles. | P3 |
| Explainable Patterns in Cryptocurrency Microstructure (arXiv:2602.00776) | Interpretable microstructure features with cross-asset predictive value. | Extend microstructure feature stack and adverse-selection risk signals. | P3 |
| Resolving Latency and Inventory Risk in Market Making with RL (arXiv:2505.12465) | RL policy balancing latency and inventory risk under practical constraints. | Add bounded execution advisor logic around urgency and participation. | P3 |
| Market Making without Regret (arXiv:2411.13993) | No-regret style market-making framework with robust learning guarantees. | Add conservative adaptation bounds and regret diagnostics for advisor updates. | P3 |
| TradingAgents: Multi-Agents LLM Financial Trading Framework (arXiv:2412.20138) | Role-based LLM trading agents can improve reasoning breadth. | Implement committee topology with separated roles and policy-bound outputs. | P4 |
| QuantAgent: Price-Driven Multi-Agent LLMs for HFT (arXiv:2509.09995) | Price-driven multi-agent architecture for short-horizon financial decisions. | Add structured high-frequency decision context fields and stricter timing budgets. | P4 |
| QuantAgents: Towards Multi-agent Financial System via Simulated Trading (arXiv:2510.04643) | Simulated market environment for evaluating multi-agent finance workflows. | Use simulation-backed replay suite for committee policy regression and tuning. | P4 |
| TradingGroup: Multi-Agent Trading with Self-Reflection and Data-Synthesis (arXiv:2508.17565) | Multi-agent self-reflection can improve strategy iteration quality. | Add bounded self-critique stage with deterministic veto precedence. | P4 |
| ATLAS: Adaptive Trading with LLM AgentS (arXiv:2510.15949) | Dynamic prompt optimization and multi-agent coordination for trading adaptation. | Restrict adaptive prompt updates to paper-only lanes with approval and replay evidence. | P4 |
| Enhancing Financial RAG with Agentic AI and Multi-HyDE (arXiv:2509.16369) | Multi-query retrieval design reduces hallucination and improves retrieval quality. | Upgrade financial context retrieval for committee inputs with provenance and confidence scores. | P4 |
| BIS Working Paper 1229: Artificial intelligence and market fragility | Evidence that AI adoption can amplify fragility under stress and crowding conditions. | Justifies stability mode and fragility-aware allocation clamps. | P5 |
| NBER Working Paper 33351: Artificial Intelligence and Asset Prices | AI can alter price efficiency and crowding dynamics in asset pricing. | Add crowding proxies and regime-aware risk budget throttles in allocator policy. | P5 |
| Towards Temporal-Aware Multi-Modal RAG in Finance (arXiv:2503.05185) | Temporal alignment in financial RAG improves relevance and downstream reliability. | Improve LLM committee context quality and temporal grounding for policy checks. | P4 |

## Technique Clusters
### Forecasting and Uncertainty (P1/P2)
- Core discovery: gains come from adaptive model selection and calibrated uncertainty, not single-model confidence.
- Engineering implication: route decisions and uncertainty need first-class audit contracts and promotion gates.

### Execution and Microstructure (P3)
- Core discovery: realized edge depends on friction-aware policy and microstructure-state adaptation.
- Engineering implication: TCA must be simulator-calibrated and continuously compared to realized fills.

### LLM Committee Intelligence (P4)
- Core discovery: multi-agent setups improve coverage but need strict role boundaries and fail-closed policy checks.
- Engineering implication: deterministic veto remains authoritative, with full traceability and replay tests.

### Fragility and Allocation (P5)
- Core discovery: AI-driven crowding and liquidity fragility require explicit stability controls.
- Engineering implication: allocator/risk policy should consume fragility state and degrade safely under stress.

## Source Links
- https://arxiv.org/abs/2403.07815
- https://arxiv.org/abs/2402.03885
- https://arxiv.org/abs/2511.18578
- https://arxiv.org/abs/2512.21572
- https://arxiv.org/abs/2601.10591
- https://arxiv.org/abs/2509.08742
- https://arxiv.org/abs/2502.05709
- https://arxiv.org/abs/2509.02844
- https://arxiv.org/abs/2507.05470
- https://arxiv.org/abs/2510.02986
- https://arxiv.org/abs/2510.08085
- https://arxiv.org/abs/2511.18117
- https://arxiv.org/abs/2602.00776
- https://arxiv.org/abs/2505.12465
- https://arxiv.org/abs/2411.13993
- https://arxiv.org/abs/2412.20138
- https://arxiv.org/abs/2509.09995
- https://arxiv.org/abs/2510.04643
- https://arxiv.org/abs/2508.17565
- https://arxiv.org/abs/2510.15949
- https://arxiv.org/abs/2509.16369
- https://arxiv.org/abs/2503.05185
- https://www.bis.org/publ/work1229.htm
- https://www.nber.org/papers/w33351
