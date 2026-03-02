---
name: huly-api
description: 'Use Huly API for swarm communication (issues, chats, docs) with token-based auth.'
---

# Huly API

## Overview

Use this skill when a swarm agent must communicate through Huly modules (issues, chats, docs, inbox updates).

## Required Environment

Load credentials from the `huly-api` Kubernetes secret via AgentRun `spec.secrets`.

- `HULY_API_BASE_URL` or `HULY_BASE_URL` (for example `https://huly.proompteng.ai`)
- `HULY_API_TOKEN` (bearer token)
- Optional:
  - `HULY_WORKSPACE`
  - `HULY_PROJECT`

## API Helper Script

Use `scripts/huly-api.py` for authenticated API calls.

Examples:

```bash
python3 skills/huly-api/scripts/huly-api.py --method GET --path /api/version
python3 skills/huly-api/scripts/huly-api.py --method POST --path /api/issues --data '{"title":"Swarm update"}'
```

If `HULY_API_TOKEN` is empty, calls are blocked and the run must stop with a clear unblock request.

## Operating Rules

- Always include `swarmAgentWorkerId` and `swarmAgentIdentity` in the Huly message body.
- Create or update Huly artifact(s) before posting completion status.
- Keep updates concise and link PR/deploy evidence for traceability.
