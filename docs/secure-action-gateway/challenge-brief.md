# Secure Action Gateway Challenge Brief

## Interpreted Challenge

Build a secure agent framework that runs behind the firewall, connects to internal systems, turns natural-language operator intent into controlled multi-step work, integrates enterprise authorization, and leaves a full audit trail.

The strongest interpretation is not "make a chat wrapper." It is "prove that an enterprise can let agents work near sensitive systems without handing the agent unchecked authority."

## Submission Deliverables

- Working product URL or runnable artifact.
- Short 2-5 minute walkthrough link.
- Source code as GitHub link or zip.
- PRD, 1-2 pages.
- TDD, 1-2 pages.
- Authorship/build note: what was built, reused, what broke, and how it was debugged.

## Product Slice

Secure Action Gateway protects Kubernetes AgentRuns:

1. Read live AgentRuns in the `agents` namespace.
2. Evaluate requested secrets, connectors, and tools.
3. Block sensitive secret authority.
4. Hold mutating actions for approval.
5. Translate natural language into deterministic rules.
6. Persist state in CNPG.
7. Export a redacted JSONL audit trail.

## Why This Fits

The email asks for secure connections, natural language to multi-step actions, enterprise authorization, and audit. SAG shows those through a smaller, sharper wedge:

- secure in-cluster Kubernetes and CNPG access,
- natural-language rule creation,
- AgentRun evaluation and approval decisions,
- RBAC-backed approval,
- event log and export.

The platform can add broader internal database, REST, GraphQL, and legacy connectors after the core action-gating primitive is proven.
