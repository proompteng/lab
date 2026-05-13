# Secure Action Gateway Market Research and Competitive Analysis

Date: 2026-05-13
Status: Research-backed strategy note

## Executive Takeaway

The market is real, crowded, and still unsettled. Enterprises want agents that can act across internal systems, but the strongest public signals point to the same adoption blockers: unclear ROI, weak risk controls, fragmented integrations, and poor governance. Gartner predicts more than 40% of agentic AI projects will be canceled by the end of 2027 because of escalating cost, unclear business value, or inadequate risk controls. McKinsey argues that the larger enterprise opportunity is not generic horizontal copilots, but vertical workflows spanning multiple steps, actors, and systems.

Secure Action Gateway should not position as another general AI agent builder. The best wedge is a secure execution layer for private enterprise operations: natural-language task intake, typed internal connectors, approval-gated actions, sandboxed execution, and a complete audit trail. The product should compete less on "build any agent" and more on "let agents safely operate private systems."

Primary wedge:

> Governed internal action execution for brittle enterprise operations workflows.

Best demo:

> A finance or RevOps operator asks in natural language to investigate invoice sync failures, the system queries internal SQL, REST, GraphQL, and legacy interfaces, blocks risky writes for approval, executes the approved retry in a sandbox, and leaves a full audit timeline.

## Market Context

Enterprise AI is moving from chat and search into action. The strongest market evidence is not that every company wants more chatbots; it is that existing pilots fail to become production workflows because they do not safely connect to the systems where work happens.

Relevant market signals:

- Gartner's cancellation warning is a positioning gift: the market is demanding real use cases, risk controls, and measurable value, not hype demos.
- McKinsey's analysis separates broad horizontal copilots from higher-value vertical workflows. Secure Action Gateway belongs in the vertical workflow bucket.
- Major enterprise platforms are converging on the same vocabulary: agents, workflows, connectors, governance, audit, and control towers.
- MCP and tool-calling have become a practical integration pattern, but security research now flags dynamic agent-tool systems as a new attack surface.
- RPA/iPaaS vendors are already packaging connectors and orchestration for agents, so the prototype must show why private runtime isolation and action-level control matter beyond a connector catalog.

Implication: the project should foreground a concrete operational workflow and visible controls. A thin model wrapper will be ignored; a narrow, inspectable workflow with real connector calls and policy enforcement will look credible.

## Competitive Landscape

### 1. Enterprise Automation Incumbents

These vendors already own enterprise workflow automation, RPA, BPM, and iPaaS budgets. They are the most important competitive set.

| Vendor | What They Offer | Strength | Opening for Secure Action Gateway |
| --- | --- | --- | --- |
| UiPath | Agentic automation platform unifying AI agents, robots, and people; Maestro orchestration and Agent Builder. | Deep RPA footprint, enterprise process automation credibility, orchestration maturity. | Heavy enterprise suite. Prototype can be lighter, Kubernetes-native, and focused on secure private-system connector execution. |
| ServiceNow | AI Agent Studio, AI Agent Orchestrator, AI Control Tower, AI Agent Fabric, Workflow Data Fabric. | Strong installed base for ITSM/enterprise workflows and governance. | Best inside ServiceNow-centric estates. Secure Action Gateway can be neutral and run near any internal system without requiring ServiceNow as the system of record. |
| Workato | Agent Studio and Enterprise MCP for governed agent access to enterprise apps. | Large connector surface, iPaaS credibility, governed MCP story. | Cloud/iPaaS orientation. Secure Action Gateway can emphasize customer-network deployment, worker isolation, and legacy/internal systems. |
| Microsoft Copilot Studio / Power Platform | Agents, Power Platform connectors, custom connectors, MCP servers, governance through Power Platform and Purview. | Enormous Microsoft ecosystem and 1,400+ connector story. | Tied to Microsoft admin and Power Platform model. Secure Action Gateway can be smaller, inspectable, and infrastructure-neutral. |
| SS&C Blue Prism WorkHQ | Control plane for agentic automation across AI agents, digital workers, APIs, and people. | Enterprise RPA heritage and regulated-ops fit. | Broad suite; less focused on developer-inspectable private connector jobs and sandboxed action evidence. |
| Tray.ai | AI-ready integration/orchestration, Merlin Agent Builder, MCP Gateway, 700+ connectors, audit/observability. | Strong enterprise integration story and MCP governance angle. | Cloud-first integration platform. Secure Action Gateway can lead with customer-network execution and simple action-level controls. |
| Zapier Agents / n8n | Agent/workflow automation with broad app integrations; n8n has a self-hosting story. | Fast demos, broad ecosystem, low friction. | Often workflow-first or SMB/developer-oriented. Secure Action Gateway should target enterprise risk controls, private systems, approval, and audit. |

