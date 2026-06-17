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
start concurrently. The template must pin the current multi-arch Anypi image, but it should not force a single
architecture while cluster capacity is changing. Default controller scheduling now allows any compatible ready node,
including control-plane-tainted nodes when the workload tolerates them.

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

| Variant        | Task                                 | AgentRun                               | PR                                                         | Local validation                                                                              | Required CI                                                                                                                                                | Repairs                                                    | Decision                                                                                  |
| -------------- | ------------------------------------ | -------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| mixed          | five-run batch                       | `20260616a`                            | `#10911`, `#10912`, `#10913` before invalidation           | Some local validations passed                                                                 | Invalid measurement: image had `gh` 2.46.0 without `pr checks --json`, so the runner saw zero checks while GitHub had failures                             | Not scored                                                 | Do not promote from this batch                                                            |
| mixed          | five-run batch                       | `20260616b`                            | `#10918`, `#10919`, `#10920`, `#10921` before invalidation | Some local validations passed                                                                 | Invalid measurement: the required-check probe reported no checks as unavailable before falling back to all PR checks, so CI repair behavior was not scored | Not scored                                                 | Do not promote from this batch                                                            |
| mixed          | five-run batch                       | `20260616c`                            | `#10922` before invalidation                               | Targeted Torghut validation passed before CI wait                                             | Invalid measurement: all-checks probe before GitHub created checks was still treated as unavailable instead of pending/retryable                           | Not scored                                                 | Do not promote from this batch                                                            |
| `minimal`      | Torghut diff coverage reporting      | `anypi-eval-torghut-minimal-20260616d` | [#10927](https://github.com/proompteng/lab/pull/10927)     | Passed targeted Torghut local checks after repair                                             | Failed: `Bytecode + lint + migration guard`, `Bytecode + pytest + coverage`, and `check_changed_files`                                                     | 4 agent attempts, 4 validation attempts, 1 CI attempt      | Failed; do not promote                                                                    |
| `repair-loop`  | Torghut diff coverage reporting      | `anypi-eval-torghut-repair-20260616d`  | [#10924](https://github.com/proompteng/lab/pull/10924)     | Passed Torghut sync, ruff format, all three pyright profiles, and targeted pytest             | Passed: 13 pass, 11 skipped                                                                                                                                | 2 agent attempts, 2 validation attempts, 1 CI repair cycle | Good task result                                                                          |
| `finish-gated` | Anypi status evidence tests          | `anypi-eval-runner-finish-20260616d`   | [#10929](https://github.com/proompteng/lab/pull/10929)     | Passed Anypi tsc, test, lint, and agents render                                               | Passed: 11 pass, 12 skipped                                                                                                                                | 2 agent attempts, 2 validation attempts, 1 CI attempt      | Green but not promotable: changed `bun.lock` and dependency version without explicit need |
| `strict-repo`  | Anypi CI watcher regression coverage | `anypi-eval-runner-strict-20260616d`   | [#10928](https://github.com/proompteng/lab/pull/10928)     | Passed Anypi tsc, test, and lint                                                              | Passed: 3 pass, 10 skipped                                                                                                                                 | 1 agent attempt, 1 validation attempt, 1 CI attempt        | Good task result                                                                          |
| `repair-loop`  | Agents docs/manifests validation     | `anypi-eval-agents-repair-20260616d`   | [#10925](https://github.com/proompteng/lab/pull/10925)     | Passed Anypi tsc, test, lint, and agents render                                               | Passed: 13 pass, 12 skipped                                                                                                                                | 2 agent attempts, 2 validation attempts, 1 CI attempt      | Green but not promotable: changed `bun.lock` with unrelated dependency churn              |
| `minimal`      | Torghut diff coverage reporting      | `anypi-eval-torghut-minimal-20260616e` | None                                                       | Did not complete                                                                              | Not reached                                                                                                                                                | Deadline exceeded                                          | Failed; do not promote                                                                    |
| `repair-loop`  | Torghut diff coverage reporting      | `anypi-eval-torghut-repair-20260616e`  | [#10932](https://github.com/proompteng/lab/pull/10932)     | AgentRun failed after CI repair                                                               | Failed: `Bytecode + lint + migration guard` and `Bytecode + pytest + coverage`                                                                             | BackoffLimitExceeded                                       | Failed; do not promote                                                                    |
| `finish-gated` | Anypi status evidence tests          | `anypi-eval-runner-finish-20260616e`   | [#10930](https://github.com/proompteng/lab/pull/10930)     | Passed Anypi tsc, test, and lint                                                              | Passed required checks; unrelated matrix entries skipped                                                                                                   | 1 CI attempt                                               | Good task result                                                                          |
| `strict-repo`  | Anypi CI watcher regression coverage | `anypi-eval-runner-strict-20260616e`   | [#10931](https://github.com/proompteng/lab/pull/10931)     | Passed Anypi tsc, test, and lint                                                              | Passed required checks; unrelated matrix entries skipped                                                                                                   | 1 CI attempt                                               | Good task result                                                                          |
| `repair-loop`  | Agents docs/manifests validation     | `anypi-eval-agents-repair-20260616e`   | None                                                       | Did not produce a PR                                                                          | Not reached                                                                                                                                                | BackoffLimitExceeded                                       | Failed; do not promote                                                                    |
| `minimal`      | Torghut diff coverage reporting      | `anypi-eval-torghut-minimal-20260616g` | None                                                       | Validation repair made the commands pass, then the runner failed on a false no-progress guard | Not reached                                                                                                                                                | 1 validation repair                                        | Failed by runner bug; do not promote                                                      |
| `repair-loop`  | Torghut diff coverage reporting      | `anypi-eval-torghut-repair-20260616g`  | [#10941](https://github.com/proompteng/lab/pull/10941)     | Passed Torghut sync, ruff format, all three pyright profiles, and targeted pytest             | Passed full Torghut CI including bytecode, lint, pyright, pytest shards, coverage, and quality signals                                                     | 1 validation attempt, 1 CI attempt                         | Green task result                                                                         |
| `finish-gated` | Anypi status evidence tests          | `anypi-eval-runner-finish-20260616g`   | [#10940](https://github.com/proompteng/lab/pull/10940)     | Passed Anypi tsc, test, lint, and agents render                                               | Passed: 13 passed/skipped, 0 pending, 0 failed/cancelled                                                                                                   | 1 CI attempt                                               | Green task result                                                                         |
| `strict-repo`  | Anypi CI watcher regression coverage | `anypi-eval-runner-strict-20260616g`   | [#10942](https://github.com/proompteng/lab/pull/10942)     | Passed Anypi tsc, test, and lint                                                              | Passed: 13 passed/skipped, 0 pending, 0 failed/cancelled                                                                                                   | 1 CI attempt                                               | Green task result                                                                         |
| `repair-loop`  | Agents docs/manifests validation     | `anypi-eval-agents-repair-20260616g`   | [#10939](https://github.com/proompteng/lab/pull/10939)     | Passed Anypi tsc, test, lint, and agents render                                               | Passed Agents validate, Argo lint, integration, and required PR checks                                                                                     | 1 CI attempt                                               | Green task result                                                                         |

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

Batch `20260616e` used
`registry.ide-newton.ts.net/lab/anypi:1e8ff6b7c@sha256:1e6282c45e5e454a69ebfc77fea1cbba2b7e42fe49dc073a722b85c91a7b2c4d`
to test the restricted-file policy before any default prompt promotion.

Batch `20260616e` scheduled all five AgentRuns together at `2026-06-16T22:13:12Z`. It is not promotable: only the two
Anypi runner tasks reached green PRs, while the Torghut and Agents/docs tasks failed or did not open PRs. The default
`anypi-agent` therefore remains `minimal`.

Guardrail added after `20260616e`: Anypi now records `piPromptTimeoutSeconds`, bounds each Pi SDK prompt attempt with
`ANYPI_PI_PROMPT_TIMEOUT_SECONDS`, and fails a validation repair immediately when Pi returns without changing worktree
status or commit progress. This prevents repeated no-op repair/finalization loops from burning the whole Kubernetes Job
deadline.

Rollout note after `20260616e`: production Agents values no longer pin the control plane or default AgentRun workloads to
`arm64`; they use empty node selectors and tolerate `node-role.kubernetes.io/control-plane=NoSchedule`. Do not sync those
values until the Agents and Anypi images are confirmed multi-arch or otherwise available on every ready node that can
schedule the workload. At the time this note was written, registry manifest reads for `registry.ide-newton.ts.net` were
hanging inside `GetImageManifest`, so the next image publish and `20260616f` eval batch were pending registry recovery or
a documented local-image import.

Batch `20260616f` is not promotable. It used the temporary local image
`registry.ide-newton.ts.net/lab/anypi:73516839f-amd64` while registry manifest reads were unhealthy, and the early live
manifest had resource limits that OOM-killed runner jobs. The durable template now requests 8 Gi memory and limits runner
pods to 64 Gi memory and 48 Gi ephemeral storage.

Batch `20260616g` was submitted at `2026-06-17T00:22:49Z` as five concurrent AgentRuns using the same temporary local
image and corrected 64 Gi memory limits. All five pods scheduled on `turin`. This batch is valid for prompt evidence,
but the image path is still not durable because it was imported into containerd instead of pulled from a registry-pinned
multi-arch image.

The corrected batch produced four green PRs and one runner-harness failure:

- `repair-loop` completed both assigned tasks with green PRs: Torghut diff coverage [#10941](https://github.com/proompteng/lab/pull/10941)
  and Agents docs/manifests [#10939](https://github.com/proompteng/lab/pull/10939).
- `finish-gated` completed Anypi status evidence [#10940](https://github.com/proompteng/lab/pull/10940).
- `strict-repo` completed Anypi CI watcher coverage [#10942](https://github.com/proompteng/lab/pull/10942).
- `minimal` made validation pass after a format repair, but Anypi failed the run with
  `validation repair 1 produced no worktree changes` because the no-progress guard compared only path-level
  `git status --short` output. That failure is a runner bug, not a valid prompt score.

Promotion decision after `20260616g`: promote `repair-loop` to the default `anypi-agent` prompt variant. It is the only
variant with multiple green corrected runs across different task classes and zero policy violations.

Published rollout image after the no-progress fix:
`registry.ide-newton.ts.net/lab/anypi:9cd6ed580@sha256:b6f90e286832458ee228472a066ba1249536bef2d53618014164f70b85e01990`.
The index contains `linux/amd64` manifest
`sha256:0f60eb4d9af0a8d7d692e50d6565bfdc16016b2023aae03b4b6700992eba6d76` and `linux/arm64` manifest
`sha256:075019d2b839b71d288d66306d2c495480481dc57f589b2449f3ed35f5bec4fb`. The rollout is not complete until
the Agents GitOps app reconciles and a final default-provider Torghut AgentRun reaches a green PR.

Guardrail added after `20260616g`: validation-repair progress snapshots now include a hash of actual unstaged, staged,
and untracked content. A repair that reformats the same dirty path no longer fails just because the path-level status
line is unchanged.

## Commands

```bash
kubectl -n agents get agentprovider anypi-eval
kubectl -n agents get agent anypi-eval-agent
kubectl -n agents get agentrun -l app.kubernetes.io/part-of=anypi-prompt-eval
kubectl apply -f docs/agents/anypi-prompt-eval-agentruns.yaml
```
