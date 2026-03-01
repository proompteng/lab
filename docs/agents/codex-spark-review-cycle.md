# Running the Codex Spark review/fix cycle

Use this manifest as the documented, reusable entry point for running the Codex Spark review/fix pipeline on a PR.

1. Set the run input values in `docs/agents/codex-spark-review-workflow-run.yaml` (or overlay them when applying).
2. Apply the manifest with `kubectl` in the `agents` namespace.
3. Monitor the `AgentRun` until both `review` and `fix` workflow steps complete.

```bash
kubectl apply -f docs/agents/codex-spark-review-workflow-run.yaml
kubectl -n agents wait --for=condition=Succeeded agentrun/codex-spark-review --timeout=900s
kubectl -n agents get agentrun codex-spark-review -o yaml
```

Required per-run inputs:
- `parameters.repository` (example: `proompteng/lab`)
- `parameters.base` (default example: `main`)
- `parameters.head` (example: `codex/<branch>`)
- `parameters.issueNumber`
- `parameters.issueTitle`
- `parameters.issueUrl`
