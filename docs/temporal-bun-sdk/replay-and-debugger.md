# Replay and debugger tooling

The `temporal-bun replay` command supports deterministic replays with
machine-readable summaries and Bun inspector debugging.

## Determinism diffs and JSON reports

- Determinism mismatches are summarized by type (command/time/random).
- Use `--json` to emit a full JSON report containing history metadata,
  determinism mismatches, and failure metadata.

```bash
bunx temporal-bun replay \
  --workflow-id order-123 \
  --run-id 8a0e... \
  --json
```

## Debug replayer (Bun inspector)

Use `--debug` to trigger a `debugger` statement before replay begins. Run with
Bun inspector enabled:

```bash
bun --inspect-brk ./node_modules/.bin/temporal-bun replay \
  --workflow-id order-123 \
  --run-id 8a0e... \
  --debug
```

Once attached, you can step through workflow replay deterministically and
inspect decoded history events.
