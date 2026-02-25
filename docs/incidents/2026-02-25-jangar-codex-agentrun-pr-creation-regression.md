# Incident Report: Jangar Codex AgentRun PR-Creation Regression

- **Date**: 25 Feb 2026 (UTC)
- **Detected by**: Failed AgentRuns and missing PR output for Torghut DSPy implementation lane
- **Reported by**: gregkonush
- **Services Affected**: `agents` namespace AgentRun job runtime, Jangar/Codex execution path
- **Severity**: High (code-change AgentRuns completed/faulted without producing expected pull requests)

## Impact Summary

- Multiple AgentRuns for the Torghut v5 DSPy adoption lane failed before completion and did not produce a PR.
- Control-plane and runtime behavior diverged from contract expectations for code-changing runs (`vcsPolicy: read-write`, `head` branch provided).
- Engineering time was consumed by repeated reruns and manual triage.

## User-Facing Symptom

AgentRun logs showed substantive implementation progress, but no pull request was created for the requested head branch. Subsequent reruns failed with runtime boot/runtime dependency errors.

## Affected Runs

- `torghut-v5-doc12-dspy-adoption-run-20260225b` (failed early, package import ENOENT)
- `torghut-v5-doc12-dspy-adoption-run-20260225d` (failed with missing `git` execution path)
- `torghut-v5-doc12-dspy-adoption-run-20260225e` (failed with missing `codex-nats-soak` binary)

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-02-25 08:xx | Run `...20260225b` fails: `ENOENT reading "/app/node_modules/@proompteng/discord"`. |
| 2026-02-25 09:0x | Fix merged for discord workspace import coupling (`#3644`, `f12b6082`). |
| 2026-02-25 09:1x | Run `...20260225d` fails: `posix_spawn 'git'` (worktree bootstrap missing). |
| 2026-02-25 09:2x | Fix merged for repository bootstrap in Codex implement path (`#3647`, `338312f4`). |
| 2026-02-25 09:3x | Run `...20260225e` fails: `Executable not found in $PATH: "codex-nats-soak"`. |
| 2026-02-25 09:24 | Runtime image fix merged to include codex NATS helper scripts (`#3650`, `1cc0ecd2`). |
| 2026-02-25 09:33 | GitOps promotions land (`#3651`, `#3652`), Argo apps refreshed to revision `aea6833...`. |
| 2026-02-25 10:06 | Recreated run `...20260225g` succeeds; agent creates PR `#3653`; checks green. |

## Root Cause

This was a runtime packaging and bootstrapping regression chain in Jangar Codex execution, not a prompt-injection omission.

Primary causes:

1. **Cross-workspace runtime import coupling**
   - `codex-runner` depended on `@proompteng/discord` package path at runtime.
   - In container image/runtime context, that path was absent, causing immediate ENOENT.

2. **Assumed pre-existing git worktree**
   - `codex-implement.ts` attempted git operations in `/workspace/lab` before guaranteeing repository checkout.
   - In job runtime where worktree may be absent, first git call failed with `posix_spawn 'git'`.

3. **Missing helper executables in runtime image**
   - `codex-implement.ts` invokes `codex-nats-soak` / `codex-nats-publish` by executable name.
   - Runtime Docker stage did not copy these scripts into `$PATH`, causing execution failure before finalization/PR lifecycle completion.

## What Was Not The Root Cause

- System prompt injection failure was not the root cause.
- Controller prompt hash wiring was intact; final successful rerun recorded a valid system prompt hash:
  - `c2b6f8b15d77f3af872b28174787ca8059b5e7d9cc2a9e65e341b5541ae06252`

## Corrective Actions Taken

1. Removed runtime dependency on Discord workspace import in codex runner path.
   - PR: `#3644`
   - Commit: `f12b6082`

2. Added repository checkout bootstrap logic to canonical `codex-implement.ts` before first git command.
   - PR: `#3647`
   - Commit: `338312f4`

3. Added `codex-nats-soak` and `codex-nats-publish` scripts to Jangar runtime image and marked executable.
   - PR: `#3650`
   - Commit: `1cc0ecd2`

4. Rolled out via GitOps promotion and verified deployed digests in `agents` and `jangar`.
   - Promotions: `#3651`, `#3652`
   - Argo apps: `Synced Healthy` on revision `aea6833cae6e...`

5. End-to-end validation via rerun with fresh idempotency/head branch.
   - Run: `torghut-v5-doc12-dspy-adoption-run-20260225g`
   - Result: `Succeeded`
   - PR created by agent runtime: `https://github.com/proompteng/lab/pull/3653`

## Preventive Actions

1. Add runtime packaging test for required Codex helper executables in Jangar image build validation.
2. Add startup self-check in Codex runtime for mandatory binaries (`git`, `codex-nats-soak`, `codex-nats-publish`) with explicit error classification.
3. Keep job-runtime bootstrap invariant in canonical `codex-implement.ts` and cover with regression tests for missing worktree state.
4. Extend release verification to include a lightweight canary AgentRun that exercises code-change flow through PR creation path.

## Lessons Learned

- AgentRun PR-creation failures can be caused by runtime packaging/boot invariants before business logic completes.
- Prompt integrity verification is necessary but not sufficient; runtime dependency closure must be continuously validated.
- GitOps sync status can appear healthy while workloads are stale until refresh/sync advances to the newest promotion revision.

## References

- [fix(jangar): decouple codex runner from discord workspace import (#3644)](https://github.com/proompteng/lab/pull/3644)
- [fix(jangar): bootstrap codex worktree in job runtime (#3647)](https://github.com/proompteng/lab/pull/3647)
- [fix(jangar): include codex nats helpers in runtime image (#3650)](https://github.com/proompteng/lab/pull/3650)
- [chore(jangar): promote image 1cc0ecd2 (#3651)](https://github.com/proompteng/lab/pull/3651)
- [chore(jangar): promote image 1cc0ecd2 (#3652)](https://github.com/proompteng/lab/pull/3652)
- [feat(torghut): adopt v5 dspy scaffolding with deterministic fallback (#3653)](https://github.com/proompteng/lab/pull/3653)
