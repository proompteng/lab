# Secure Action Gateway Challenge Brief

Date: 2026-05-13
Status: Submission constraints and skeptical interpretation

## How To Treat The Source Material

The emailed build challenge is the authoritative submission target, but it is not a product architecture. Treat it as a set of reviewer constraints: what evidence must be visible, what deliverables must be submitted, and which themes the panel expects to see.

The product should not simply mirror the email's nouns. "Connects to internal systems" does not mean "give an agent database credentials." "Natural language to multi-step actions" does not mean "let a planner run tools." "Full audit trail" does not mean "store logs." The deeper product primitive is an allowed action: the agent can propose it, but the application validates the action, applies rules, asks for approval when needed, runs the connector, and records an audit event.

The public Send page is useful context, but its card emphasizes an adversarial LLM traffic proxy. The email asks for a broader secure agent framework that runs inside a customer-controlled enterprise environment, connects to internal systems, and executes natural-language-driven multi-step operational work.

## Required Product

Build a secure AI agent framework for enterprises that:

- runs inside the customer's network or controlled deployment environment,
- connects securely to internal databases, REST APIs, GraphQL APIs, and legacy interfaces,
- turns natural-language requests into multi-step agent actions,
- integrates enterprise auth through SSO, LDAP, or RBAC,
- records a full audit trail of agent behavior.

The wedge is replacing fragile internal operations tooling: dashboards, scripts, data workflows, and tribal runbooks that break when key operators leave.

## Submission Bundle

The submission must include:

1. Working prototype URL or runnable artifact.
2. Short 2-5 minute screen recording or demo walkthrough link showing the core workflow.
3. Source code as a GitHub/repository link or zip.
4. PRD, 1-2 pages.
5. TDD, 1-2 pages.
6. Brief authorship/build note covering what was personally built, what was reused, what broke, and how it was debugged.

## Grading Implications

- The working prototype is the main event.
- Build evidence matters more than polish.
- A polished prompt, generated document, or thin LLM wrapper is not enough.
- At least one depth area must be visible in product or implementation evidence, not only described in PRD/TDD.
- Good visible depth areas for this build are security primitives, sandboxed connector execution, connector breadth, orchestration, and audit/compliance tooling.

## Recommended Prototype

The strongest prototype is an internal operations workflow that starts with a plain-English request and exercises multiple internal-system connectors in one audited run.

Recommended demo:

> Investigate invoice sync failures from the last 24 hours, check account and entitlement state, create remediation tickets for invalid records, and retry only the failures that policy marks safe after approval.

This demo satisfies the email because it proves:

- database access,
- REST access,
- GraphQL access,
- legacy adapter execution,
- natural-language-to-plan orchestration,
- approval-gated writes,
- RBAC or seeded enterprise identity,
- full audit timeline.

## Send Page Versus Email

The Send page frames the original idea as an adversarial AI protection layer for LLM and agent deployments. Its starting point is a sidecar proxy or SDK in front of LLM endpoints, with inline pattern detection, async deep scanning for indirect injection, and a continuously updated adversarial pattern library.

That is related security context, but it is not the clearest reading of the emailed build challenge. For the actual submission, prioritize the emailed requirements: internal-system connectivity, natural-language multi-step actions, enterprise auth, and auditability.
