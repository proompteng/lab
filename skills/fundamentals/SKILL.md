---
name: fundamentals
description: Produce normalized fundamentals factors and deltas for one symbol.
---

# fundamentals

Produce normalized fundamentals factors and deltas for one symbol.

## Output contract
Return JSON keys:
- `context_version`
- `as_of_utc`
- `symbol`
- `freshness_seconds`
- `source_count`
- `quality_score`
- `payload.factors`
- `citations`

## Rules
- Include filing freshness or next expected filing date when known.
- Mark unsupported factors in payload with null values.
