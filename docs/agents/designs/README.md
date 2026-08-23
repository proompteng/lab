# Retained Agents Design Contracts

Status: Supporting implementation and historical contracts.

This directory is intentionally curated. A document remains here because live code, configuration, tests, current
documentation, or another retained contract still names it. Retention does not make a design current production
authority.

For current behavior, start with:

- `docs/agents/README.md`
- `docs/agents/current-source-state.md`
- `services/agents/**`
- `packages/agent-contracts/**`
- `charts/agents/**`
- `argocd/applications/agents/**`
- live Argo, Kubernetes, API, and CI readback

`handoff-common.md` contains the shared render and validation commands used by maintained Agents docs. Other files are
supporting rationale for contracts still surfaced by the implementation.

## Retention Rule

- Keep a design while a live contract or maintained document cites it.
- Move reusable operational instructions into a current runbook or component README.
- Delete superseded variants, completed handoffs, rollout journals, and orphaned proposals.
- Use Git history when historical text is needed after deletion.

Do not add a generated catalog or preserve a file solely because another obsolete index listed it. Use
`docs/documentation-authority.md` when source and documentation disagree.
