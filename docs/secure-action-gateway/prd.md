# Secure Action Gateway Product Requirements

## One-Line Product

Secure Action Gateway protects internal AI agents by evaluating requested authority before execution and recording every policy decision in an audit log.

## Customer Problem

Enterprise teams want AI agents to operate internal systems, but they cannot give agents broad access to secrets, databases, APIs, or mutation tools without strong controls. Existing internal tools are brittle, but replacing them with agents creates a new risk: hidden action paths with weak auditability.

SAG turns that risk into a control point.

## Users

- Security operator: defines rules, reviews blocked/held AgentRuns, approves guarded actions.
- Platform engineer: deploys SAG inside the cluster and connects it to internal agent workloads.
- Auditor: exports and reviews the event trail.

## Buyer

- CISO or VP Engineering for risk reduction.
- Head of Platform for controlled rollout of internal agents.

## Requirements

### Must Have

- Run behind the firewall as a standalone service.
- Inspect live Kubernetes AgentRuns.
- Persist state in CNPG.
- Block AgentRuns requesting sensitive secret authority.
- Require approval for mutating actions.
- Translate operator natural language into deterministic rules.
- Record every evaluation and decision as an event.
- Export audit events as JSONL.
- Expose a minimal event-log UI.

### Should Have

- OIDC/SAML group mapping.
- Admission webhook enforcement.
- Immutable audit event storage.
- Typed connector catalog for internal systems.

### Not Now

- Generic chat assistant.
- Broad workflow editor.
- Static connector fixture data.
- Unbounded shell execution.

## Success Criteria

- A reviewer can open `sag.proompteng.ai` and understand the product in under one minute.
- The root page shows real events and AgentRuns, not a sample request.
- Live AgentRun evaluation blocks sensitive secrets.
- Approval flow enforces role permissions.
- Audit export matches the UI.
- Source and manifests are runnable from the repo.

## Metrics

- AgentRuns evaluated.
- AgentRuns blocked.
- Actions held for approval.
- Approval decisions by actor.
- Events exported.
- Raw sensitive values leaked: target is zero.
