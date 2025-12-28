# Codex Judge Argo Tracking

This file tracks implementation issues tied to the Codex judge + Argo workflow workstream.

## In Progress
- Issue #2109: complete Jangar judge integration and review-comment rerun handling (pending merge).
  - Ensure Codex review comments are parsed and injected into next_prompt on reruns.
  - Fix GitHub review thread parsing so review gate can function reliably.

## Completed
- Issue #2109: extend implementation workflow artifacts for judge pipeline.
  - PR #2111 merged with workflow outputs plus runner changes to ensure log/resume artifacts are always written.
