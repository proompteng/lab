# Governance, Compliance, and Ops For Autonomous Trading (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: secrets/RBAC/policies exist in GitOps and code, but compliance/governance designs are broader than current automated enforcement.
- Matched implementation area: Security, secrets, RBAC, audit, governance, and compliance.
- Current source evidence:
  - `argocd/applications/torghut/role.yaml`
  - `argocd/applications/torghut/rolebinding.yaml`
  - `argocd/applications/torghut/sealed-secrets.yaml`
  - `services/torghut/app/trading/autonomy/policy_checks.py`
  - `services/torghut/scripts/run_governance_policy_dry_run.py`
- Design drift note: Governance/compliance designs need tests and GitOps policy wiring before being treated as fully enforced.


## Purpose

Describe the governance and operational controls needed for unattended trading.

## Governance Must-Haves

- Clear ownership of each strategy and each risk limit.
- Change control for any configuration that can change trading behavior.
- Periodic review of market access controls and logs.
- Model risk management for any ML/LLM component:
  - inventory (what models, where used),
  - evaluation evidence before promotion,
  - rollback plan and drift monitoring.

## Operational Must-Haves

- Oncall-ready dashboards and alerts: signal freshness, reconcile lag, order reject taxonomy.
- One-command kill (cancel open orders + stop new orders).
- Post-incident review with exact reproduction artifacts.
- Daily automated reporting:
  - PnL attribution and realized slippage,
  - risk and broker reject summaries,
  - model/LLM veto rates and circuit state.

## Torghut Extensions

- Add explicit "actuation" gating for automation (AgentRuns): separate diagnostics from changes.
- Add a daily "audit report" job that summarizes:
  - realized PnL,
  - risk rejects,
  - broker rejects,
  - LLM veto/adjust stats,
  - drift alerts.

## References

- SEC Market Access Rule 15c3-5 summary: https://www.sec.gov/rules-regulations/2011/06/risk-management-controls-brokers-or-dealers-market-access
- MiFID II RTS 6 delegated regulation (algo trading controls): https://eur-lex.europa.eu/eli/reg_del/2017/589/oj/eng
- BIS on AI and genAI risks in finance (2024): https://www.bis.org/fsi/publ/insights63.htm
