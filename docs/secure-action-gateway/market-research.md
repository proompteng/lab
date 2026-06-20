# SAG Market Research And Competitive Analysis

## Read

The market is splitting into three layers:

- Agent frameworks: help developers build tools and workflows.
- Automation/iPaaS/RPA: provide connectors and workflow execution.
- Gateways/security: govern traffic, policy, identity, logging, and isolation.

The gap is the action boundary for internal agents: a product that sees the planned connector action before authority is used, enforces policy, and leaves action-level evidence.

## Signals

- OpenAI Agents SDK separates guardrails from agent execution and specifically calls out tool guardrails around custom function-tool calls. That validates pre/post tool-call control as the right enforcement point.
- Cloudflare AI Gateway centers logs, observability, and DLP fields around AI requests, but it is model/API traffic oriented rather than internal system action oriented.
- UiPath is bringing agents to Automation Suite/on-prem environments, which validates enterprise demand for agentic automation where data sovereignty and private deployment matter.
- Workato connectors model authentication, triggers, and actions per app, validating connector breadth as a buyer expectation.
- Kubernetes RuntimeClass and gVisor show the infrastructure path for sandboxing higher-risk workloads without redesigning the product around a VM-first abstraction.

Sources:

- https://openai.github.io/openai-agents-python/guardrails/
- https://developers.cloudflare.com/ai-gateway/observability/logging/
- https://docs.uipath.com/agents/automation-suite/2.2510/release-notes/2-2510-2
- https://docs.workato.com/connectors
- https://kubernetes.io/docs/concepts/containers/runtime-class/
- https://gvisor.dev/docs/

## Competitive Map

| Category                  | Examples                     | Strength                         | Gap SAG Targets                                      |
| ------------------------- | ---------------------------- | -------------------------------- | ---------------------------------------------------- |
| Agent frameworks          | OpenAI Agents SDK, LangGraph | developer control, orchestration | not an enterprise authority boundary by themselves   |
| AI gateways               | Cloudflare AI Gateway        | model traffic logging, policies  | not focused on internal database/API action release  |
| RPA / agentic automation  | UiPath                       | workflow execution, enterprise   | workflow-first, not action-authority-first           |
| iPaaS                     | Workato                      | connector breadth                | connector execution, not agent-specific governance   |
| API gateways              | Kong, Envoy, Apigee          | API traffic policy               | do not understand agent intent and approval context  |
| IAM / privileged access   | Okta, Teleport, CyberArk     | identity and access              | do not plan and audit natural-language agent actions |
| Sandboxing/runtime safety | gVisor, Kata, Firecracker    | workload isolation               | isolation layer, not product workflow or approval    |

## Product Positioning

SAG should be described as:

> The policy and audit boundary between agent intent and enterprise authority.

Not:

- a chatbot,
- a generic workflow builder,
- an API gateway clone,
- an RPA suite,
- or a prompt firewall.

## Best Wedge

Start with internal platform teams rolling out agents in Kubernetes. They already have:

- service accounts,
- jobs/pods,
- secret references,
- internal APIs,
- audit needs,
- and approval-sensitive operations.

The panel demo should prove that SAG can run inside that environment, inspect live workloads, call real internal connectors, and show action-level audit evidence.

## Why This Can Win

The winning primitive is small enough to build and explain:

```text
Task -> Connector Action -> Policy -> Approval -> Audit
```

That primitive generalizes across SQL, REST, GraphQL, legacy systems, and Kubernetes without inventing a sprawling control plane.
