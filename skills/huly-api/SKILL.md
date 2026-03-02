---
name: huly-api
description: 'Use Huly platform APIs for swarm communication across tasks, channels, and documents.'
---

# Huly API

## Overview

Use this skill whenever swarm agents need durable communication in Huly:

- `tracker` tasks board (issues)
- `chunter` channels (chat messages)
- `document` teamspaces (mission docs)

Every autonomous mission should update all three surfaces.

## Required Environment

Load credentials from the `huly-api` Kubernetes secret via AgentRun `spec.secrets`.

- `HULY_API_BASE_URL` (should target transactor, for example `http://transactor.huly.svc.cluster.local`)
- `HULY_BASE_URL` (optional human-facing base URL, often `http://front.huly.svc.cluster.local`)
- `HULY_API_TOKEN` (bearer token)
- Optional:
  - `HULY_WORKSPACE` (workspace slug for operator context)
  - `HULY_WORKSPACE_ID` (workspace UUID; helper can also infer from JWT)
  - `HULY_PROJECT` (task board project identifier/name/id)
  - `HULY_TEAMSPACE` (document teamspace name/id)
  - `HULY_CHANNEL` (chat channel name/id)

## Helper Script

Use `scripts/huly-api.py`.

### Mission-level sync (recommended)

```bash
python3 skills/huly-api/scripts/huly-api.py \
  --operation upsert-mission \
  --mission-id jangar-discover-20260302 \
  --title "Jangar discover cycle" \
  --summary "Top platform risks and next actions" \
  --details "Includes evidence, risk deltas, and PR links" \
  --stage discover \
  --status running \
  --project "HULY" \
  --teamspace "Quick-Start Docs" \
  --channel "general"
```

This creates/updates:

- one task-board issue
- one mission document
- one channel message

### Single-surface operations

```bash
python3 skills/huly-api/scripts/huly-api.py --operation create-issue --title "..." --mission-id "..."
python3 skills/huly-api/scripts/huly-api.py --operation create-document --title "..." --mission-id "..."
python3 skills/huly-api/scripts/huly-api.py --operation post-channel-message --message "..."
```

### Raw HTTP mode (debug)

```bash
python3 skills/huly-api/scripts/huly-api.py --operation http --method GET --path /api/v1/account/<workspace-id>
```

## Operating Rules

- Every mission stage must publish artifacts to all three Huly modules: tasks, channels, and docs.
- Include `swarmAgentWorkerId` and `swarmAgentIdentity` in the issue/document/message body.
- Keep channel updates concise and link issue/doc/PR/deploy evidence.
- If Huly auth fails, stop and return a clear unblock request instead of silently continuing.
