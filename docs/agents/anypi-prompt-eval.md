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
| `repair-loop` | five-run batch | `20260616a` | `#10911`, `#10912`, `#10913` (invalidated) | Some local validations passed | Failed: gh CLI version 2.46.0 lacks `pr checks --json`, runner saw zero checks while GitHub had failures | 1 validation, 0 CI repairs | Do not promote - image issue fixed in `fc4a51679` |
| `repair-loop` | five-run batch | `20260616b` | `#10918`, `#10919`, `#10920`, `#10921` (invalidated) | Some local validations passed | Failed: required-check probe treated no-checks as unavailable instead of retryable before falling back to all PR checks | 1 validation, 0 CI repairs | Do not promote - CI probe improved in `fc4a51679` |
| `repair-loop` | five-run batch | `20260616c` | `#10922` (invalidated) | Targeted Torghut validation passed before CI wait | Failed: all-checks probe before GitHub created checks treated as unavailable instead of pending/retryable | 1 validation, 0 CI repairs | Do not promote - CI probe improved in `fc4a51679` |
| `repair-loop` | five-run batch | `20260616d` | pending | pending | pending | pending | Scheduled with multi-arch `fc4a51679` image |
| `repair-loop` | agents-docs-manifests | `20260616e` | pending | pending | pending | pending | Scheduled with multi-arch `fc4a51679` image |

> **Note**: Batches `20260616a`, `20260616b`, `20260616c` were invalidated due to tooling issues in the `292c28dc` image. The `fc4a51679` multi-arch image includes fixes for `gh` CLI version requirements and CI probe behavior. Use the updated image for all new evaluations.

## Commands

```bash
kubectl -n agents get agentprovider anypi-eval
kubectl -n agents get agent anypi-eval-agent
kubectl -n agents get agentrun -l app.kubernetes.io/part-of=anypi-prompt-eval
kubectl apply -f docs/agents/anypi-prompt-eval-agentruns.yaml
```

## Validation and Audit Checklist

Every prompt-eval AgentRun should:

- [ ] Use a unique `spec.parameters.head` branch following `codex/anypi-eval/<variant>/<task>/<yyyymmddhhmm>` format
- [ ] Include `anypi.proompteng.ai/eval-batch`, `anypi.proompteng.ai/prompt-variant`, and `anypi.proompteng.ai/task` labels
- [ ] Set `runtime.config.nodeSelector` with `kubernetes.io/arch` for multi-arch coverage
- [ ] Run the full validation plan (local commands + CI checks) before merging
- [ ] Produce a PR with green required checks and no placeholder content
- [ ] Have status evidence written to `/workspace/.agent/status.json` with all required fields
- [ ] Have a PR body that follows the repository template with all sections filled

Invalid AgentRuns (failed before PR or with PR checklist violations) should be marked as such in the results table with the reason for invalidation.
