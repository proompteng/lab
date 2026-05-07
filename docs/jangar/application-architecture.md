# Jangar Application Architecture

This is the authoritative architecture index for the Jangar application as of 2026-05-07.

Use this document together with:

- `services/jangar/README.md` for local development and operator commands
- `docs/jangar/build-contract.md` for CI/CD, image, and rollout expectations
- `docs/jangar/architecture-inventory.md` for generated runtime/profile/route/module inventory

## Runtime model

Jangar now uses explicit runtime profiles instead of implicit global startup.

- `http-server`
  - serves the Vite client bundle and HTTP/API surface
  - starts `agentComms`, `controlPlaneCache`, `torghutQuantRuntime`, and `agentctlGrpc`
- `vite-dev-api`
  - serves only the Bun API surface for local Vite development
  - starts the same background integrations as the production API profile
- `test`
  - builds the HTTP surface without background startup

The source of truth for this boot contract is:

- `services/jangar/src/server/runtime-profile.ts`
- `services/jangar/src/server/runtime-startup.ts`
- `services/jangar/src/server/runtime-validation.ts`

## Platform boundaries

The cleanup program moved the highest-risk application boundaries behind explicit modules:

- Config
  - `services/jangar/src/server/chat-config.ts`
  - `services/jangar/src/server/controller-runtime-config.ts`
  - `services/jangar/src/server/control-plane-config.ts`
  - `services/jangar/src/server/integrations-config.ts`
  - `services/jangar/src/server/memory-config.ts`
  - `services/jangar/src/server/torghut-config.ts`
  - `services/jangar/src/server/agentctl-grpc-config.ts`
  - `services/jangar/src/server/terminals-config.ts`
  - `services/jangar/src/server/github-review-config.ts`
  - `services/jangar/src/server/metrics-config.ts`
- Memory embeddings
  - `services/jangar/src/server/memory-provider.ts`
  - `services/jangar/src/server/memory-provider-health.ts`
- Terminal infrastructure
  - `services/jangar/src/server/terminals.ts`
  - `services/jangar/src/server/terminal-worktrees.ts`
  - `services/jangar/src/server/terminal-command-runner.ts`
- Kubernetes
  - `services/jangar/src/server/kube-gateway.ts`
  - `services/jangar/src/server/primitives-kube.ts`
  - `services/jangar/src/server/primitives-watch.ts`
  - `services/jangar/src/server/kube-watch.ts`
- Build and rollout contracts
  - `packages/scripts/src/jangar/manifest-contract.ts`
  - `packages/scripts/src/jangar/update-manifests.ts`
  - `packages/scripts/src/jangar/verify-deployment.ts`

Runtime startup validation should fail fast for invalid production config before the server begins serving traffic.

## Structural guardrails

