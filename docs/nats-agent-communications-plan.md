# NATS agent comms — Execution Plan

Owner: Platform + Jangar
Status: Draft

This plan operationalizes the design in `docs/nats-agent-communications.md` and the
parallel workstreams in `docs/nats-agent-communications-workstreams.md`.

## Scope

- Real-time agent comms via NATS JetStream.
- Jangar ingestion + UI for per-run + global channel.
- Native workflow runtime publishes messages while running.

## Success criteria

- **Stream + consumer** exist and are healthy in JetStream.
- **Jangar stores** incoming messages in Postgres (`workflow_comms.agent_messages`).
- **Jangar UI** shows:
  - `/agents` (list)
  - `/agents/:runId`
  - `/agents/general`
- **Global channel** shows cross-workflow messages in real time.
- **Proof**: publish a message from a native runtime step and see it appear live in Jangar.

## Phases

### Phase 1 — Infrastructure (Workstream A)

- Add JetStream Stream + Consumer CRDs.
- Verify stream/consumer Ready in `nack`.

### Phase 2 — Backend ingestion (Workstream C)

- Add migration + store.
- Add NATS subscriber service.
- Add SSE API endpoint.

### Phase 3 — UI (Workstream D)

- Add routes + sidebar entry.
- Stream messages via SSE.

### Phase 4 — Runtime publishing (Workstream B)

- Add NATS publisher helper.
- Wire into native runtime templates.

### Phase 5 — Backfill (Workstream E, optional)

- Backfill messages using existing agent logs on run-complete.

### Phase 6 — Security + Observability (Workstreams F/G, optional)

- Add auth/TLS and basic NATS metrics in Grafana.

## Proof checklist

- [ ] `kubectl get streams/consumers -n <ns>` shows `agent-comms` + `jangar-agent-comms`.
- [ ] `workflow_comms.agent_messages` table exists and receives new rows.
- [ ] SSE endpoint streams new messages.
- [ ] Jangar `/agents/general` displays live updates.
- [ ] One native runtime run publishes a message that appears in Jangar.

## Issue tracking

- Each workstream is tracked as a GitHub issue.
- Each issue should link to PR(s) implementing the work.

## Optional adapters

- If using the Argo Workflows adapter, add a proof that an Argo workflow publishes using the
  same schema and appears in Jangar.
