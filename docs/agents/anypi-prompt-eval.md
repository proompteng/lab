# Anypi Prompt Evaluation

Status: implementation/evaluation protocol

## Purpose

Anypi does not promote a final system prompt by taste. Prompt variants are compared with real AgentRuns that must create
code and tests, pass local validation, open PRs, and wait for required GitHub checks.

### Auditability Goals

Prompt-eval batches are designed to be auditable:
- Every AgentRun has unique labels: `anypi.proompteng.ai/prompt-variant`, `anypi.proompteng.ai/task`, `anypi.proompteng.ai/eval-batch`
- AgentRuns use `ttlSecondsAfterFinished` for automatic cleanup
- Validation commands are explicit and reproducible
- PR bodies include validation evidence from runner status

## Variants

- `minimal`: short repo-coding contract.
- `finish-gated`: `minimal` plus explicit continue-until-validation behavior.
- `repair-loop`: `finish-gated` plus failure-output/root-cause repair discipline.
- `strict-repo`: `repair-loop` plus stronger AGENTS.md, no-hardcoding, no-test-weakening, no-unrelated-refactor rules.

The prompt text is resolved inside `services/anypi/src/prompt.ts`. Runtime details are not model-facing.

## Evaluation Matrix

Run at least three substantial tasks against at least three variants. Evaluation batches should schedule five AgentRuns at
the same time when the cluster has runner capacity, then collect results from all five before deciding the next batch. Every
run must use a unique branch:

```text
codex/anypi-eval/<variant>/<task>/<yyyymmddhhmm>
```

Required task classes:

- Torghut: improve executable changed-line reporting in `services/torghut/scripts/check_diff_coverage.py` and add
  regression tests in `services/torghut/tests/test_check_diff_coverage.py`.
- Anypi: improve runner behavior or tests under `services/anypi` with TypeScript validation.
- Infra/docs plus code: touch `argocd/applications/agents` and docs while preserving manifest rendering and PR-template
  compliance.

### Validation Checklist for Each AgentRun

Before considering an AgentRun successful, verify:

1. **AgentRun Status**: `Succeeded` phase
2. **Worktree Changes**: Contains real code/test diffs (not just documentation)
3. **Local Validation**: All `validationCommands` pass locally
4. **PR Created**: Pull request opened with required GitHub checks
5. **Required CI**: All required checks green (no pending/failing)
6. **Status Evidence**: Contains `promptVariant`, `promptHash`, `validationPlan`, validation results, CI result, commit, PR URL, session path
7. **No Runtime Leakage**: Model-facing prompts don't contain runtime details
8. **No Hardcoding**: No hardcoded test hacks, removed tests, fake validation, or broad unrelated refactors

The ready-to-apply batch template is `docs/agents/anypi-prompt-eval-agentruns.yaml`. Apply it as one file so the five runs
start concurrently. The template pins the multi-arch Anypi image and uses `runtime.config.nodeSelector` to force coverage on
both `amd64` and `arm64` nodes.

### Batch Template Conventions

- **Labels**: Always include `anypi.proompteng.ai/prompt-variant`, `anypi.proompteng.ai/task`, `anypi.proompteng.ai/eval-batch`
- **Validation Commands**: Include full lint/format/test checks for the service under change
- **Node Selectors**: Distribute across `amd64` and `arm64` for multi-arch image validation
- **TTL**: Use `ttlSecondsAfterFinished: 86400` (24 hours) for all eval AgentRuns

## Scoring

### Hard Gates (all must pass)

- AgentRun reaches `Succeeded`.
- Worktree contains a real code/test diff.
- Local validation passes for all `validationCommands`.
- PR is opened or updated with a valid template body.
- Required GitHub checks pass (no pending/failing).
- Status contains `promptVariant`, `promptHash`, `validationPlan`, validation results, CI result, commit, PR URL, and
  session path.
- No runtime leakage in model-facing prompts; no hardcoded test hacks, removed tests, fake validation, or broad unrelated
  refactors.

### Tie-breakers (when multiple variants pass)

- Fewer agent, validation, and CI repair attempts.
- Lower elapsed time from AgentRun start to PR merge readiness.
- Smaller unrelated diff (focus on the task at hand).
- Clearer PR body and status evidence.

### Promotion Rule

Promote a variant to `anypi-agent` only after:
- At least 80% green PR rate across all variants
- Zero instruction-violation failures (hard gate failures where the prompt variant caused incorrect behavior)

If no variant passes, leave `anypi-agent` on `minimal`, record the failures with full AgentRun logs, and iterate the variants.

## Current Results

| Variant | Task | AgentRun | PR | Local validation | Required CI | Repairs | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pending | pending | pending | pending | pending | pending | pending | pending |

## Commands

### Monitor Batches

```bash
# List all AgentRuns in a batch
kubectl -n agents get agentrun -l anypi.proompteng.ai/eval-batch=20260616a

# Get batch summary
kubectl -n agents get agentrun -l anypi.proompteng.ai/eval-batch=20260616a -o custom-columns='NAME:metadata.name,VARIANT:metadata.labels.anypi.proompteng.ai~1prompt-variant,TASK:metadata.labels.anypi.proompteng.ai~1task,PHASE:status.phase'

# Get all AgentRuns for prompt-eval
kubectl -n agents get agentrun -l app.kubernetes.io/part-of=anypi-prompt-eval
```

### Debugging Failed Runs

```bash
# Get runner logs
kubectl -n agents logs -f job/$(kubectl -n agents get job -l agents.proompteng.ai/agent-run=<name> -o jsonpath='{.items[0].metadata.name}')

# Get runner status (contains promptHash, validation results, CI attempts)
kubectl -n agents exec <job-pod> -- cat /workspace/.agent/status.json

# Get runner log (contains full prompt variant used)
kubectl -n agents exec <job-pod> -- cat /workspace/.agent/runner.log
```

### Apply Batch

```bash
kubectl apply -f docs/agents/anypi-prompt-eval-agentruns.yaml
```

### Verify Argo Manifests

```bash
# Validate agent manifests render without errors
kustomize build --enable-helm argocd/applications/agents >/dev/null

# Show anypi-eval configuration
kubectl -n agents get agentprovider anypi-eval -o yaml
kubectl -n agents get agent anypi-eval-agent -o yaml
```
