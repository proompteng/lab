# Torghut Design System

This directory contains retained Torghut design contracts. It is useful for rationale, contract archaeology, and
implementation background, but it is not the primary live operations source of truth.

For current operational decisions, start with [Torghut documentation](../README.md), live GitOps, service code, and
runtime status endpoints.

## Current Entry Points

- Historical production topology: [v1 design](v1/torghut-autonomous-trading-system.md).
- Simulation operations: [current playbook](../rollouts/historical-simulation-playbook.md).
- Proof and capital-authority contracts: [v6 entry point](v6/index.md).

## Corpus Layout

- `v1/`: topology and operational contracts still referenced by maintained docs and alert rules.
- `v3/full-loop/`: the LLM advisory rollout contract referenced by alert rules, plus historical YAML templates.
- `v6/`: proof, capital-authority, and Jangar integration contracts referenced by the implementation, tests, or current
  runbooks; the completion matrix remains machine-consumed.

Superseded version packs, handoff catalogs, and the dated authority map are available in Git history.

## Authority And Retention

A file inside this directory may explain why a design existed, but it is not current production truth without live
code, GitOps, and runtime validation. Keep files only while a live external consumer or maintained current document
needs them, or when they preserve clearly unique historical rationale/provenance. Archive-to-archive references,
generated catalogs, and obsolete indexes do not justify retention. Completed rollout journals and orphaned proposals
belong in Git history. Use `../../documentation-authority.md` and `../README.md` before treating any dated design as
actionable.

## Operator Rule

Before treating any dated design file as current truth, verify it against:

- `argocd/applications/torghut/**`
- `services/torghut/**`
- `GET /readyz`
- `GET /trading/status`
- `GET /trading/revenue-repair`
- relevant Argo application and Kubernetes object state

## Archive Boundary

The retained files are implementation references, not a build order or a record of current rollout status. For current
behavior, use `docs/torghut/README.md`, live GitOps, service code, and runtime readback. Recover removed snapshots from
Git history instead of restoring an obsolete catalog.