Takeaway: the market validates the build challenge. The crowded part is "agents + workflows + connectors." The sharper, less crowded claim is "secure internal action gateway for private systems."

### 2. Agent Frameworks and Developer Platforms

LangGraph/LangSmith, CrewAI, LlamaIndex, Semantic Kernel, OpenAI Agents SDK, and similar frameworks help developers build, orchestrate, observe, or deploy agents. LangGraph Platform markets production deployment and management for long-running stateful agents, with enterprise RBAC/workspaces.

These tools are complementary and sometimes competitive. They help build the planner/orchestration layer, but they usually do not provide a complete enterprise product around private connector policy, approval workflows, runtime sandboxing, and compliance evidence.

Positioning:

- Use agent frameworks as implementation options, not as the product category.
- Avoid competing with them on generic agent orchestration.
- Compete on governed execution against internal systems.

### 3. LLM Gateways and AI Security Gateways

Cloudflare AI Gateway, Portkey, Kong AI Gateway, LiteLLM, Helicone, Lakera, HiddenLayer, Prompt Security, LlamaFirewall, and newer agent-security tools address model routing, cost control, observability, prompt injection, guardrails, redaction, and AI runtime defense.

These products validate the security urgency, but most are closer to the model traffic boundary than to business action execution. Cloudflare, for example, emphasizes caching, analytics/logging, request retries, model fallback, and rate limiting for AI applications. Lakera positions around workforce AI security, runtime protection for AI applications, prompt attack prevention, and data leakage protection. Meta's LlamaFirewall research focuses on prompt injection, agent misalignment, and insecure code guardrails.

Positioning:

- Do not become only an LLM gateway.
- Borrow the gateway/security language, but apply it at the action boundary.
- The product should inspect and govern tool/action execution, not only prompts and model responses.

### 4. MCP and Connector Governance

MCP is becoming an enterprise integration interface for agents. Workato explicitly frames Enterprise MCP as a governed framework where agents receive predefined skills instead of freeform API/database access. Academic work is also emerging around MCP risks: one 2025 paper notes MCP replaces static developer-controlled integrations with dynamic user-driven agent systems and introduces risks not fully covered by existing AI governance frameworks. AgentBound argues that MCP servers often execute with unrestricted access and proposes declarative policy enforcement around agent execution boundaries.

Implication:

- Secure Action Gateway should support MCP as an integration interface eventually, but should not rely on MCP alone as a security model.
- The core product primitive should be a known action: typed input, role rule, approval requirement, connector, and audit event.
- MCP compatibility can be a platform expansion path, not the initial proof.

## Buyer and ICP

Best initial buyer:

- VP of Enterprise Automation
- CIO / VP IT
- Head of Internal Tools
- Security architecture leader approving agent access
- Finance/RevOps systems leader for the first workflow wedge

Best initial user:

- Operations lead responsible for exception queues
- Finance systems analyst
- RevOps operator
- IT automation engineer
- Internal tools engineer

Best initial company profile:

- 1,000+ employee company
- multiple internal systems and private APIs
- measurable operational exception queues
- security team blocking uncontrolled agents
- existing frustration with brittle scripts, dashboards, and RPA maintenance

