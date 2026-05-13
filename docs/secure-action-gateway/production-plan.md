# Secure Action Gateway Production Plan

Status: live product surface deployed at `https://sag.proompteng.ai`.

## Product Goal

Make internal agent automation presentable and defensible: an enterprise reviewer should see a real AgentRun, a real policy decision, a real approval gate, and a real audit trail without needing to understand the rest of the cluster.

## Current Build

- TanStack Start service under `services/sag`.
- Tailwind and Base UI product surface.
- CNPG persistence through `sag-db`.
- Kubernetes service account reading live AgentRuns in namespace `agents`.
- Event log root page.
- AgentRun evaluation.
- Natural-language rule builder.
- Approval flow with RBAC checks.
- JSONL audit export.
- Argo/Kubernetes package under `argocd/sag`.
- Live rollout at `sag.proompteng.ai`.

## Presentation Flow

1. Open the event log.
2. Click `Evaluate AgentRun`.
3. Show that SAG blocked a live AgentRun requesting sensitive secrets.
4. Open the selected AgentRun manifest and show hashed secret references.
5. Create a rule in plain English.
6. Evaluate a mutating AgentRun action.
7. Show approval required.
8. Attempt approval with `ops`; show denial.
9. Approve with `greg`; show the action marked allowed.
10. Open JSONL export and show the same decisions in machine-readable audit form.

## Near-Term Hardening

### Admission Enforcement

Add a validating admission webhook for `AgentRun` creates/updates:

- receive AgentRun admission request,
- normalize requested secrets/connectors/tools,
- call the same policy engine,
- reject blocked AgentRuns,
- annotate held AgentRuns with approval state.

### Auth

Replace request-body actor selection with session identity:

- OIDC/SAML login,
- group-to-role mapping,
- approval actor from session,
- route-level authorization.

### Audit Durability

Move from state-document persistence to append-only event storage:

- `events` table,
- monotonic event sequence,
- immutable JSON payload,
- optional object-store export,
- SIEM/webhook sink.

### Connector Expansion

Add customer connectors only through a typed contract:

- operation allowlist,
- input schema,
- output schema,
- credential source,
- egress policy,
- redaction policy,
- event emission.

### Isolation

For actions that need execution:

- run in short-lived Kubernetes Jobs,
- mount only scoped credentials,
- apply NetworkPolicy,
- set read-only root filesystem,
- use runtime sandboxing where available,
- emit start/finish events.

## Acceptance Bar

The submission is presentable when:

- the live URL loads quickly,
- the root page is the event log,
- no static product fixture appears on the root page,
- a real AgentRun can be evaluated,
- sensitive names are redacted,
- an approval denial and approval can be shown,
- JSONL export matches the UI,
- local checks pass,
- the deployed image tag is recorded,
- PRD and TDD describe the actual product.
