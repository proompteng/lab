# Torghut Design System v6

This directory is a historical design archive. It records Torghut architecture, research, proof, capital-authority,
and Jangar integration decisions made during the v6 program. It is not a current operations guide.

For current truth, start with:

- `docs/torghut/README.md`
- `docs/torghut/current-source-state.md`
- `argocd/applications/torghut/**`
- `services/torghut/**`
- live `/readyz`, `/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence` responses

## Retained Contract Entry Points

- `08-profitability-research-validation-execution-governance-system.md`
- `14-legacy-gap-disposition-map-2026-03-03.md`
- `29-code-investigated-vnext-architecture-reset-2026-03-06.md`

These contracts remain referenced by the implementation or tests. Their dated decisions and status language require
current source, GitOps, tests, and runtime evidence before use in an operational decision. The legacy disposition
table links to removed proposals at their last retained Git revision.

## Retained Evidence Maps

- `29-completion-matrix-2026-03-07.yaml` is machine-consumed by Torghut completion-trace tests and must remain aligned
  with the runtime matrix.

## Later Design Records

The remaining numbered files are dated design, repair, proof, and closeout records. They are retained for referenced
contracts and source archaeology, not as a build order or an operations journal. Search the directory by the concrete
domain or contract identifier needed; do not infer current authority from sequence numbers, document status labels, or
the newest filename.

Completed rollout journals, orphaned proposals, and superseded catalogs belong in Git history. Before keeping or
removing an individual record, follow `docs/documentation-authority.md` and verify inbound references from live code,
configuration, tests, or maintained documentation.
