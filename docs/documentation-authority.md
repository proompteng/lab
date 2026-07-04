# Documentation Authority Model

Status: Current documentation policy.

This repository has several kinds of documentation: live runbooks, implementation references, dated design snapshots,
research/whitepaper workups, incidents, and handoff records. They do not carry the same authority.

Use this authority order when documents disagree.

## Authority Order

1. Live desired state and source code
   - `argocd/**`, `.github/workflows/**`, `charts/**`, `nix/**`, `tofu/**`, `devices/**`
   - Service source, tests, and local README files under `services/**`, `apps/**`, and `packages/**`
2. Runtime readback
   - Argo application status, Kubernetes objects, readiness endpoints, health/status APIs, logs, and CI results
3. Current operational indexes and runbooks
   - Current `README.md` files and runbooks that explicitly say they are current
   - Files with a recent status section that points to live desired state and runtime checks
4. Historical design snapshots and accepted handoffs
   - `docs/agents/designs/**`
   - `docs/agents/release-handoffs/**`
   - `docs/torghut/design-system/**`
   - dated rollout reports and closeout notes
5. Research and whitepaper workups
   - `docs/whitepapers/**`
   - research-derived implementation ideas that still need current code/GitOps validation
6. Incident reports
   - factual historical evidence, useful for diagnosis, but not current desired state

## Required Handling For Design Docs

A design doc is authority only for its own historical decision. It is not current production truth unless it explicitly
says so and points to live code, GitOps, and runtime readback.

When updating a stale design doc, prefer one of these actions:

- mark it as a historical snapshot and add a current-truth notice;
- move current operational guidance into a maintained README or runbook;
- replace “implementation-ready/current/source of truth” wording with “historical rationale” wording;
- add links to live desired state, service code, runtime APIs, and current runbooks.

Do not solve stale design drift by adding another link checker. Broken links are secondary. The main failure mode is an
old design claiming current authority after implementation reality moved.

## Current Source Maps

Start from these before using any dated design file:

- Repository/root operations: `README.md`, `AGENTS.md`, `CLAUDE.md`
- Agents platform: `docs/agents/README.md`, `services/jangar/README.md`, `charts/agents/**`, `argocd/applications/agents/**`
- Torghut: `docs/torghut/README.md`, `services/torghut/README.md`, `argocd/applications/torghut/**`, `argocd/applications/torghut-options/**`
- Source-read snapshots: `docs/agents/current-source-state.md`, `docs/torghut/current-source-state.md`
- Incidents: `docs/incidents/README.md`
- Whitepapers: `docs/whitepapers/README.md`

## Review Checklist

Before treating a design doc as actionable, verify:

- the referenced service paths still exist;
- the referenced GitOps resources still exist;
- the documented status is consistent with current runtime status and CI;
- the document does not conflict with a current README/runbook;
- implementation work has a validation path in tests, CI, or runtime readback.
