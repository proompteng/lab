# Whitepaper Replay Workflows

This directory contains 1 deduplicated direct-intake payloads for the Torghut `whitepaper-analysis-v1` workflow.

- Each payload uses a synthetic issue number so the intake path creates a fresh run instead of colliding with the historical issue idempotency key.
- Each payload preserves the real source issue URL in `issue.html_url` and lists all source issues in the body for provenance.

Generate or refresh the bundle:

```bash
bun run whitepapers:replay
```

Generate and post the payloads:

```bash
WHITEPAPER_WORKFLOW_API_TOKEN=<token> \
TORGHUT_BASE_URL=http://localhost:8181 \
bun run whitepapers:replay --post
```
