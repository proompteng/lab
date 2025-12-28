# Codex Judge Argo Tracking

This file tracks implementation issues tied to the Codex judge + Argo workflow workstream.

## Open Items
- Issue #2109: extend implementation workflow artifacts for judge pipeline.
  - PR #2111 adds the artifact outputs in the workflow template, but the implementation still needs
    verification that `codex-implement.ts` emits the new log/resume files and that Argo/MinIO uploads
    succeed for every run.
  - Pending: confirm artifacts exist in MinIO for a run and update the runner or mark artifacts
    optional if any files are missing.
  - Pending: ensure Codex review completion is explicitly gated and any Codex review comments are
    addressed before marking the issue complete.
