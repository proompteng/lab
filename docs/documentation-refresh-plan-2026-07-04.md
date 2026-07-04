# Documentation Refresh Plan — 2026-07-04

Status: Executed in this documentation authority refresh.

## Problem

The repo contained many useful design documents, but readers had to infer whether a document was current truth,
historical context, a handoff record, a research workup, or a runbook. The core drift was not broken links; it was old
design docs retaining current-sounding language after source code, GitOps, and runtime behavior had moved.

## Execution Plan

1. Establish a repo-wide authority model.
   - Add `docs/documentation-authority.md`.
   - Define the authority order: code/GitOps, runtime readback, current runbooks, historical designs, research, incidents.
2. Add a documentation landing page.
   - Add `docs/README.md` as the top-level documentation entry point.
   - Link current maps separately from historical/research corpora.
3. Mark design archives as archives.
   - Add `docs/agents/designs/README.md`.
   - Strengthen `docs/torghut/design-system/README.md` and the historical source-of-truth guide.
4. Update current service indexes.
   - Update `docs/agents/README.md` so the long Jangar/Torghut contract list is clearly a dated contract archive.
   - Update `docs/torghut/README.md` so dated accepted/current labels do not outrank live service behavior.
5. Mark research corpus authority.
   - Add `docs/whitepapers/README.md` so paper-derived designs are treated as implementation ideas until revalidated.
6. Preserve local validation and CI discipline.
   - Use text search and `git diff --check` for local validation.
   - Avoid adding another committed checker script.
   - Keep Torghut scheduler compatibility fixes already required by current tests.

## Completed Changes

- Added `docs/documentation-authority.md`.
- Added `docs/README.md`.
- Added `docs/agents/designs/README.md`.
- Added `docs/whitepapers/README.md`.
- Updated `README.md`, `docs/agents/README.md`, `docs/torghut/README.md`, and Torghut design-system index files.
- Left historical design documents in place, but made the archive and index authority clear.

## Follow-up Policy

When future work touches a dated design, the PR should either:

- update its status/current-truth notice;
- move active operational guidance into a current README or runbook;
- or explicitly state that the design is unchanged historical context.