Poor first ICP:

- SMBs that can use Zapier/n8n without security review
- companies that only need chat over documents
- teams that already standardized all workflow execution inside ServiceNow or Power Platform and have no appetite for neutral infrastructure
- pure AI security buyers who only want prompt injection detection at the model gateway

## Positioning

Recommended positioning:

> Secure Action Gateway is the private execution layer for AI agents that need to operate internal enterprise systems.

Sharper one-liner:

> Natural language in, governed internal actions out.

What to emphasize:

- customer-network deployment,
- SQL/REST/GraphQL/legacy connector breadth,
- action-level policy and approval,
- sandboxed execution,
- full audit trail,
- explicit replacement of brittle internal scripts and dashboards.

What to avoid:

- "generic agent platform,"
- "chatbot for enterprise data,"
- "LLM firewall" as the main product,
- broad claims about replacing all RPA,
- security claims that are only written in docs and not visible in the demo.

## Competitive Differentiators

The strongest differentiators for the build challenge are implementation-level, not messaging-level:

1. **Customer-network first:** runs in the customer's environment or local environment, not only as a SaaS service.
2. **Action boundary instead of prompt boundary:** rules are enforced on connector actions and side effects, not only prompts.
3. **Typed action catalog:** every SQL/API/legacy action has schema, role rule, approval rule, connector, and redaction behavior.
4. **Isolated worker path:** risky actions run outside the web request path, with a production path through stronger container isolation.
5. **Approval-gated writes:** side effects are denied by default and require an exact-action approval event.
6. **Audit as product surface:** the run timeline is the main UI artifact and should be good enough for security/compliance review.
7. **Narrow operational wedge:** invoice sync or billing exceptions make value concrete and avoid generic-agent skepticism.

## Prototype Implications

For the submission, prioritize visible proof over feature breadth.

Must show:

- natural-language task intake,
- generated structured plan,
- SQL connector call,
- REST connector call,
- GraphQL connector call,
- legacy adapter call,
- RBAC or seeded enterprise identity,
- policy block before a write,
- human approval,
- sandboxed job execution,
- audit timeline and export.

Recommended depth area:

- security primitives and sandboxed connector execution.

Secondary visible depth:

- connector breadth across SQL, REST, GraphQL, and legacy.

Do not spend time on:

- a broad connector marketplace,
- generalized multi-agent collaboration,
- a polished marketing site,
- a model-gateway-only proxy,
- complex SSO integration beyond a credible seeded RBAC/OIDC stub.

## Strategic Risks

| Risk | Why It Matters | Mitigation |
| --- | --- | --- |
| Looks like another agent builder | Market is crowded and incumbents are strong. | Frame as private internal action execution, not agent creation. |
| Looks like an LLM firewall | The Send page context can pull the story toward model traffic security. | Anchor on the emailed build challenge: internal systems, multi-step tasks, auth, audit. |
| Looks like RPA with a prompt box | RPA vendors already own deterministic automation. | Show adaptive investigation across systems before a governed action. |
| Security claims look theoretical | Reviewers explicitly care about build evidence. | Make RBAC, approval, sandboxing, egress, redaction, and audit visible in the running demo. |
| Too much platform, not enough workflow | Broad platform claims are hard to evaluate quickly. | Keep the demo workflow narrow and end-to-end. |

## Source Notes

