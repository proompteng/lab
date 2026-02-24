# Replay CI Gate (Design)

This document defines a CI gate that prevents merging workflow code changes that
would introduce nondeterminism when replaying known workflow histories.

The Bun SDK already ships `temporal-bun replay` and a determinism diff pipeline.
The missing piece is policy and automation:

- which histories are required
- when the gate runs
- what “pass” means
- how engineers remediate failures

## Goals

- Block workflow changes that would fail replay for older histories.
- Make “safe changes” easy and fast to validate.
- Provide actionable mismatch reports as CI artifacts.

## Non-Goals

- Replaying the entire production history corpus on every PR.
- Proving determinism for unseen histories.

## Inputs

The gate replays one or both of:

1. **Repository fixtures** (always available):
   - `packages/temporal-bun-sdk/tests/replay/fixtures/*.json`
2. **Golden histories** (curated exports, optional):
   - stored under `docs/replay-runbook.md` procedures
   - sourced from staging or a production sampling job

Golden histories must:

- include the workflow type and identifying metadata
- be stable (avoid workflows with nondeterministic markers from older SDKs)
- be small enough to replay within CI budgets

## When The Gate Runs

The gate runs when:

- any file under a configured workflow root changes
- or the SDK workflow runtime changes (`packages/temporal-bun-sdk/src/workflow/**`)

CI can derive this from the git diff.

## “Pass” Criteria

The gate is green when:

- every required history replays deterministically (`temporal-bun replay` exit code `0`)

If a replay mismatch occurs, the gate is red unless the change is explicitly
versioned and deployment-pinned:

- The workflow code includes a branch via `determinism.getVersion` or `determinism.patched`.
- The worker is deployed with build ID pinning so old runs keep executing the
  old code. (See `nondeterminism-guardrails.md`.)

Note: CI cannot fully verify “old runs stay on old code” without connecting to a
cluster. The gate enforces that versioning helpers are present when a mismatch
is detected, and requires a human acknowledgement for pinning.

## Command Contract

Baseline command:

```bash
bunx temporal-bun replay --history-file <path> --json
```

CI wrapper:

- runs replay for each fixture
- collects JSON outputs
- summarizes mismatches by workflow type and mismatch category

Artifacts:

- `replay-report.json` (merged)
- `replay-report/*.json` (per history)

## CI Integration Sketch

Example (conceptual) GitHub Actions step:

```bash
changed=$(git diff --name-only origin/main...HEAD)
if echo \"$changed\" | rg -q \"(src/workflows|packages/temporal-bun-sdk/src/workflow)\"; then
  bunx temporal-bun replay --history-dir ./ci/golden-histories --json --out ./artifacts/replay
fi
```

## How To Curate Golden Histories

Golden histories are a deliberate sampling set, not an ever-growing dump.

Selection guidelines:

- critical workflows (payment, provisioning, enrichment)
- workflows with signals and updates
- workflows with timers and child workflows
- a representative set of older histories across releases

Size guidelines:

- total replay budget per PR: 2-5 minutes
- per-history budget: < 10 seconds

## Remediation Playbook (What Engineers Do When Red)

1. If the change is intended to be compatible:
   - fix the code so it emits the same command intent sequence
2. If the change is intentionally breaking:
   - add a version branch using `determinism.getVersion` or `determinism.patched`
   - ensure deployment uses build ID pinning
   - add/adjust fixtures to lock in the new behavior

## Implementation Notes (For Agent Runs)

1. Extend `temporal-bun replay` to support directory replay with stable output:
   - `packages/temporal-bun-sdk/src/bin/replay-command.ts`
2. Add a CI helper script:
   - `packages/temporal-bun-sdk/scripts/replay-ci-gate.ts`
3. Add docs and sample config:
   - store golden histories under `docs/temporal-bun-sdk/golden-histories/` or
     a repo-specific location
4. Add tests:
   - `packages/temporal-bun-sdk/tests/cli/temporal-bun-replay-ci-gate.test.ts`

Use TODO markers:

- `// TODO(TBS-NDG-004): replay CI gate runner`

## Acceptance Criteria

1. CI gate replays fixtures deterministically on main.
2. A PR that changes a workflow to emit a different command sequence fails the gate.
3. CI artifacts include per-history mismatch details with:
   - command mismatch signatures
   - missing time/random values
   - last determinism marker metadata