The control-plane status surface is now composed from collector modules instead of one mixed 2k+ line file:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/control-plane-execution-trust.ts`
- `services/jangar/src/server/control-plane-workflows.ts`
- `services/jangar/src/server/control-plane-rollout-health.ts`
- `services/jangar/src/server/control-plane-db-status.ts`
- `services/jangar/src/server/control-plane-empirical-services.ts`

Module size is also guarded in CI:

- `services/jangar/scripts/check-module-sizes.ts`
- `bun run --cwd services/jangar check:module-sizes`

New application modules must stay at or below 800 lines. Existing oversized modules are frozen at their current caps
until they are decomposed further.

## Current control-plane decision contract

The current architecture priority is source-heartbeat witness settlement and material-action bonds. Final verdicts
remain the consumer surface, but they must now carry explicit bond evidence before they are treated as durable
admission: source or GitOps revision truth, rollout truth, controller heartbeat truth, AgentRun ingestion truth,
terminal evidence carry, and Torghut consumer proof. Serving readiness, route health, rollout health, watch
reliability, and database freshness can stay green while source truth is missing, AgentRun ingestion is unknown, or a
material verdict still sees stale controller authority. That disagreement is witness variance, not a reason to widen
dispatch or Torghut capital.

Current source-of-truth design:

- `docs/agents/designs/168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`
- `docs/torghut/design-system/v6/172-torghut-repair-yield-ledger-and-session-proof-capital-gates-2026-05-07.md`
- `docs/agents/designs/169-jangar-ready-action-evidence-exchange-and-deployer-custody-2026-05-07.md`
- `docs/torghut/design-system/v6/173-torghut-no-notional-repair-options-desk-and-promotion-custody-2026-05-07.md`
- `docs/agents/designs/167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md`
- `docs/torghut/design-system/v6/171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md`
- `docs/agents/designs/166-jangar-evidence-capability-ledger-and-observer-lease-gates-2026-05-07.md`
- `docs/torghut/design-system/v6/170-torghut-data-witness-capability-bonds-and-capital-observation-gates-2026-05-07.md`
- `docs/agents/designs/155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md`
- `docs/torghut/design-system/v6/159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`
- `docs/agents/designs/129-jangar-heartbeat-lane-escrow-and-material-verdict-stability-2026-05-06.md`
- `docs/torghut/design-system/v6/133-torghut-stable-jangar-receipts-and-closed-session-capital-hold-2026-05-06.md`
- `docs/agents/designs/128-jangar-terminal-run-settlement-and-forecast-reentry-admission-2026-05-06.md`
- `docs/torghut/design-system/v6/132-torghut-forecast-profit-tournament-and-capital-reentry-guardrails-2026-05-06.md`
- `docs/agents/designs/128-jangar-runtime-convergence-ledger-and-capital-gate-receipts-2026-05-06.md`
- `docs/torghut/design-system/v6/132-torghut-dependency-quorum-rehydration-and-profit-inventory-handoff-2026-05-06.md`
- `docs/agents/designs/125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`
- `docs/torghut/design-system/v6/129-torghut-proof-carry-watermarks-and-zero-decision-capital-drain-2026-05-06.md`
- `docs/agents/designs/124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`
- `docs/torghut/design-system/v6/128-torghut-data-plane-disruption-premium-and-freshness-settlement-2026-05-06.md`

The immediate invariant is that serving readiness, rollout availability, a route-level controller heartbeat, direct SQL
heartbeat freshness, an action clock `allow`, or fresh quant metrics cannot upgrade a stricter source-heartbeat witness
bond, launch cohort, source provenance lease, heartbeat stability receipt, run-settlement watermark, terminal evidence
half-life ledger, ready-action packet, Torghut repair-yield gate, or Torghut promotion-custody packet. In the current
live state, missing source or GitOps revision truth, AgentRun ingestion unknowns, retained failed runner pods, failed
jobs, retry-only schedule successes, stale database statistics, oversized quant proof carry, stale market-context
domains, routeability debt, and missing promotion evidence must keep normal dispatch, deploy widening, merge readiness,
paper canary, and live capital inside explicit hold or observe-only decisions until action-specific proof arrives.

## Ownership map

These ownership lanes are the operational review boundaries for Jangar changes.

- Runtime and platform adapters
  - `services/jangar/src/server/app.ts`
  - `services/jangar/src/server/runtime-*.ts`
  - `services/jangar/src/server/*config.ts`
  - `services/jangar/src/server/kube-*.ts`
  - `services/jangar/src/server/primitives-*.ts`
- Controllers and background control-plane logic
  - `services/jangar/src/server/agents-controller/**`
  - `services/jangar/src/server/orchestration-controller.ts`
  - `services/jangar/src/server/supporting-primitives-controller.ts`
  - `services/jangar/src/server/leader-election.ts`
  - `services/jangar/src/server/control-plane-*.ts`
- Control-plane UI and operator routes
  - `services/jangar/src/routes/control-plane/**`
  - `services/jangar/src/routes/api/agents/control-plane/**`
  - `services/jangar/src/components/agents-control-plane*`
  - `services/jangar/src/data/agents-control-plane.ts`
- GitHub review surface
  - `services/jangar/src/routes/github/**`
  - `services/jangar/src/server/github-*.ts`
  - `services/jangar/src/data/github.ts`
- Torghut UI and data paths
  - `services/jangar/src/routes/torghut/**`
  - `services/jangar/src/routes/api/torghut/**`
  - `services/jangar/src/server/torghut-*.ts`
  - `services/jangar/src/data/torghut-trading.ts`
- Build, packaging, and rollout tooling
  - `services/jangar/Dockerfile`
  - `.github/workflows/jangar-*.yml`
  - `packages/scripts/src/jangar/**`

## Document status

Current operational docs:

- `services/jangar/README.md`
- `docs/jangar/application-architecture.md`
- `docs/jangar/build-contract.md`
- `docs/jangar/architecture-inventory.md`

Historical or design context docs:

- `docs/jangar/current-state.md`
- `docs/agents/designs/168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`
- `docs/torghut/design-system/v6/172-torghut-repair-yield-ledger-and-session-proof-capital-gates-2026-05-07.md`
- `docs/agents/designs/169-jangar-ready-action-evidence-exchange-and-deployer-custody-2026-05-07.md`
- `docs/torghut/design-system/v6/173-torghut-no-notional-repair-options-desk-and-promotion-custody-2026-05-07.md`
- `docs/agents/designs/167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md`
- `docs/torghut/design-system/v6/171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md`
- `docs/agents/designs/166-jangar-evidence-capability-ledger-and-observer-lease-gates-2026-05-07.md`
- `docs/torghut/design-system/v6/170-torghut-data-witness-capability-bonds-and-capital-observation-gates-2026-05-07.md`
- `docs/agents/designs/155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md`
- `docs/torghut/design-system/v6/159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`
- `docs/agents/designs/129-jangar-heartbeat-lane-escrow-and-material-verdict-stability-2026-05-06.md`
- `docs/agents/designs/128-jangar-terminal-run-settlement-and-forecast-reentry-admission-2026-05-06.md`
- `docs/agents/designs/128-jangar-runtime-convergence-ledger-and-capital-gate-receipts-2026-05-06.md`
- `docs/agents/designs/125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`
- `docs/agents/designs/124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`
- `docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `docs/agents/designs/jangar-application-tech-debt-cleanup-plan-2026-04-08.md`

Generated inventory should be treated as factual structure. This document is the human-maintained index that explains how to interpret it.
