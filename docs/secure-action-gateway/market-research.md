# Secure Action Gateway Market Research And Competitive Analysis

## Market Read

Enterprise agent adoption is blocked less by model quality than by operational trust. Buyers need to know what an agent can access, how a risky action is stopped, who can approve it, and what audit evidence remains after the run.

The opportunity is a secure action layer for internal agents: a product that sits between agent intent and enterprise authority.

## Buyer Pain

- Internal agents need secrets, service accounts, APIs, and databases to be useful.
- Security teams do not want broad standing credentials inside agent runtimes.
- Platform teams need a way to roll agents out without building one-off guardrails for every team.
- Audit teams need evidence at the action level, not a transcript after the fact.

## Competitive Landscape

| Category                  | Examples                    | Strength                                    | Gap SAG Exploits                                                               |
| ------------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| RPA / workflow automation | UiPath, Automation Anywhere | mature workflow execution, enterprise sales | workflow-first; agent authority and model-era audit are not the core primitive |
| iPaaS / automation        | Workato, Zapier, n8n        | broad connectors, fast setup                | often connector-first; less focused on behind-firewall agent action control    |
| Agent frameworks          | LangGraph, CrewAI, AutoGen  | flexible agent orchestration                | developer frameworks, not enterprise security products                         |
| API gateways              | Kong, Apigee, Envoy         | traffic control and policy                  | protect APIs, not agent decisions before authority is attached                 |
| Cloud security / identity | Wiz, Okta, Teleport         | strong identity and access posture          | not purpose-built for natural-language agent action gating                     |

## Wedge

Start with AgentRun protection inside Kubernetes because it is concrete:

- the workload exists,
- requested authority is inspectable,
- policy decisions are visible,
- approval is easy to explain,
- audit evidence is immediate.

This wedge can expand into a secure action gateway for internal databases, REST APIs, GraphQL APIs, and legacy systems.

## Differentiation

SAG is not trying to be the agent framework. It is the authority boundary around agents.

Key differences:

- Event log first.
- Deterministic rules, even when created from natural language.
- In-cluster deployment.
- Redaction before persistence.
- Human approval as a first-class security event.
- Connector strategy based on least-privilege operations, not broad credentials.

## Panel Risk And Mitigation

| Risk                             | Mitigation                                                              |
| -------------------------------- | ----------------------------------------------------------------------- |
| Looks like a generic AI app      | Root page is the event log, not chat                                    |
| Security claims feel theoretical | Live AgentRun block and approval flow are visible                       |
| Too much platform scope          | Keep primitives to AgentRun, Connector, Rule, Decision, Approval, Event |
| Audit is hand-wavy               | JSONL export exposes the event trail                                    |
| Natural language seems unsafe    | Natural language creates rules; deterministic policy enforces them      |
