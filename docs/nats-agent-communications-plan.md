# NATS agent comms - Execution Plan

Owner: Platform + Agents
Status: Current ownership snapshot

This plan operationalizes the design in `docs/nats-agent-communications.md` and the
parallel workstreams in `docs/nats-agent-communications-workstreams.md`.

## Scope

- Real-time agent comms via NATS JetStream.
- Agents ingestion and storage for per-run plus global channel messages.
- Jangar UI consumes the Agents message API for operator visibility.
- AgentRun runtime publishes messages while running.

## Success criteria

- **Stream + consumer** exist and are healthy in JetStream.
- **Agents stores** incoming messages in Postgres (`agents_comms.agent_messages`).
- **Jangar UI** shows Agents-backed views:
  - `/agents` (list)
  - `/agents/:runId`
  - `/agents/general`
- **Global channel** shows cross-AgentRun messages in real time.
- **Proof**: publish a message from an AgentRun step and see it appear live in Jangar via the Agents API.

## Phases

### Phase 1 — Infrastructure (Workstream A)

- Add JetStream Stream + Consumer CRDs.
- Verify stream/consumer Ready in `nack`.

### Phase 2 - Backend ingestion (Workstream C)

- Add migrations + store under `services/agents`.
- Add Agents NATS subscriber service.
- Add Agents `/v1/agent-messages` and SSE endpoints.

### Phase 3 — UI (Workstream D)

- Add routes + sidebar entry.
- Stream messages via SSE.

### Phase 4 - Runtime publishing (Workstream B)

- Add NATS publisher helper.
- Wire into native runtime templates.

### Phase 5 — Backfill (Workstream E, optional)

- Backfill messages using existing agent logs on run-complete.

### Phase 6 — Security + Observability (Workstreams F/G, optional)

- Add auth/TLS and basic NATS metrics in Grafana.

## Proof checklist

- [ ] `kubectl get streams/consumers -n <ns>` shows `agent-comms` + `agents-agent-comms`.
- [ ] `agents_comms.agent_messages` table exists and receives new rows.
- [ ] Agents SSE endpoint streams new messages.
- [ ] Jangar `/agents/general` displays live updates.
- [ ] One AgentRun publishes a message that appears in Jangar.

## Issue tracking

- Each workstream is tracked as a GitHub issue.
- Each issue should link to PR(s) implementing the work.

## Optional adapters

- If using the Argo Workflows adapter, add a proof that an Argo workflow publishes using the
  same schema and appears in Jangar.
