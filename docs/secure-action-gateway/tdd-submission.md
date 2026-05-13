# Secure Action Gateway TDD

## Architecture

Secure Action Gateway runs as a standalone service in the `sag` namespace.

Components:

- **Web/API service:** TanStack Start application in `services/sag`.
- **State store:** CNPG Postgres cluster `sag-db`, storing a single structured SAG state document.
- **Kubernetes reader:** service account `sag` with read access to `AgentRun` resources in the `agents` namespace.
- **Policy engine:** deterministic server-side evaluator for AgentRun secrets, connectors, tools, and natural-language rules.
- **Audit export:** JSONL endpoint at `/api/events/export`.
- **GitOps package:** manifests under `argocd/sag`, exposed at `sag.proompteng.ai`.

The service is intentionally one deployable unit for the submission. There is no hidden worker and no static product fixture behind the UI.

## Firewall-Constrained Environment

SAG is deployed inside the cluster where the protected agents run. It does not require inbound access to internal systems from the public internet. The external route exposes only the product UI/API; internal access is performed from the in-cluster service account and CNPG connection.

Current internal integrations:

- Kubernetes API for live AgentRun inspection.
- CNPG for persisted rules, approvals, AgentRun decisions, and event history.
- Policy engine in-process for deterministic evaluation.
- JSONL audit export for review.

Production extension:

- Move write-time enforcement into a validating admission webhook.
- Add NetworkPolicy so the service can only reach Kubernetes, CNPG, and approved connectors.
- Add signed connector definitions for internal databases and APIs.

## Auth And Security Model

Current submission model:

- `greg`: security operator with `audit:read`, `rule:create`, `agentrun:evaluate`, and `approval:approve`.
- `ops`: operator with `audit:read` and `agentrun:evaluate`.
- `audit`: read-only audit role.

The approval API checks permissions before changing approval state. A non-approver denial is recorded as an audit event.

Production model:

- Map OIDC/SAML/LDAP groups into SAG roles.
- Enforce role checks on every route.
- Store approval identity from the authenticated session rather than request body.
- Require short-lived connector credentials from the customer's secret manager.

## Policy Model

Rules have:

- `mode`: `block`, `approval`, or `audit`.
- `target`: AgentRun secret, AgentRun connector, connector action, or prompt.
- `pattern`: deterministic regex compiled server-side.
- `source`: system or natural-language.

Default rules:

- Block sensitive secret requests matching production/auth/token/password-style names.
- Require approval for mutating operations such as apply, update, delete, execute, mutate, or merge.

Natural-language rule creation converts operator intent into one of these deterministic rule shapes. The model is not trusted as the enforcement engine; it only helps create inspectable rules.

## Connector Strategy

Current connectors are the minimum product spine:

- `kubernetes`: reads live AgentRuns.
- `postgres`: persists SAG state in CNPG.
- `policy`: translates and evaluates rules.
- `audit`: exports redacted events.

Future internal-system connectors should follow the same contract:

- explicit operation names,
- least-privilege credentials,
- typed request/response schema,
- redaction before persistence,
- rule evaluation before write access,
- and event emission for every call.

## Audit Trail

Each event stores:

- timestamp,
- actor id/email/role,
- connector,
- operation,
- target,
- status,
- matched policy,
- request hash,
- correlation id,
- duration,
- and redacted evidence.

Sensitive secret names are hashed as `secret:<hash>`. Raw secret names are not stored in manifests, API responses, or JSONL export.

## Validation

Local:

- `bun run --filter @proompteng/sag tsc`
- `bun run --filter @proompteng/sag test`
- `bun run --filter @proompteng/sag lint`
- `bun run --filter @proompteng/sag lint:oxlint`
- `bun run --filter @proompteng/sag build`
- `bun run lint:argocd`

Live:

- Deployment image: `registry.ide-newton.ts.net/lab/sag:sag-20260513010817`.
- Deployment is ready in namespace `sag`.
- Health endpoint reports Postgres persistence.
- Live AgentRun evaluation blocks sensitive secret requests.
- Mutating action approval flow denies `ops` and allows `greg`.
- Root page and JSONL export contain no raw sensitive secret names.
