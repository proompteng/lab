# Open-Source Quant Library Standard and Selection

## Objective

Define a production-grade open-source library policy for Torghut that maximizes research velocity while preserving
runtime determinism, operational safety, and licensing clarity.

## Selection Policy

A library is eligible only if it satisfies:

- active maintenance and healthy issue/PR flow,
- clear production/research boundary,
- compatible license for internal/commercial use,
- reproducible installation and version pinning,
- evidence of real-world quant usage.

## Reference Stack Decision Matrix

| Library              | Role                                                   | License    | Runtime Tier                                     | Decision                           |
| -------------------- | ------------------------------------------------------ | ---------- | ------------------------------------------------ | ---------------------------------- |
| LEAN (QuantConnect)  | benchmark engine, cross-check backtests/live semantics | Apache-2.0 | research + benchmark                             | Adopt as benchmark standard        |
| Qlib (Microsoft)     | ML alpha research pipeline                             | MIT        | research-only                                    | Adopt in ML lane                   |
| RD-Agent (Microsoft) | autonomous research decomposition/orchestration        | MIT        | research automation                              | Adopt for research lane automation |
| NautilusTrader       | event-driven trading/backtest framework                | LGPL-3.0   | optional execution lab                           | Evaluate phase 3                   |
| vectorbt             | vectorized strategy sweeps                             | Apache-2.0 | research-only                                    | Adopt now                          |
| PyPortfolioOpt       | portfolio optimization                                 | MIT        | offline optimizer + explicit runtime translation | Adopt now                          |
| QuantStats           | reporting/tearsheets                                   | Apache-2.0 | research/reporting                               | Adopt now                          |
| Optuna               | hyperparameter search                                  | MIT        | research-only                                    | Adopt now                          |
| MLflow               | experiment tracking/model registry                     | Apache-2.0 | research infra                                   | Adopt now                          |
| Feast                | feature registry parity                                | Apache-2.0 | optional infra lane                              | Evaluate phase 2                   |
| CCXT                 | multi-venue market interface (crypto)                  | MIT        | optional adapter track                           | Optional                           |
| Freqtrade            | crypto operations patterns                             | GPL-3.0    | reference-only                                   | Optional reference                 |

## Runtime Boundary Rules

Allowed in online Torghut runtime by default:

- internal strategy SDK,
- `numpy`, `pandas`, and explicit deterministic math utilities,
- minimal serialization libraries.

Research-only by default:

- LEAN CLI/runtime,
- Qlib,
- RD-Agent,
- vectorbt,
- Optuna,
- MLflow,
- Feast.

## LEAN + Qlib + RD-Agent Combined Pattern

Recommended usage in Torghut:

- LEAN: cross-engine validation benchmark for strategy behavior and cost assumptions.
- Qlib: feature engineering and ML alpha candidate generation.
- RD-Agent: orchestrate hypothesis generation, experiment execution, and report collation.

Hard boundary:

- output of research stack is strategy artifacts and promotion evidence,
- Torghut runtime executes only approved deterministic strategy plugins.

## Library Governance Checklist (Before Adoption)

1. Security review:

- CVE and transitive dependency scan.

2. Legal review:

- license compatibility and obligations.

3. Performance review:

- expected runtime/memory under target workloads.

4. Operational review:

- reproducibility, pinning, rollback, observability.

5. Handoff review:

- AgentRun procedure for upgrades and rollback.

## Pinning and Upgrade Standard

- all dependencies pinned by exact version in lock-managed environment.
- upgrades via dedicated PR with changelog summary and regression tests.
- rollback documented by previous lock revision + feature flag fallback.

## Evidence Sources

Primary repos/docs:

- LEAN: <https://github.com/QuantConnect/Lean>
- Qlib: <https://github.com/microsoft/qlib>
- RD-Agent: <https://github.com/microsoft/RD-Agent>
- NautilusTrader: <https://github.com/nautechsystems/nautilus_trader>
- vectorbt: <https://github.com/polakowo/vectorbt>
- PyPortfolioOpt: <https://github.com/robertmartin8/PyPortfolioOpt>
- QuantStats: <https://github.com/ranaroussi/quantstats>
- Optuna: <https://github.com/optuna/optuna>
- MLflow: <https://github.com/mlflow/mlflow>
- Feast: <https://github.com/feast-dev/feast>

Community/forum signal inputs:

- QuantConnect forum: <https://www.quantconnect.com/forum/>
- Quantitative Finance StackExchange: <https://quant.stackexchange.com/>

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-library-governance-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `dependencyManifestPath`
- Expected execution:
  - produce dependency adoption/denylist policy in repo,
  - pin accepted research dependencies,
  - add CI policy checks for runtime boundary violations.
- Expected artifacts:
  - governance policy doc under `docs/torghut/`,
  - dependency manifest updates,
  - CI validation scripts.
- Exit criteria:
  - runtime image excludes research-only heavy libraries,
  - research environment reproducible,
  - upgrade/rollback playbook tested.
