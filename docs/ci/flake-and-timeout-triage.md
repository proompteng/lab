# CI flake and timeout triage

Use the auditor to decide what to reproduce, which runner or subprocess budget to inspect, and which failures warrant
investigating a retry. It does not rerun, cancel, quarantine, or change checks.

## Sample recent runs

From the repository root with Bun and an authenticated GitHub CLI that can read Actions:

```sh
bun run packages/scripts/src/ci/audit-ci-flakes.ts --workflow scripts-ci.yml --limit 25 --format markdown
bun run packages/scripts/src/ci/audit-ci-flakes.ts --workflow agents-ci.yml --limit 25 --format json
```

Without a workflow filter, the sample is the latest 25 completed runs across workflows on `main` in `proompteng/lab`.
Use `--repo`, `--branch`, `--workflow` (filename or ID), and `--limit` (1–100) to narrow a live sample. The CLI reads
[run metadata](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository) and
[job metadata for all attempts](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run) using
GitHub CLI GET requests. It inspects individual job logs only to look for timeout evidence on otherwise ambiguous
failures or cancellations. Reports do not include raw logs, API errors, URLs, or credentials.

## Interpret the report

| Classification             | Evidence and next action                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deterministic_regression` | No timeout, cancellation, or passing retry was observed. Treat it as a regression candidate and reproduce the failing step on the same revision before changing a required check.                                                                                                                              |
| `runner_timeout`           | An explicit `timed_out` result or a recognized timeout diagnostic. Compare the step and runner pool before changing budgets. For the 5-second Bun test timeout, check subprocess startup and contention; for the 15-minute Agents preload timeout, inspect image pulls and Kind preload progress.              |
| `flake_retry_passed`       | A uniquely named job passed on a later attempt of the **same run**. For a step, its number and name must also match and the step must explicitly pass. Compare the attempts and track the unstable test or dependency; a skipped step or a passing job in a different run is not retry evidence for that step. |
| `infra_cancelled`          | GitHub reported cancellation with no timeout evidence. Check concurrency supersession, manual cancellation, or runner loss; the report does not prove which one occurred.                                                                                                                                      |

Timeout evidence takes precedence over cancellation and a passing retry. Short process/test diagnostics are matched
only within affected step timestamps so a timeout printed by a passing step does not relabel an unrelated failure.
Unrecognized diagnostics or unavailable logs can hide timeout evidence; the report counts and flags unavailable
failure logs. Use the run, attempt, and job IDs to inspect the original failed execution in GitHub when needed.

Rates are calculated per job attempt, not per step or per workflow run. The denominator is successes plus failures
(including timeouts and failures followed by a retry pass); infrastructure cancellations are counted separately.
Skipped, neutral, in-progress, and other non-outcomes are excluded. An empty denominator is `null` in JSON and
`n/a` in Markdown. Runner buckets use exact `arc-amd64`, `arc-arm64`, and `ubuntu-latest` labels; jobs without any
of those labels (including `ubuntu-24.04` Agents smoke jobs) count under `other`. A job with multiple tracked labels
counts once in each of those buckets. The top five recurring names in each bucket are ranked by failed attempts
(at least two), with ties broken by workflow and job name.

## Reproduce offline

Pass `--fixture path/to/fixture.json` instead of live query options. A fixture contains the same projected GitHub
run/job fields with jobs embedded under each run; no GitHub CLI or network access is needed. Use synthetic or
redacted data. The optional job `log` is a string of timestamped lines; omit it to model a missing failure log.

```json
{
  "runs": [
    {
      "id": 1001,
      "workflow_id": 100,
      "name": "packages-scripts",
      "run_attempt": 1,
      "jobs": [
        {
          "id": 2001,
          "run_attempt": 1,
          "name": "lint-and-test / run",
          "status": "completed",
          "conclusion": "failure",
          "labels": ["ubuntu-latest"],
          "steps": [
            {
              "number": 10,
              "name": "Test",
              "conclusion": "failure",
              "started_at": "2026-11-28T04:00:00Z",
              "completed_at": "2026-11-28T04:00:07Z"
            }
          ],
          "log": "2026-11-28T04:00:07.538Z   ^ this test timed out after 5000ms."
        }
      ]
    }
  ]
}
```

Both formats are deterministic for the same input, with no generated timestamps. Exit code 0 means the report was
produced, not that the sample passed CI. Invalid arguments, fixtures, or unreadable run/job metadata exit nonzero.
