# SAG Product Requirements

## Product

SAG is the policy and audit boundary between agent intent and enterprise authority. The core primitive is an **Agent Action Run**: a natural-language request becomes ordered action steps, each step checks policy, safe steps execute through internal sources, risky steps wait for approval, and every result is replayable from audit.

```text
Request -> Agent Action Run -> Action Step -> Decision -> Approval -> Evidence -> Audit Replay
```

## User And Buyer

Primary user: platform or security operator responsible for letting agents work inside internal systems without handing them broad standing credentials.

Secondary users: operators who request internal work in natural language, and auditors who need action-level evidence after the fact.

Buyer: CISO, VP Engineering, or Head of Platform at enterprises adopting agents for operations, support, engineering, finance, or compliance workflows.

## Problem

Large companies rely on brittle dashboards, scripts, and runbooks because the real workflow lives in a few operators' heads. Agents can replace that work only if the company can answer:

- who asked;
- what the agent planned;
- which source each action touched;
- what policy allowed, blocked, or held the action;
- what evidence remains after execution.

Without that boundary, agent adoption creates a new privileged automation surface.

## MVP Requirements

- Run as a standalone behind-firewall service.
- Accept natural-language requests.
- Produce an Agent Action Run with visible action steps.
- Execute real source calls across policy data, internal API, audit graph, operations feed, policy gate, and audit log.
- Persist normalized CNPG records for identities, sources, policies, requests, action steps, calls, approvals, protected workloads, and audit events.
- Enforce server-side RBAC. Approval authority comes from resolved identity, not client input.
- Translate natural-language policy text through Codex app-server with deterministic fallback.
- Redact sensitive values before persistence, UI display, and export.
- Present a minimal enterprise UI centered on runs, approvals, sources, decisions, evidence, and audit replay.

## Wedge To Platform

The first wedge is internal platform teams rolling out agents in Kubernetes because workload authority, service accounts, secrets, and internal APIs are inspectable. Kubernetes protected workloads are one source, not the product.

The platform path is broader: the same Agent Action Run contract wraps databases, internal REST APIs, GraphQL APIs, legacy interfaces, ticket queues, finance tools, and production control surfaces.

## Success Criteria

- A reviewer can open `https://sag.proompteng.ai`, submit a request, and see an Agent Action Run execute.
- Read steps produce persisted source-call evidence.
- Mutating steps show `Needs approval` and do not execute until approved.
- Audit replay shows identity, source, action, decision, policy, duration, and redacted evidence.
- The user-facing UI contains no raw JSON, manifests, hashes, regexes, or fake/demo data.
