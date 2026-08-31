# Agent Swarm Implementation Guide (Codex + AgentRuns + Torghut)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Purpose

Connect the existing Torghut production system, the repo's Agents (AgentRuns) platform, and a Codex-driven workflow to
create a "swarm" of agents that can implement the v2 build-out safely.

The goal is not "many agents". The goal is parallel execution without merge conflicts and without violating trading
safety invariants.

## What Exists Today (Production)

Torghut already runs a full pipeline:

- Ingest: `torghut-ws` (Kotlin) subscribes to Alpaca market data and writes to Kafka.
- Compute: `torghut-ta` (Flink) computes TA and writes to ClickHouse.
- Trade loop: `torghut` (FastAPI, Knative) reads ClickHouse signals, makes decisions, applies deterministic risk,
  optionally runs LLM review, executes orders, reconciles, and persists audit state in Postgres.

Canonical production docs:

- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
- `docs/torghut/design-system/v1/agentruns-handoff.md`

## What Codex + AgentRuns Add

The repo includes an AgentRuns platform:

- `ImplementationSpec`: a durable "what to do" spec (text + required keys).
- `AgentRun`: an execution instance that references an ImplementationSpec.

Key rule (prompt precedence): do not set `AgentRun.spec.parameters.prompt` unless you want to override the spec text.
See `docs/agents/agentrun-creation-guide.md`.

## Swarm Model (Hub-And-Spoke)

- Leader (orchestrator) run:
  - breaks the roadmap into work items,
  - creates ImplementationSpecs (or references existing ones),
  - launches AgentRuns in parallel "lanes".
- Worker runs:
  - each owns a narrow file surface area,
  - produces one PR per work item,
  - includes validation steps.

## Lanes (Avoid Conflicts)

Assign one lane per major ownership boundary:

- Lane A: Trading service core
  - Owns: `services/torghut/app/trading/**`, `services/torghut/app/config.py`, `services/torghut/tests/**`

- Lane B: Data / TA / features
  - Owns: `services/dorvud/technical-analysis-flink/**`, `argocd/applications/torghut/ta/**`, ClickHouse DDL sources

- Lane C: Infra + GitOps
  - Owns: `argocd/applications/torghut/**`, `kubernetes/**`, `charts/**` (as needed)

- Lane D: Research harness + scripts
  - Owns: `packages/scripts/**` and any new replay/sim harness modules

- Lane E: Observability + runbooks
  - Owns: `docs/torghut/**`, dashboards manifests (if present), alert rules

## Work Item Template (ImplementationSpec)

Each work item must be small enough for a single PR and must include:

- Objective
- In-scope paths
- Out-of-scope constraints
- Acceptance criteria
- Validation commands
- Safety gates (paper-only, no credentials changes)

Example required keys for PR-producing work:

- `repository`, `base`, `head`, `stage`, `gitopsPath` (if relevant)

## Hard Guardrails (Do Not Break These)

- Paper trading is the default. Do not introduce live enablement paths without explicit gates.
- Deterministic risk is final authority.
- LLM layer must remain bounded and credential-less.
- Every PR must preserve reproducibility: store versions (config/model/prompt) and inputs.

## How To Operationalize The Swarm

1. Convert roadmap sections into an issue list and ImplementationSpecs.
2. Create AgentRuns per lane with non-overlapping `head` branches.
3. Enforce PR checks:
   - unit tests for touched code,
   - lint/format,
   - smoke tests (where applicable).
4. Merge in dependency order:
   - safety + order firewall first,
   - backtesting validity + cost model next,
   - execution planner and sizing next,
   - strategy expansions last.

## Suggested First Swarm Wave (High Value)

- Add an "order firewall" module and a true kill switch contract (Lane A + Lane C).
- Add a cost model MVP and persist realized slippage (Lane A).
- Add replay/sim harness skeleton with deterministic fixtures (Lane D).
- Add a research ledger schema + CI gates for strategy edits (Lane A).

## References (Research Inputs)

- `docs/torghut/design-system/v2/research-reading-list.md`
