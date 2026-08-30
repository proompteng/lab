# SAG PRD

## Problem

Enterprises want agents to replace brittle internal dashboards, scripts, and runbooks, but the blocker is authority. Agents become useful when they touch databases, APIs, workload controllers, and legacy tools. That same access is unacceptable unless the enterprise can see who asked, what the agent planned, what source each action touched, what policy decided, and what evidence remains.

## Target User And Buyer

Primary user: platform or security operator responsible for letting agents work inside internal systems without broad standing credentials.

Secondary users: operators who submit work in natural language, and auditors who inspect action evidence.

Buyer: CISO, Head of Platform, or VP Engineering. Budget comes from making internal agents usable without creating unmanaged privileged automation.

## Product

SAG is an in-firewall action gateway. Its core primitive is the **Agent Action Run**: a request becomes ordered action steps; each step has source, decision, approval state, and evidence.

The first screen is the product. It is not a chatbot or dashboard. It shows request intake, action steps, policy decisions, approvals, and audit replay.

## Core Primitives

- Request: natural-language work intake.
- Agent Action Run: one planned/executed workflow.
- Action Step: one source operation.
- Source: policy data, workload API, audit graph, operations feed, policy gate, audit log.
- Decision: allowed, blocked, needs approval, executed.
- Approval: human release for risky work.
- Evidence: concise redacted proof.
- Audit Replay: append-only timeline.

## MVP Scope

In scope:

- Live product at `https://sag.proompteng.ai`.
- CNPG-backed normalized records.
- Natural-language request intake.
- Server-derived `AgentActionRun`, `AgentActionStep`, and `ActionEvidence` display model.
- Real source calls across policy data, workload API, audit graph, operations feed, policy gate, and audit log.
- Server-side RBAC for request, policy, workload, and approval routes.
- Natural-language policy creation through Codex app-server.
- Sealed Codex auth mounted into the SAG pod.
- Redacted audit export.
- Minimal dark enterprise UI using TanStack Start, Tailwind, and Base UI.

Out of scope for this artifact:

- Customer OIDC setup wizard.
- Admission webhook hard enforcement.
- SIEM export pipeline.
- Full connector marketplace.

## User Flow

1. Operator opens SAG.
2. Operator submits a request.
3. SAG creates an Agent Action Run.
4. SAG checks policy before each action step.
5. Safe steps execute and record evidence.
6. Risky steps wait for approval.
7. Approver releases the action.
8. Audit replay shows identity, source, decision, policy, duration, and redacted evidence.

## Wedge To Platform

Wedge: internal platform teams rolling out agents in Kubernetes. Protected workloads are concrete and inspectable, but they are one source rather than the product.

Platform path:

1. Agent Action Run for internal ops.
2. Hard enforcement on workload admission.
3. Signed source catalog for databases and APIs.
4. OIDC/SAML/LDAP identity mapping and approval routing.
5. Immutable audit export to SIEM/data lake.
6. General action gateway for enterprise agents.
