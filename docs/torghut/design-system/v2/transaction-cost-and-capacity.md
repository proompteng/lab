# Transaction Costs and Capacity (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**
- Audit update: **2026-02-26**

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Torghut GitOps, migrations, release workflows, and scripts exist; post-deploy verification wiring has changed over time.
- Matched implementation area: CI/CD, release, GitOps, Argo, Knative, and deployment automation.
- Current source evidence:
  - `argocd/applications/torghut/knative-service.yaml`
  - `argocd/applications/torghut/db-migrations-job.yaml`
  - `.github/workflows/torghut-ci.yml`
  - `.github/workflows/torghut-release.yml`
  - `packages/scripts/src/torghut/update-manifests.ts`
- Design drift note: Deployment docs must be checked against current workflows because old names have been retired or replaced.


## Purpose

Ensure strategies remain profitable after costs and at scale.

## Cost Components

- Spread (half-spread paid on aggressive fills).
- Fees and rebates.
- Slippage from volatility during execution.
- Market impact (temporary and permanent).
- Borrow costs and shortability constraints.

## Capacity

Capacity is the notional you can deploy before impact erases edge.

Practical proxy metrics:

- participation rate,
- average daily volume vs trade size,
- expected impact per trade.

## Torghut Extensions

- Extend the existing cost model module:
  - inputs: spread estimates from quotes, volatility, ADV.
  - outputs: expected cost bands used by risk engine and backtester.
- Record realized slippage and compare to model predictions.

## Cost Model MVP (Good Enough To Start)

Per order intent, estimate:

- `spread_cost_bps`: aggressive half-spread cost (or 0 for passive limit with fill risk).
- `vol_cost_bps`: volatility \* expected execution time (simple proxy).
- `impact_cost_bps`: scaled with participation rate (trade_size / ADV).

Use the cost bands for:

- pre-trade veto (expected costs exceed expected edge),
- sizing throttles (reduce participation),
- strategy selection (avoid cost-sensitive strategies in wide-spread regimes).

## References

- Optimal execution with impact (foundational): https://docslib.org/doc/1384720/optimal-execution-of-portfolio-transactions
- Execution with market impact (Almgren-Chriss, 2001): https://www.math.nyu.edu/faculty/chriss/optliq_f.pdf
