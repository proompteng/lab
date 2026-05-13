# Secure Action Gateway TDD

Date: 2026-05-13
Status: Submission-ready TDD
Owner: Greg Konush

## Technical Position

The prototype proves one idea: an agent may suggest internal work, but only the application can execute known actions.

The design is intentionally small:

- one Web/API service,
- one worker process,
- local fixture systems for SQL, REST, GraphQL, and a legacy adapter,
- Postgres for product state and the audit log.

Do not build a platform, Kubernetes controller, CRD model, policy microservice, or workflow engine for the challenge. Those would distract from the actual proof.

## Core Primitives

Use ordinary product primitives:

- `Request`: the user's natural-language task.
- `Action`: a named operation the system allows, with schema, effect type, role rule, approval rule, and connector.
- `Connector`: code that talks to one internal system. It owns credentials and target URLs.
- `Rule`: server-side decision logic that allows, blocks, or asks for approval.
- `Approval`: human approval for one exact action call and input digest.
- `Run`: one execution of a request.
- `Event`: append-only audit record.

The agent sees action names and input schemas. It never sees credentials, raw connection strings, arbitrary URLs, SQL consoles, or shell access.

## Runtime Shape

Processes:

- **Web/API service:** sign-in stub, task submission, agent event explorer, selected-event detail, action catalog, approval action, JSONL export.
- **Worker:** executes allowed action calls outside the web request path.
- **Fixtures:** seeded Postgres invoice data, local REST account/ticketing service, local GraphQL entitlement service, local legacy retry adapter.

Storage:

- Postgres tables: `users`, `actions`, `runs`, `action_calls`, `approvals`, `events`.
- Connector config lives in server/worker configuration for the prototype.

Deployment:

- Local Docker Compose or one-command local runner for review.
- Production can run the same API and worker inside the customer's network with NetworkPolicy and optional gVisor for the worker.
- No CRDs or reconcilers are required.

## Action Catalog

Initial actions:

| Action | Effect | Connector | Rule |
| --- | --- | --- | --- |
| `find_invoice_failures` | read | Postgres | `ops_user` allowed |
| `lookup_account_status` | read | REST | `ops_user` allowed |
| `lookup_entitlement` | read | GraphQL | `ops_user` allowed |
| `create_remediation_ticket` | write | REST | allowed only for invalid records |
| `retry_invoice_sync` | write | legacy adapter | requires `ops_approver` approval |

The API rejects any plan step whose action name or input shape is not in this catalog.

## Execution Flow

1. `ops_user` submits the invoice-sync request.
2. API creates a run and records `request.submitted`.
3. Planner proposes a deterministic list of catalog actions for the demo.
4. API validates action names and input schemas.
5. API creates `action_calls` and records `plan.accepted`.
6. Rule checks allow read actions.
7. Worker runs SQL, REST, and GraphQL connectors.
8. Rule allows ticket creation only for records classified invalid.
9. Rule blocks `retry_invoice_sync` until approval.
10. `ops_approver` approves that exact action call and input digest.
11. Worker runs the legacy retry adapter.
12. UI shows the agent event log, selected event detail, final run status, and JSONL export.

## Security Model

The security boundary is the action catalog plus rule checks:

- Planner cannot call databases, APIs, URLs, shell commands, or legacy systems directly.
- Every executable step must be a known action.
- Credentials stay inside connector config.
- Every action call is checked against the actor's role and the action rule.
- Risky writes require approval for the exact input digest.
- Worker receives only the action call it must execute.
- Connector outputs are summarized/redacted before display and audit storage.
- Blocked attempts are audit events.

Production hardening can add OIDC/SAML group mapping, customer secret manager integration, NetworkPolicy, signed action catalogs, and stronger worker sandboxing. These are hardening layers, not extra prototype primitives.

## Connector Strategy

Use real local calls:

- SQL connector queries seeded Postgres invoice rows.
- REST connector calls local account and ticketing endpoints.
- GraphQL connector calls local entitlement schema.
- Legacy connector exposes only `retryInvoiceSync`.

Do not use static JSON as a fake integration. The demo should show the worker crossing four connector types through the same action/rule/event path.

## Audit Events

Required event names:

- `request.submitted`
- `plan.accepted`
- `action.requested`
- `rule.allowed`
- `rule.blocked`
- `approval.requested`
- `approval.granted`
- `worker.started`
- `connector.completed`
- `connector.failed`
- `run.completed`

Each event stores timestamp, actor, run ID, action call ID, action name, decision, input digest, redacted output summary, and error if present.

The event explorer and JSONL export are the audit artifact. They should let a reviewer reconstruct the run without reading server logs.

## Validation

The prototype is technically complete when a reviewer can verify:

- the request becomes a visible action plan,
- unknown actions are rejected,
- SQL, REST, GraphQL, and legacy connectors all run,
- retry is blocked before approval,
- approval is tied to one action call and input digest,
- wrong-role approval fails,
- worker executes the approved retry outside the web request,
- event export contains the full chain and no raw secrets.
