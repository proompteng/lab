---
name: news-sentiment
description: Extract structured, source-attributed sentiment context for one symbol.
---

# news-sentiment

Extract structured, source-attributed sentiment context for one symbol.

## Output contract
Return JSON keys:
- `context_version`
- `as_of_utc`
- `symbol`
- `freshness_seconds`
- `source_count`
- `quality_score`
- `payload.items` (headline, sentiment, source)
- `citations`

## Rules
- Prefer recency over volume.
- Mark missing sources explicitly.
