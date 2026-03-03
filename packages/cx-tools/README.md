# cx-tools (scaffold)

- `cx-codex-run`: thin wrapper for `codex exec` that supports prompt sourcing and JSON streaming.
- `cx-workflow-start`: wrapper for `temporal workflow start`.
- `cx-workflow-signal`: wrapper for `temporal workflow signal`.
- `cx-workflow-query`: wrapper for `temporal workflow query`.
- `cx-workflow-cancel`: wrapper for `temporal workflow cancel`.
- `TEMPORAL_ADDRESS`, `TEMPORAL_HOST`, `TEMPORAL_GRPC_PORT`, `TEMPORAL_NAMESPACE`,
  and `TEMPORAL_TASK_QUEUE` are optional defaults for temporal workflow wrappers.

Artifacts are built into `dist/` and bundled into Jangar images.
