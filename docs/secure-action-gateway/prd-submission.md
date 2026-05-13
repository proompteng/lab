# SAG PRD

## Problem

Enterprises want agents to replace brittle internal scripts, dashboards, and runbooks, but the blocker is action authority. An agent becomes useful only when it can touch databases, internal APIs, Kubernetes jobs, ticket queues, and legacy tools. That same access creates unmanaged risk if the enterprise cannot see who asked, what the agent planned, which connector was called, what policy decided, and what evidence remains.

## Target User And Buyer

Primary user: platform or security operator responsible for internal agent workloads.

Secondary users: application operators who ask for operational work in natural language, and auditors who inspect action evidence.

Buyer: CISO, Head of Platform, or VP Engineering. The budget comes from making agent automation usable without granting broad standing credentials.

## Product

SAG is an in-firewall action gateway. It accepts natural-language operational intent, creates a multi-step connector plan, evaluates policy before each step, requires approval for risky actions, executes allowed connector calls, and writes an audit event for every decision.

The first screen is the product: task intake, decision state, connector calls, and audit log. It is intentionally not a chatbot or a decorative dashboard.

## Core Primitives

- Identity: authenticated actor and role.
- Task: natural-language operational intent.
- Plan step: ordered connector action.
- Connector call: executed SQL, REST, GraphQL, legacy, Kubernetes, policy, or audit operation.
- Rule: deterministic block, approval, or audit policy.
- Approval: human release for risky actions.
- Audit event: append-only evidence of what happened.

## MVP Scope

In scope:

- Live product at `https://sag.proompteng.ai`.
- CNPG-backed normalized backend tables.
- SQL, REST, GraphQL, legacy, Kubernetes, policy, and audit connector primitives.
- Natural-language task intake.
- Natural-language rule creation through Codex app-server.
- Server-side RBAC for task, rule, and approval routes.
- Sealed Codex auth secret mounted into the SAG pod.
- Redacted audit JSONL export.
- Minimal dark enterprise UI using TanStack Start, Tailwind, and Base UI.

Out of scope for the 48-hour artifact:

- Customer OIDC setup wizard.
- Admission webhook enforcement.
- SIEM export pipeline.
- Full connector marketplace.

## User Flow

1. Operator opens SAG.
2. Operator submits a natural-language task.
3. SAG plans SQL, REST, GraphQL, and legacy connector steps.
4. SAG checks policy before each step.
5. Read-only steps execute and write connector-call records.
6. Mutating steps create approvals instead of executing directly.
7. Approver releases or denies the action.
8. Audit export shows identity, policy, connector, status, request hash, and redacted evidence.

## Wedge To Platform

Wedge: protect live AgentRun workloads in Kubernetes because the requested runtime authority is inspectable and panel-visible.

Platform path:

1. AgentRun action gateway.
2. Admission webhook for hard enforcement.
3. Signed connector catalog for databases and APIs.
4. OIDC/SAML/LDAP identity mapping and approval routing.
5. Immutable audit export to SIEM/data lake.
6. General enterprise action gateway for internal agents and natural-language operations.
