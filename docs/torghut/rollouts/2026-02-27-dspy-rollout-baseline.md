# DSPy Rollout Baseline (2026-02-27)

Captured at (UTC): `2026-02-27 04:40:39.050146`

## Torghut LLM review baseline

### llm_decision_reviews rationale distribution (last 24h)

| rationale | count |
|---|---:|
| `market_context_domain_error` | 119 |
| `market_context_quality_low` | 96 |

### DSPy usage/adoption baseline

| metric | value |
|---|---:|
| `llm_decision_reviews` rows with `model like 'dspy:%'` (last 7d) | 0 |
| `llm_dspy_workflow_artifacts` total rows | 0 |

## Jangar market-context baseline

### Dispatch-state counts

| domain | last_status | count |
|---|---|---:|
| fundamentals | submitted | 13 |
| fundamentals | succeeded | 2 |
| news | submitted | 15 |

### Snapshot freshness

| domain | snapshots | avg_age_seconds | max_age_seconds |
|---|---:|---:|---:|
| fundamentals | 2 | 23951.39 | 26602.11 |
| news | 2 | 23313.11 | 25326.15 |

### Recent snapshots

| symbol | domain | as_of (UTC) | updated_at (UTC) | source_count | quality_score |
|---|---|---|---|---:|---:|
| AVGO | fundamentals | 2026-02-26 22:45:46.254+00 | 2026-02-26 22:46:59.279+00 | 3 | 0.83 |
| AVGO | news | 2026-02-26 22:45:46.858+00 | 2026-02-26 22:46:34.469+00 | 4 | 0.78 |
| INTC | news | 2026-02-26 21:38:40.778+00 | 2026-02-26 21:39:48.869+00 | 4 | 0.72 |
| INTC | fundamentals | 2026-02-26 21:17:24.815+00 | 2026-02-26 21:18:25.297+00 | 4 | 0.82 |

## Scope references

- `/services/torghut/app/trading/llm/review_engine.py`
- `/services/torghut/app/trading/llm/dspy_programs/runtime.py`
- `/argocd/applications/jangar/deployment.yaml`
- `/argocd/applications/torghut/knative-service.yaml`
