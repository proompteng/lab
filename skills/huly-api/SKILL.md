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
Default destinations for this workspace:

- Tracker issues board: `DefaultProject` (`https://huly.proompteng.ai/workbench/proompteng/tracker/tracker%3Aproject%3ADefaultProject/issues`)
- Documents teamspace: `PROOMPTENG`
- Chat channel URL: `https://huly.proompteng.ai/workbench/proompteng/chunter/chunter%3Aspace%3AGeneral%7Cchunter%3Aclass%3AChannel?message`

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
  - per-agent tokens: `HULY_API_TOKEN_<SWARM_AGENT_IDENTITY>` or `HULY_API_TOKEN_<SWARM_AGENT_WORKER_ID>`

## Helper Script

Use `scripts/huly-api.py`.

### Mission-level sync (recommended)

```bash
python3 skills/huly-api/scripts/huly-api.py \
  --operation upsert-mission \
  --worker-id "${SWARM_AGENT_WORKER_ID}" \
  --worker-identity "${SWARM_AGENT_IDENTITY}" \
  --mission-id jangar-discover-20260302 \
  --title "Jangar discover cycle" \
  --summary "Top platform risks and next actions" \
  --details "Includes evidence, risk deltas, and PR links" \
  --stage discover \
  --status running \
  --project "DefaultProject" \
  --teamspace "PROOMPTENG" \
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
python3 skills/huly-api/scripts/huly-api.py --operation account-info --worker-id "${SWARM_AGENT_WORKER_ID}" --require-worker-token
python3 skills/huly-api/scripts/huly-api.py --operation verify-chat-access --worker-id "${SWARM_AGENT_WORKER_ID}" --worker-identity "${SWARM_AGENT_IDENTITY}" --require-worker-token --channel "general"
```

### Raw HTTP mode (debug)

```bash
python3 skills/huly-api/scripts/huly-api.py --operation http --method GET --path /api/v1/account/<workspace-id>
```

## Operating Rules

- Every mission stage must publish artifacts to all three Huly modules: tasks, channels, and docs.
- Each swarm agent should authenticate with its own Huly organization account (no shared actor credentials).
- Always target Tracker `DefaultProject` issues and Docs `PROOMPTENG` teamspace unless a run explicitly overrides them.
- Use `--require-worker-token` for dedicated-account checks so shared fallback tokens are rejected.
- For strict identity mapping, set per-worker `HULY_EXPECTED_ACTOR_ID_<SWARM_AGENT_IDENTITY>` and use `--require-expected-actor-id`.
- Run `verify-chat-access` before autonomous delivery stages to prove the worker account can write to `#general`.
- Include `swarmAgentWorkerId` and `swarmAgentIdentity` in the issue/document/message body.
- Keep channel updates concise and link issue/doc/PR/deploy evidence.
- If Huly auth fails, stop and return a clear unblock request instead of silently continuing.
