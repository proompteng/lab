---
name: market-context
description: Build a normalized market-context JSON bundle for a single symbol and timestamp.
---

# market-context

Build a normalized market-context JSON bundle for a single symbol and timestamp.

## Output contract
Return JSON with keys:
- `context_version`
- `as_of_utc`
- `symbol`
- `freshness_seconds`
- `source_count`
- `quality_score`
- `payload`
- `citations`

## Rules
- Use UTC ISO timestamps.
- Include stale or missing domains in `payload.risk_flags`.
- Keep quality scoring deterministic from source freshness.
