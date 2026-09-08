# Agents / Jangar Current Source State

Status: Current source-read snapshot.

Source baseline inspected: `60f683dd0 chore(release/6f50bd9): automated release PR (#11846)`.

This document is derived from current repository source, chart, and GitOps files. Dated design docs under
`docs/agents/designs/**` remain rationale/history unless revalidated against these source paths.

## Source Inputs Read

Primary code and desired-state inputs:

- Jangar runtime composition: `services/jangar/src/server/app.ts`
- Server route tree: `services/jangar/src/routes/**`
- Control-plane modules: `services/jangar/src/server/control-plane-*.ts`
- Torghut integration modules: `services/jangar/src/server/torghut-*.ts` and `services/jangar/src/routes/api/torghut/**`
- Agents chart: `charts/agents/**`
- Agents CRDs: `charts/agents/crds/**`
- Agents GitOps: `argocd/applications/agents/**`

## Current Jangar Runtime Shape

Jangar is a TanStack/Bun service that loads server-side routes from source globs in
`services/jangar/src/server/app.ts`. The route loader includes:

- `services/jangar/src/routes/api/**/*.{ts,tsx}`
- `services/jangar/src/routes/openai/**/*.{ts,tsx}`
- `services/jangar/src/routes/health.tsx`
- `services/jangar/src/routes/ready.tsx`
- `services/jangar/src/routes/mcp.ts`

This means current route authority lives in `services/jangar/src/routes/**`, not in older design prose.

## Current Route Families

Current route files expose these functional areas:

- OpenAI-compatible API: `services/jangar/src/routes/openai/v1/chat/completions.ts` and
  `services/jangar/src/routes/openai/v1/models.ts`
- health/readiness: `services/jangar/src/routes/health.tsx`, `services/jangar/src/routes/ready.tsx`, and
  `services/jangar/src/routes/api/health.tsx`
- Atlas/search/enrichment: `services/jangar/src/routes/api/atlas/**`, `services/jangar/src/routes/api/search.ts`,
  `services/jangar/src/routes/api/code-search.ts`, and `services/jangar/src/routes/api/enrich.ts`
- GitHub integrations: `services/jangar/src/routes/api/github/**` and `services/jangar/src/routes/github/**`
- terminal/session APIs: `services/jangar/src/routes/api/terminals/**` and `services/jangar/src/routes/terminals/**`
- Torghut UI/API integrations: `services/jangar/src/routes/api/torghut/**` and `services/jangar/src/routes/torghut/**`
- whitepaper library/API: `services/jangar/src/routes/api/whitepapers/**` and
  `services/jangar/src/routes/library/whitepapers/**`
- OpenWebUI rich UI bridge: `services/jangar/src/routes/api/openwebui/**`

## Current Control Plane Shape

The current control plane is implemented as many source modules under `services/jangar/src/server/`, especially
`control-plane-*.ts`. The source modules cover:

- action custody and action clocks;
- authority provenance and source rollout truth;
- evidence pressure, material evidence, and material gate digests;
- repair bid admission, repair slot escrow, repair warrant exchange, and terminal debt compaction;
- stage clearance, stage credit, and controller ingestion settlement;
- source-serving contract verdicts;
- Torghut-specific evidence consumers for alpha readiness, freshness carry, repair outcomes, revenue repair, no-delta
  repair reentry, and stage custody;
- execution-trust and verify-trust foreclosure surfaces.

Design docs that talk about a single simple Swarm loop are historical. Current behavior is distributed across these
source modules and should be verified there.

## Agents Chart And CRDs

The Agents platform is charted in `charts/agents/**` and installed through `argocd/applications/agents/**`.

Current chart CRDs include:

- `Agent`, `AgentRun`, `AgentProvider`, `ImplementationSpec`, `ImplementationSource`, `VersionControlProvider`, `Memory`
- `Orchestration`, `OrchestrationRun`
- `ApprovalPolicy`, `Budget`, `SecretBinding`
- `Signal`, `SignalDelivery`
- `Tool`, `ToolRun`
- `Schedule`, `Swarm`, `Artifact`, `Workspace`

Current chart templates include control-plane deployments/services, controller deployments/services, RBAC, runner RBAC,
network policies, resource quota/limit range, metrics services, service monitors, HPA/PDB support, and the agents-shell
runtime resources.

## Agents GitOps Current Shape

`argocd/applications/agents/**` wires live desired state for:

- Agents CRD primitive manifests;
- Codex and Codex Spark agents/providers;
- VersionControlProvider and SecretBinding resources;
- sample approval, budget, and signal resources;
- Agents service networking, Tailscale exposure, Postgres, object bucket claim, and observability pieces;
- KafkaSource for Codex GitHub events.

The chart and GitOps directories are current desired-state authority. Dated design docs under `docs/agents/designs/**`
are context unless they cite these files and current runtime readback.

## Torghut Integration In Jangar

Jangar currently has a large Torghut integration surface:

- API routes under `services/jangar/src/routes/api/torghut/**`
- UI routes under `services/jangar/src/routes/torghut/**`
- server modules such as `torghut-trading.ts`, `torghut-config.ts`, market-context modules, quant runtime modules, and
  control-plane Torghut evidence modules
- tests under `services/jangar/src/server/__tests__/torghut-*.test.ts` and route-specific tests

Do not treat old Jangar/Torghut design docs as the current integration map. Use the route tree, server modules, and
current tests.

## Documentation Consequence

Future Agents/Jangar docs must check `services/jangar/src/routes/**`, `services/jangar/src/server/**`,
`charts/agents/**`, and `argocd/applications/agents/**` before describing current behavior. Update this file when route
families, CRDs, or control-plane source modules change materially.
