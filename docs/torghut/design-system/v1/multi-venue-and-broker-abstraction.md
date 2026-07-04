# Multi-Venue and Broker Abstraction

## Status

- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (config): `argocd/applications/torghut/**`

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Purpose

Define an extension-friendly design for adding additional brokers/venues while maintaining the v1 safety invariants:

- deterministic risk gates remain final,
- paper-first defaults,
- auditability across venues.

## Non-goals

- Implementing a second broker in v1.
- Venue-specific microstructure modeling or smart order routing.

## Terminology

- **Venue:** Market/broker/exchange destination for orders.
- **Adapter:** Abstraction layer that normalizes broker APIs (orders, positions, executions).
- **Capability matrix:** Feature support differences across brokers.

## Design sketch (vNext)

```mermaid
flowchart LR
  Loop["Trading loop"] --> Risk["Deterministic risk"]
  Risk --> Exec["Execution interface"]
  Exec --> Alpaca["Alpaca adapter"]
  Exec --> Other["Future adapter(s)"]
  Other --> Broker["Broker API"]
```

## Required invariants (carry forward from v1)

- Idempotency keys remain stable; per-venue idempotency mapping must be defined.
- Reconciliation remains broker-authoritative.
- Kill switches remain centralized (disable trading globally or per venue).

## Configuration approach

- Per-venue configuration should be explicit and audited:
  - `TRADING_VENUE=alpaca` (future)
  - separate credentials per venue in Secrets

## Failure modes and recovery

| Failure          | Symptoms                        | Recovery                                            |
| ---------------- | ------------------------------- | --------------------------------------------------- |
| Adapter mismatch | order rejected or mis-specified | disable trading; fix mapping; add conformance tests |
| Venue outage     | executions fail                 | fallback to paper; circuit-break venue; alert       |

## Security considerations

- Separate credentials and scopes per venue.
- Avoid “unified super-key” credentials.

## Decisions (ADRs)

### ADR-45-1: Adapters are explicit and audited

- **Decision:** Each venue uses an explicit adapter with a documented capability matrix.
- **Rationale:** Prevents hidden behavior changes when adding venues.
- **Consequences:** More code, but safer operations.