- [Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027): predicts over 40% of agentic AI projects will be canceled by end of 2027 because of cost, unclear value, or inadequate risk controls.
- [McKinsey](https://www.mckinsey.com/capabilities/quantumblack/our-insights/seizing-the-agentic-ai-advantage): frames the opportunity around vertical workflows involving multiple steps, actors, and systems.
- [UiPath](https://www.uipath.com/newsroom/uipath-launches-first-enterprise-grade-platform-for-agentic-automation): launched agentic automation platform with Maestro orchestration and Agent Builder.
- [ServiceNow](https://www.servicenow.com/products/ai-agents.html): positions AI Agent Studio, AI Agent Orchestrator, AI Control Tower, AI Agent Fabric, and Workflow Data Fabric as governed enterprise agent infrastructure.
- [Microsoft Copilot Studio](https://www.microsoft.com/en-us/microsoft-365-copilot/microsoft-copilot-studio/): markets custom agents with MCP servers, 1,400+ connectors, governance, analytics, and audit through Microsoft admin surfaces.
- [Microsoft connector docs](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-connectors): Power Platform connectors expose actions/tools to Copilot Studio agents, including custom connectors and credential modes.
- [Workato Enterprise MCP](https://www.workato.com/the-connector/enterprise-mcp-guide/): frames governed MCP as predefined skills, RBAC, audit trails, and 12,000+ supported apps.
- [Workato Agent Studio](https://docs.workato.com/en/agentic/agent-studio.html): describes Genies that dynamically perform actions and call workflows through pre-defined skills.
- [SS&C Blue Prism WorkHQ](https://www.blueprism.com/platform/): positions WorkHQ as a control plane for agentic automation across AI agents, digital workers, APIs, and people.
- [Tray.ai Agent Gateway docs](https://docs.tray.ai/platform/artificial-intelligence/agent-gateway/overview): exposes Tray workflows and connector operations as MCP tools while controlling permissions, access, and execution; Tray cites 700+ connectors.
- [Zapier Agents help](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents): describes Zapier Agents as AI agents for automating tasks across Zapier-connected apps.
- [n8n AI Agents](https://n8n.io/ai-agents/): positions n8n as a workflow automation platform for building AI agents, with configurable third-party model data sharing and encrypted connections.
- [LangGraph Platform](https://www.langchain.com/blog/langgraph-platform-ga): supports deployment and management of long-running stateful agents, with enterprise RBAC and workspaces.
- [Cloudflare AI Gateway docs](https://developers.cloudflare.com/ai-gateway/): shows the LLM gateway category around observability, caching, request retries, model fallback, and rate limiting.
- [Portkey](https://portkey.ai/docs/overview/features-overview): positions AI Gateway, observability, guardrails, governance, routing, fallbacks, and budget limits as production AI infrastructure.
- [Kong AI Gateway](https://developer.konghq.com/ai-gateway/): positions a central governance and observability point for AI data, AI usage, LLM traffic, and AI API management.
- [LiteLLM AI Gateway](https://www.litellm.ai/ai-gateway): positions an enterprise AI gateway/proxy with routing, logging, spend controls, and model/provider management.
- [Helicone](https://docs.helicone.ai/getting-started/platform-overview): positions AI Gateway plus LLM observability as one platform.
- [Lakera](https://www.lakera.ai/): positions runtime AI agent security around prompt attack prevention and data leakage protection.
- [HiddenLayer](https://www.hiddenlayer.com/): positions AI runtime security, agentic security, prompt injection defense, data leakage prevention, and unsafe-behavior controls.
- [Prompt Security](https://prompt.security/): positions agentic AI security, MCP Gateway, prompt injection prevention, data leak prevention, and enterprise AI governance.
- [Meta LlamaFirewall](https://ai.meta.com/research/publications/llamafirewall-an-open-source-guardrail-system-for-building-secure-ai-agents/): validates prompt injection, agent misalignment, and insecure code as active AI-agent security problems.
- [Kubernetes RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/): provides the Kubernetes mechanism for selecting alternate container runtimes for security/performance tradeoffs.
- [gVisor containerd quick start](https://gvisor.dev/docs/user_guide/containerd/quick_start/): documents `runsc` containerd runtime wiring and a Kubernetes `RuntimeClass` named `gvisor`.
- [Securing MCP risks paper](https://arxiv.org/abs/2511.20920): summarizes new risks introduced by dynamic user-driven agent integrations through MCP.
- [AgentBound paper](https://arxiv.org/abs/2510.21236): argues for declarative policy enforcement around MCP execution boundaries.
