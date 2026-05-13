# Secure Action Gateway PRD

## Problem

Enterprises are starting to run AI agents inside the firewall, but the hard problem is not chat. The hard problem is action authority. Agents need to inspect tickets, databases, APIs, Kubernetes jobs, and internal tools, yet most enterprises cannot let a model or agent process receive broad secrets, service accounts, or write access with only prompt-level safeguards.

The operational gap is simple: companies want natural-language automation, but they need deterministic control over what an agent can touch, what gets blocked, who approves risky actions, and what evidence exists afterward.

## Target User And Buyer

Primary user:

- AI platform engineer or security engineer responsible for internal agent workloads.
- Needs to see which agents are running, what sensitive resources they requested, which rules matched, and what decision was made.

Economic buyer:

- CISO, Head of Platform, or VP Engineering.
- Cares about adopting agent automation without creating unmanaged access paths to internal systems.

Secondary users:

- Compliance and audit teams who need a durable event trail.
- Operations leaders who want agents to reduce internal-tool work without bypassing controls.

## Product

Secure Action Gateway is a control point for internal AI agents. It runs behind the firewall, observes an AgentRun before sensitive authority is attached, evaluates the requested connectors/secrets/tools against policy, and records an event for every decision.

The first product surface is an event log, not a workflow builder. A reviewer should immediately see:

- which AgentRun was evaluated,
- what it tried to access,
- whether SAG allowed, blocked, or held it,
- which rule matched,
- who approved or denied an action,
- and the redacted evidence behind the decision.

## Core Primitives

- **AgentRun:** the unit of work being protected.
- **Connector:** a bounded integration target such as Kubernetes, Postgres state, policy, or audit export.
- **Rule:** deterministic policy translated from operator text or seeded by the system.
- **Decision:** `allowed`, `blocked`, or `approval_required`.
- **Approval:** a human decision required before a risky action can proceed.
- **Event:** the audit record for every evaluation and decision.

These primitives are intentionally small. They explain the product without inventing a broad control plane.

## MVP Scope

In scope:

- Deployed web product at `sag.proompteng.ai`.
- Kubernetes `AgentRun` reader for the live `agents` namespace.
- CNPG persistence.
- Natural-language rule creation.
- Rule evaluation for requested secrets, connectors, and mutating tools.
- RBAC-backed approval decisions.
- Redacted audit log and JSONL export.
- Minimal dark event-log UI using Base UI and Tailwind.

Out of scope for this submission:

- Full OIDC/SAML setup.
- Admission webhook enforcement.
- Customer-managed connector catalog.
- Long-term immutable audit storage.

Those are platform extensions, not required to prove the wedge.

## User Flow

1. Security operator opens SAG.
2. SAG displays the event log and AgentRun list.
3. Operator evaluates a live AgentRun.
4. SAG reads the AgentRun through its Kubernetes service account.
5. SAG detects sensitive requested secrets and blocks the AgentRun before authority is attached.
6. Operator creates a rule from natural language.
7. SAG translates the text into a deterministic rule.
8. A mutating AgentRun action is held for approval.
9. A non-approver is denied.
10. A security operator approves.
11. All actions appear in the event log and JSONL export.

## Wedge To Platform

The wedge is AgentRun safety inside a customer-controlled cluster. It is narrow, visible, and urgent for teams already experimenting with internal agents.

Platform path:

1. Start with Kubernetes AgentRuns and audit.
2. Add admission webhook enforcement so unsafe AgentRuns cannot start.
3. Add customer connectors for internal databases, REST APIs, GraphQL APIs, and legacy interfaces.
4. Add OIDC/SAML group mapping and approval routing.
5. Add immutable audit export to the customer's SIEM or data lake.
6. Expand from AgentRun protection into a general secure action layer for enterprise automation.
