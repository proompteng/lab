# NATS agent comms — Parallel Workstreams

Owner: Platform + Jangar
Status: Draft

This document breaks the NATS agent-communications design into parallel workstreams that can run
independently and converge on a coordinated rollout.

## Workstream A — JetStream CRDs + GitOps wiring

**Goal:** Define the NATS JetStream stream + consumer resources in GitOps.

**Scope**

- Create NACK CRDs for:
  - Stream: `agent-comms` (subjects `workflow.>`)
  - Consumer: `jangar-agent-comms` (durable, explicit acks)
- Place stream CRD under the GitOps bundle that owns NATS.
- Place consumer CRD under the GitOps bundle that owns Jangar.

**Deliverables**

- YAML resources for stream + consumer.
- README snippet or doc update referencing the CRDs.

**Acceptance**

- `kubectl get stream/consumer` shows both resources.
- Stream retains messages for 7 days and 5–10Gi.

**Dependencies**

- NATS + NACK installed (already in platform appset).

---

## Workstream B — Runtime publishing

**Goal:** The native workflow runtime publishes agent events to NATS (per-run + global channel).

**Scope**

- Add NATS publish helper (sidecar or CLI in runtime image).
- Update runtime templates to publish:
  - Run-specific subject
  - Global `workflow.general.*` channel
- Standardize payload schema in a shared script.

**Deliverables**

- Template changes under the native runtime manifests.
- Helper script (shell or node) in a shared location.

**Acceptance**

- New runtime run emits NATS messages during execution.
- Messages include `workflow_uid`, `workflow_name`, `workflow_namespace`, `agent_id`, `kind`, `timestamp`.

**Dependencies**

- Workstream A (stream exists).

---

## Workstream C — Jangar ingestion (backend)

**Goal:** Persist NATS messages to Postgres and provide SSE API for UI.

**Scope**

- Add `workflow_comms.agent_messages` table + migration.
- Add `agent-comms-store.ts` (Kysely + migrations).
- Add NATS subscriber service (`services/jangar/src/server/agent-comms/`).
- Add API route: `GET /api/agents/events`.

**Deliverables**

- Migration + DB types in `services/jangar/src/server/migrations/` and `db.ts`.
- NATS consumer runtime (worker or in-process).
- SSE API handler.

**Acceptance**

- Messages appear in Postgres as they publish.
- SSE endpoint streams new messages by `runId` or `channel=general`.

**Dependencies**

- Workstream A (consumer exists).

---

## Workstream D — Jangar UI

**Goal:** UI shows agent comms and global channel in Jangar.

**Scope**

- Add routes:
  - `/agents` list
  - `/agents/:runId` timeline
  - `/agents/general` global channel
- Add sidebar entry in `services/jangar/src/components/app-sidebar.tsx`.
- Render markdown and tool events.

**Deliverables**

- React routes + UI components under `services/jangar/src/routes/`.
- Sidebar entry.

**Acceptance**

- UI shows real-time updates via SSE.
- Global channel visible at `/agents/general`.

**Dependencies**

- Workstream C (API/SSE ready).

---

## Workstream E — Backfill + reconciliation

**Goal:** Use existing artifacts to backfill messages when NATS is down.

**Scope**

- On `run-complete`, parse `.codex-implementation-agent.log` and
  `.codex-implementation-events.jsonl` (see `services/jangar/src/server/codex-judge.ts`).
- Backfill into `workflow_comms.agent_messages` if missing.

**Deliverables**

- Backfill hook in `handleRunComplete` or in a new reconciliation job.

**Acceptance**

- Historical runs show messages even if NATS is unavailable.

**Dependencies**

- Workstream C (table exists).

---

## Workstream F — Auth/TLS + RBAC hardening

**Goal:** Prepare for multi-tenant isolation.

**Scope**

- Define NATS accounts/creds:
  - `system` for NACK
  - `agents` for runtimes
  - `jangar` for consumer
- Store secrets in namespaces, optionally mirrored via reflector.

**Deliverables**

- Secrets + NATS config changes in the GitOps bundle for NATS.
- Updates to runtime templates and Jangar deployment env.

**Acceptance**

- NATS auth on; producers/consumers connect with correct creds.

**Dependencies**

- Workstream A (stream/consumer).

---

## Workstream G — Observability

**Goal:** Visibility into publish/consume health and lag.

**Scope**

- Enable NATS monitoring endpoints.
- Add Prometheus scrape via existing observability stack.
- Dashboard panels: publish rate, storage, consumer lag.

**Deliverables**

- NATS Helm values update (prom exporter).
- Grafana dashboard/panels under the observability bundle.

**Acceptance**

- Metrics visible in Grafana; lag alerts can be defined.

**Dependencies**

- Workstream A.

---

## Milestones

1. **MVP realtime**: A + B + C + D (global channel live in Jangar).
2. **Resilience**: add E (backfill).
3. **Security**: add F (auth/TLS).
4. **Ops maturity**: add G (metrics + alerts).

## Coordination notes

- Use `workflow_uid` + `workflow_namespace` as the stable join key across systems.
- Keep Kafka-based run-complete flow unchanged; NATS is only for agent comms.
- Prefer small, reversible PRs per workstream to keep GitOps rollouts safe.

## Optional adapters

### Argo Workflows adapter (optional)

If Argo Workflows templates are still in use, mirror Workstream B with an adapter that emits the
same schema. Prefer the `workflow.` subject prefix; only use `argo.workflow.` if compatibility
requires it and include `runtime: "argo"` in payloads.
