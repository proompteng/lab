# Secure Action Gateway Architecture Primitives

The product should be easy to explain to a panel: it protects internal agent work before sensitive authority is granted, and it leaves a clear record of every decision.

## Primitives

### AgentRun

The unit of work being protected.

For this submission, SAG reads live Kubernetes `AgentRun` resources from the `agents` namespace. An AgentRun can request secrets, connectors, tools, and runtime actions. SAG evaluates those requests before the work receives sensitive authority.

### Connector

A bounded integration target.

Current connectors:

- `kubernetes`: live AgentRun inspection.
- `postgres`: CNPG state persistence.
- `policy`: rule translation and evaluation.
- `audit`: JSONL event export.

Future connectors should be typed adapters with explicit operations and least-privilege credentials. A connector is not a generic shell.

### Rule

A deterministic policy.

Rules define:

- mode: `block`, `approval`, or `audit`;
- target: secret, connector, action, or prompt;
- pattern: a compiled server-side match expression;
- source: system or natural-language.

Natural language is used only to create inspectable rules. Enforcement uses deterministic rules.

### Decision

The result of evaluating an AgentRun:

- `allowed`: no blocking or approval rule matched.
- `blocked`: the AgentRun requested access that policy forbids.
- `approval_required`: the AgentRun requested a risky action that needs a human decision.

### Approval

A human gate for risky actions.

Approval must check role permissions. A denied approval attempt is also an event because it is security-relevant.

### Event

The audit record.

Every evaluation, rule creation, denial, and approval becomes an event with actor identity, connector, operation, target, status, policy, request hash, and redacted evidence.

## Why This Is The Right Level

The original challenge asks for secure agent automation behind a firewall. The smallest useful product is not a broad workflow platform. It is a guard point that can answer:

- Which agent tried to do what?
- What internal authority did it request?
- Which policy matched?
- Was the action allowed, blocked, or held?
- Who approved it?
- Can audit verify the evidence later?

The primitives above answer those questions without introducing unnecessary terminology.

## Current Implementation Mapping

| Primitive | Implementation                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| AgentRun  | `ProtectedAgentRun` in `services/sag/src/server/gateway.ts`; live Kubernetes reader in `server/kubernetes.ts` |
| Connector | `ConnectorKind` and connector metadata in `gateway.ts`                                                        |
| Rule      | `GatewayRule`; natural-language creation through `/api/rules`                                                 |
| Decision  | `evaluateAgentRun` returns `allowed`, `blocked`, or `approval_required`                                       |
| Approval  | `approveAction`; `/api/approvals/approve`                                                                     |
| Event     | `GatewayEvent`; `/api/events/export` JSONL                                                                    |

## Platform Path

1. Keep the current event log as the reviewer-facing product surface.
2. Add a validating admission webhook so blocked AgentRuns cannot start.
3. Add OIDC group mapping for roles.
4. Add typed internal connectors for customer databases and APIs.
5. Add immutable audit export to SIEM/data lake.
6. Add policy packs for common enterprise agent risks.
