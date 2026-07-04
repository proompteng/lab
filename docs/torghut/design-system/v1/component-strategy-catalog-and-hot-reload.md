# Component: Strategy Catalog and Hot Reload

## Status

- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (config): `argocd/applications/torghut/**`
- Implementation status: `Implemented` (verified with code + tests + runtime/config on 2026-02-21)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Purpose

Describe the declarative strategy catalog, how it is mounted into the trading service, how it syncs into Postgres,
and how hot reload behaves under failure.

## Non-goals

- Allowing runtime code injection (strategies are configuration, not arbitrary scripts).
- Building a full “strategy marketplace” UI in v1.

## Terminology

- **Catalog file:** YAML/JSON file listing strategies and their limits.
- **Mode `sync`:** Disable strategies removed from the file.
- **Mode `merge`:** Only upsert listed strategies; do not disable missing.

## Current implementation + manifests (pointers)

- Catalog loader: `services/torghut/app/strategies/catalog.py` (`StrategyCatalog.refresh`)
- Knative volume mount: `argocd/applications/torghut/knative-service.yaml`
- Catalog ConfigMap: `argocd/applications/torghut/strategy-configmap.yaml`

## Data flow

```mermaid
sequenceDiagram
  participant CM as ConfigMap strategies.yaml
  participant SVC as torghut service
  participant DB as Postgres

  CM->>SVC: mounted at /etc/torghut/strategies.yaml
  SVC->>SVC: parse + validate (pydantic)
  SVC->>DB: upsert strategies (merge/sync)
  SVC-->>SVC: reload every TRADING_STRATEGY_RELOAD_SECONDS
```

## Configuration

From `argocd/applications/torghut/knative-service.yaml`:
| Env var | Purpose | Current |
| --- | --- | --- |
| `TRADING_STRATEGY_CONFIG_PATH` | path to catalog | `/etc/torghut/strategies.yaml` |
| `TRADING_STRATEGY_CONFIG_MODE` | `merge`/`sync` | `sync` |
| `TRADING_STRATEGY_RELOAD_SECONDS` | reload interval | `10` |

## Failure modes, detection, recovery

| Failure           | Symptoms                 | Detection                                | Recovery                                                    |
| ----------------- | ------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| Invalid YAML/JSON | strategy changes ignored | logs warn `Strategy catalog load failed` | fix ConfigMap content; re-sync Argo; confirm digest changes |
| Duplicate names   | catalog apply fails      | logs show duplicate strategy name error  | de-duplicate entries; re-sync                               |
| DB unavailable    | catalog not applied      | logs show DB errors                      | restore Postgres; catalog will reapply on next refresh      |

## Security considerations

- Strategy catalog is configuration and must be code-reviewed like production policy (it changes trading behavior).
- Do not store secrets in the catalog.
- Treat catalog as part of model risk controls (limits live here).

## Decisions (ADRs)

### ADR-14-1: Strategies are declarative config, not executable code

- **Decision:** Strategies are expressed as validated configs persisted to DB; no arbitrary code loading.
- **Rationale:** Prevents code injection and keeps oncall operations predictable.
- **Consequences:** Complex strategies require productized strategy primitives, not custom scripts.
