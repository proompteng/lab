# SAG Product Requirements

## Product

SAG is an in-firewall action gateway for enterprise agents. It turns natural-language operational intent into a guarded task plan, checks policy before every connector action, requires approval for risky steps, executes allowed connector calls, and records an audit trail.

The core primitive is not "chat with tools." It is controlled authority transfer:

```text
Identity -> Task -> Plan Step -> Connector Call -> Policy Decision -> Approval -> Audit Event
```

## User And Buyer

Primary user: platform/security operator responsible for letting agents work inside internal systems without giving them broad standing credentials.

Secondary users: application operators who request tasks in natural language, and auditors who need action-level evidence after the fact.

Buyer: CISO, VP Engineering, or Head of Platform at companies adopting internal agents for operations, finance, support, engineering, or compliance workflows.

## Problem

Large companies have brittle dashboards, scripts, and runbooks because the real workflow lives in a few operators' heads. AI agents can replace pieces of that work, but only if the company can answer four questions:

- Who asked for the action?
- What systems would the agent touch?
- What policy allowed, blocked, or held each step?
- What evidence remains after execution?

Without that boundary, agent adoption creates a new privileged automation surface.

## MVP Requirements

- Run as a standalone service behind the firewall.
- Accept natural-language task intake.
- Produce a multi-step plan over SQL, REST, GraphQL, legacy, Kubernetes, policy, and audit connectors.
- Execute real connector calls against in-cluster or repo-controlled services.
- Persist normalized backend records in CNPG: tasks, plan steps, connector calls, approvals, policies, identities, AgentRuns, and audit events.
- Enforce server-side RBAC. Approval identity must come from server-side identity resolution, not request body trust.
- Translate natural-language policy text through Codex app-server into deterministic rules, with deterministic fallback for local/offline operation.
- Mount Codex auth through a sealed Kubernetes secret.
- Redact secrets before persistence and export.
- Export audit events as JSONL.
- Present a minimal operations UI centered on task intake, decision state, connector calls, and audit events.

## Wedge

The wedge is Kubernetes AgentRun protection because it is concrete and inspectable: SAG can read live AgentRuns, detect requested secret/runtime authority, block or hold risky actions, and show the audit evidence immediately.

The platform path is broader: the same gateway wraps internal databases, private REST APIs, GraphQL APIs, and legacy text/protocol interfaces. Each connector gets the same contract: least privilege, typed operation, pre-action policy, redaction, and audit.

## Success Criteria

- A reviewer can open `https://sag.proompteng.ai`, submit a task, and see a plan execute.
- The task generates real persisted connector-call records, not static UI rows.
- A mutating task creates an approval instead of executing directly.
- Audit export proves identity, policy, connector, result, request hash, and redacted evidence.
- No raw secret values appear in the UI, API response, persisted evidence, or JSONL export.

## Sources Used

- OpenAI Agents SDK guardrails: https://openai.github.io/openai-agents-python/guardrails/
- Cloudflare AI Gateway logging: https://developers.cloudflare.com/ai-gateway/observability/logging/
- UiPath on-prem agent release notes: https://docs.uipath.com/agents/automation-suite/2.2510/release-notes/2-2510-2
- Workato connector model: https://docs.workato.com/connectors
- Kubernetes RuntimeClass: https://kubernetes.io/docs/concepts/containers/runtime-class/
- gVisor isolation model: https://gvisor.dev/docs/
