# Running the Codex Spark review/fix cycle

Use this manifest as the reusable entry point for the Codex Spark two-stage PR cycle:
`review` first, then `fix` in the same shared workspace.

1. Set the per-run inputs in `docs/agents/codex-spark-review-workflow-run.yaml` (or patch it in CI):
   - `metadata.name` must be unique per invocation.
   - `parameters.head`, `parameters.issueNumber`, `parameters.issueTitle`, `parameters.issueUrl`.
2. Apply the manifest in the `agents` namespace.
3. Monitor the workflow. The first step writes review findings to
   `/agentworkspace/.agentrun/codex-spark-review/review-notes.md` and the second step consumes it.
4. If the fix step reports an empty diff, it will be a no-op and no commit is pushed.

```bash
kubectl apply -f docs/agents/codex-spark-review-workflow-run.yaml
kubectl -n agents wait --for=condition=Succeeded "agentrun/<run-name>" --timeout=900s
kubectl -n agents get agentrun <run-name> -o yaml
kubectl -n agents get jobs -l agents.proompteng.ai/agent-run=<run-name> -o wide
```

Suggested reusable invocation pattern (do not commit PR-specific values into repo defaults):

```bash
RUN_NAME="codex-spark-review-pr3786"
sed "s/^  name: codex-spark-review$/  name: ${RUN_NAME}/" \
  docs/agents/codex-spark-review-workflow-run.yaml | \
  yq '
    .spec.parameters.head = "codex/3786-spark-review-fix-run1" |
    .spec.parameters.issueNumber = "3786" |
    .spec.parameters.issueTitle = "Review and fix PR 3786" |
    .spec.parameters.issueUrl = "https://github.com/proompteng/lab/pull/3786"
  ' | kubectl apply -f -
kubectl -n agents wait --for=condition=Succeeded "agentrun/${RUN_NAME}" --timeout=1200s
```

Required per-run inputs:
- `parameters.repository` (example: `proompteng/lab`)
- `parameters.base` (default example: `main`)
- `parameters.head` (example: `codex/<branch>`)
- `parameters.issueNumber`
- `parameters.issueTitle`
- `parameters.issueUrl`

## How to verify stage behavior

- `review` step:
  - Command behavior is in logs from the step pod:
    `kubectl -n agents logs <review-step-pod>`
  - Review output is written to the shared workspace path above and passed to the `fix` step by PVC.
- `fix` step:
  - Command behavior is in logs from the step pod:
    `kubectl -n agents logs <fix-step-pod>`
  - If findings are actionable, this step edits files on `head` and pushes updates.
  - If no actionable findings exist, it exits successfully with no changes pushed.

Useful triage commands:

```bash
kubectl -n agents get jobs -l agents.proompteng.ai/agent-run=<run-name> -o json
kubectl -n agents logs -f <pod-name>
kubectl -n agents logs -f <pod-name> | rg -n "requested diff|git status|push|fatal"
kubectl -n agents get cm -l agents.proompteng.ai/agent-run=<run-name> -o name
```

Where to inspect outputs:
- Review file: `/agentworkspace/.agentrun/codex-spark-review/review-notes.md` (on the shared PVC used by both steps).
- Runtime artifacts (controller-generated): `agent-runner` logs/status in run artifacts and controller-generated ConfigMap
  (`run.json.*` keys).
- Push outcome: if the fix step changed files, expect a new remote head branch push and then branch state update.
