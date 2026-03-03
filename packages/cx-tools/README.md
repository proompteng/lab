# cx-tools (scaffold)

- `cx-codex-run`: thin wrapper for `codex exec` that supports prompt sourcing and JSON streaming.
- `cx-workflow-start`: wrapper for `temporal workflow start`.
- `cx-workflow-signal`: wrapper for `temporal workflow signal`.
- `cx-workflow-query`: wrapper for `temporal workflow query`.
- `cx-workflow-cancel`: wrapper for `temporal workflow cancel`.
- TODO(jng-010c): Add optional `cx-log` tailer for workflow/activity logs.

Artifacts are expected to build into `dist/` and be bundled into the Jangar image (see `docs/jangar/implementation-plan.md`).
