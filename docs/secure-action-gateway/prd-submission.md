# Secure Action Gateway PRD

Date: 2026-05-13
Status: Submission-ready PRD
Owner: Greg Konush

## Summary

Secure Action Gateway turns a natural-language internal-operations request into a controlled set of known actions against company systems. It is for work that currently depends on brittle dashboards, scripts, SQL snippets, admin pages, and operator memory.

The prototype focuses on one workflow: investigate invoice sync failures from the last 24 hours, check account and entitlement state, create remediation tickets for invalid records, and retry only safe failures after approval.

The product promise is simple: the agent can propose work, but it cannot invent or execute work. Execution is limited to approved actions, connector code holds the credentials, rules decide what is allowed, approvals gate risky writes, and the event log records every step.

## Target User And Buyer

Primary user: finance operations, RevOps, support ops, IT operations, procurement ops, or internal tools teams handling cross-system exceptions.

Buyer: CIO, VP of IT, Head of Enterprise Automation, or business owner responsible for operational continuity. Security and platform teams are required approvers because the product touches internal systems and can trigger side effects.

## Problem

Large companies accumulate operational workflows that are never fully productized. A dashboard shows one part of the state, a SQL query finds exceptions, an admin API gives more context, a spreadsheet tracks remediation, and an experienced operator knows which retry is safe.

When that operator leaves, credentials rotate, APIs change, or failure volume spikes, the workflow breaks.

Static workflow automation is brittle because every branch must be modeled ahead of time. Generic agents are risky because they often combine planning and execution authority. The gap is a product that lets an agent help with investigation while the application controls what can actually run.

## Product Model

The product uses seven primitives:

- **Request:** what the user asked for.
- **Action:** a named operation the system allows, such as `find_invoice_failures` or `retry_invoice_sync`.
- **Connector:** code that talks to an internal database, REST API, GraphQL API, or legacy system.
- **Rule:** server-side decision logic that allows, blocks, or asks for approval.
- **Approval:** human approval for one exact risky action and input digest.
- **Run:** one execution of a request.
- **Event:** append-only audit record.

Everything else is implementation detail.

## Core Requirements

- Natural-language request intake.
- Visible action plan generated from the request.
- Action catalog with input schemas, effect type, allowed roles, approval requirement, and connector.
- SQL, REST, GraphQL, and legacy connectors.
- Role-based access checks on each action call.
- Approval required for risky writes.
- Rejection of unknown or unsupported actions.
- Worker execution outside the web request path.
- Agent event log with request, plan, rule decisions, approvals, connector results, errors, and final state.
- Runnable artifact with deterministic seeded data.

## Prototype Experience

1. User signs in as `ops_user`.
2. User submits the invoice-failure request in plain English.
3. The system proposes a plan made only of known actions.
4. Unknown actions or invalid inputs are rejected.
5. Read actions run automatically:
   - Postgres finds invoice failures.
   - REST checks account status.
   - GraphQL checks entitlement state.
6. Ticket creation runs only for records classified invalid.
7. Invoice retry is blocked because it is a risky write.
8. `ops_approver` reviews the exact retry input and approves it.
9. Worker runs the legacy retry adapter.
10. Reviewer inspects the agent event log and exports it as JSONL.

## Why Agent-Based Automation Fits

The hard part is not pressing a button. The hard part is interpreting an ambiguous request, gathering evidence across systems, deciding which records are safe to act on, and then executing only the allowed steps.

An agent is useful for proposing the plan and adapting to intermediate evidence. The application remains responsible for authority: known actions, connector boundaries, rules, approvals, worker execution, and event records.

## Wedge-To-Platform Path

1. **Invoice exception workflow:** prove one useful internal operation end to end.
2. **Action catalog:** let teams add more governed actions for support, provisioning, procurement, HR, and security operations.
3. **Connector SDK:** standardize how actions talk to internal systems without exposing credentials to the agent.
4. **Governance:** add SSO group mapping, approval routing, SIEM export, retention, redaction, and policy tests.
5. **Enterprise operating layer:** become the safe way for AI agents to operate internal systems.

## Success Criteria

The submission is successful if a reviewer can run or inspect the artifact and verify:

- one natural-language request becomes a multi-step action plan,
- SQL, REST, GraphQL, and legacy connectors all run,
- unknown actions are rejected,
- at least one risky action is blocked before approval,
- approval unlocks only the exact approved action input,
- role checks are visible,
- event log export is complete enough to reconstruct what happened.

## Non-Goals

- Generic chatbot.
- Broad connector marketplace.
- Kubernetes controller.
- Autonomous destructive writes.
- LLM wrapper around static JSON.
- Public SaaS dependency for the core workflow.
