# Anypi Prompt Evaluation

Status: implementation/evaluation protocol

## Purpose

Anypi does not promote a final system prompt by taste. Prompt variants are compared with real AgentRuns that must create
code and tests, pass local validation, open PRs, and wait for required GitHub checks.

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

The ready-to-apply batch template is `docs/agents/anypi-prompt-eval-agentruns.yaml`. Apply it as one file so the five runs
start concurrently. The template pins the multi-arch Anypi image and uses `runtime.config.nodeSelector` to force coverage on
both `amd64` and `arm64` nodes.

## Scoring

Hard gates:

- AgentRun reaches `Succeeded`.
- Worktree contains a real code/test diff.
- Local validation passes.
- PR is opened or updated.
- Required GitHub checks pass.
- Status contains `promptVariant`, `promptHash`, `validationPlan`, validation results, CI result, commit, PR URL, and
  session path.
- No runtime leakage in model-facing prompts; no hardcoded test hacks, removed tests, fake validation, or broad unrelated
  refactors.

Tie-breakers:

- Fewer agent, validation, and CI repair attempts.
- Lower elapsed time.
- Smaller unrelated diff.
- Clearer PR body and status evidence.

Promotion rule: promote a variant to `anypi-agent` only after at least 80% green PR rate and zero instruction-violation
failures. If no variant passes, leave `anypi-agent` on `minimal`, record the failures, and iterate the variants.

## Current Results

| Variant | Task | AgentRun | PR | Local validation | Required CI | Repairs | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mixed | five-run batch | `20260616a` | `#10911`, `#10912`, `#10913` before invalidation | Some local validations passed | Invalid measurement: image had `gh` 2.46.0 without `pr checks --json`, so the runner saw zero checks while GitHub had failures | Not scored | Do not promote from this batch |
| mixed | five-run batch | `20260616b` | `#10918`, `#10919`, `#10920`, `#10921` before invalidation | Some local validations passed | Invalid measurement: the required-check probe reported no checks as unavailable before falling back to all PR checks, so CI repair behavior was not scored | Not scored | Do not promote from this batch |
| mixed | five-run batch | `20260616c` | `#10922` before invalidation | Targeted Torghut validation passed before CI wait | Invalid measurement: all-checks probe before GitHub created checks was still treated as unavailable instead of pending/retryable | Not scored | Do not promote from this batch |
| `minimal` | Torghut diff coverage reporting | `anypi-eval-torghut-minimal-20260616d` | [#10927](https://github.com/proompteng/lab/pull/10927) | Passed targeted Torghut local checks after repair | Failed: `Bytecode + lint + migration guard`, `Bytecode + pytest + coverage`, and `check_changed_files` | 4 agent attempts, 4 validation attempts, 1 CI attempt | Failed; do not promote |
| `repair-loop` | Torghut diff coverage reporting | `anypi-eval-torghut-repair-20260616d` | [#10924](https://github.com/proompteng/lab/pull/10924) | Passed Torghut sync, ruff format, all three pyright profiles, and targeted pytest | Passed: 13 pass, 11 skipped | 2 agent attempts, 2 validation attempts, 1 CI repair cycle | Good task result |
| `finish-gated` | Anypi status evidence tests | `anypi-eval-runner-finish-20260616d` | [#10929](https://github.com/proompteng/lab/pull/10929) | Passed Anypi tsc, test, lint, and agents render | Passed: 11 pass, 12 skipped | 2 agent attempts, 2 validation attempts, 1 CI attempt | Green but not promotable: changed `bun.lock` and dependency version without explicit need |
| `strict-repo` | Anypi CI watcher regression coverage | `anypi-eval-runner-strict-20260616d` | [#10928](https://github.com/proompteng/lab/pull/10928) | Passed Anypi tsc, test, and lint | Passed: 3 pass, 10 skipped | 1 agent attempt, 1 validation attempt, 1 CI attempt | Good task result |
| `repair-loop` | Agents docs/manifests validation | `anypi-eval-agents-repair-20260616d` | [#10925](https://github.com/proompteng/lab/pull/10925) | Passed Anypi tsc, test, lint, and agents render | Passed: 13 pass, 12 skipped | 2 agent attempts, 2 validation attempts, 1 CI attempt | Green but not promotable: changed `bun.lock` with unrelated dependency churn |

Batch `20260616d` used
`registry.ide-newton.ts.net/lab/anypi:fc4a51679@sha256:3dd2c28b9426f0530f2661fbb2b30bc96ff43f54bef74c02f5fce5ba9ecf3a66`.
It scheduled all five AgentRuns at `2026-06-16T21:21:01Z` across both available runner architectures. The hard green
rate was 4/5, but the batch is not promotable because two green PRs touched lockfiles/generated dependency artifacts
without explicit task need. The default `anypi-agent` therefore remains `minimal` until the policy gate is proven in a
follow-up batch.

Guardrail added after `20260616d`: Anypi now fails validation with `anypi-policy restricted-files` when the worktree
contains lockfile or generated-artifact changes unless the run explicitly sets `allowRestrictedFileChanges=true`,
`allowGeneratedArtifactChanges=true`, or `allowLockfileChanges=true`. The system and task prompts also now state that
generated files and lockfiles must not be edited unless the task explicitly requires it.

## Commands

```bash
kubectl -n agents get agentprovider anypi-eval
kubectl -n agents get agent anypi-eval-agent
kubectl -n agents get agentrun -l app.kubernetes.io/part-of=anypi-prompt-eval
kubectl apply -f docs/agents/anypi-prompt-eval-agentruns.yaml
```
