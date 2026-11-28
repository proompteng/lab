# Profile GitHub Actions critical paths and runner queues

Use the profiler from the repository root to distinguish runner queue time from execution time and see how much runner
time was spent on cancelled attempts. It reads Actions metadata only: it does not fetch logs, cancel or rerun jobs, edit
workflows, or write to GitHub.

## Live mode

Requires Bun, the repository's Bun dependencies, and an authenticated `gh` with Actions read access to the repository.
For example, compare main-branch publish workflows using the same sample size:

```sh
bun run packages/scripts/src/ci/profile-ci-critical-path.ts \
  --workflow agents-build-push.yml --branch main --event push --limit 30 --format markdown

bun run packages/scripts/src/ci/profile-ci-critical-path.ts \
  --workflow bayn-build-push.yml --branch main --event push --limit 30 --format json
```

Without filters the CLI samples the latest 30 completed run IDs across `proompteng/lab`. `--repo owner/repo` selects
another GitHub.com repository, `--workflow` accepts a filename or numeric ID, and `--limit` accepts 1–100 run IDs.
`--branch` and `--event` apply before sampling. Add `--workflow` for a representative sample of a low-volume workflow.
For each selected ID the profiler reads all listed attempts and pages their job lists; reruns can therefore make the
attempt count exceed the run limit. A run whose latest attempt is still in progress is not in the live sample. A failed
API read aborts the report rather than dropping data. Omit `--format` for Markdown.

## Offline mode

Pass a JSON file containing `runs`, an array of run **attempts**. Each attempt contains its own `jobs` array. Use the
GitHub REST field names shown below; `created_at` and `run_started_at` should describe that attempt, not the original run
when the attempt is a rerun. Timestamps may be omitted or `null` if unknown. A job's `runner_id` must be numeric for an
assigned runner or `null` (or `0`) if no runner was assigned. Extra fields are ignored. No `gh` or live filters are used
in fixture mode.

```json
{
  "runs": [
    {
      "id": 101,
      "workflow_id": 200,
      "name": "example-build",
      "run_attempt": 1,
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-01-01T00:00:00Z",
      "run_started_at": "2026-01-01T00:00:10Z",
      "updated_at": "2026-01-01T00:02:01Z",
      "jobs": [
        {
          "id": 102,
          "name": "build",
          "status": "completed",
          "conclusion": "success",
          "labels": ["arc-arm64"],
          "runner_id": 103,
          "created_at": "2026-01-01T00:00:10Z",
          "started_at": "2026-01-01T00:01:00Z",
          "completed_at": "2026-01-01T00:02:00Z"
        }
      ]
    }
  ]
}
```

```sh
bun run packages/scripts/src/ci/profile-ci-critical-path.ts --fixture /tmp/ci-profile.json --format json
```

## Reading the report

- **Workflow timing:** wall = completion − `created_at`; queue = `run_started_at` − `created_at`; execution =
  completion − `run_started_at`. The [workflow runs REST API](https://docs.github.com/en/rest/actions/workflow-runs)
  exposes `updated_at` rather than `completed_at`, so live wall and execution use the terminal `updated_at` as a proxy.
  A fixture may supply an exact `completed_at`. Workflow queue is not the same as time waiting for an ARC runner.
- **Runner pools:** job queue = `started_at` − `created_at`; job execution = `completed_at` − `started_at`. The
  [workflow jobs REST API](https://docs.github.com/en/rest/actions/workflow-jobs) supplies job timestamps and labels.
  A single `arc-*` label identifies its pool even alongside generic labels; otherwise jobs are grouped by their sorted,
  case-insensitive label set. Pools such as `arc-amd64-tmpfs` remain separate from `arc-amd64`. Compare queue P90 and
  sample counts before calling a pool starved: unassigned jobs have no measured start, and queue time can also reflect
  scheduling limits such as matrix parallelism.
- **Critical path:** live `observed` paths end at the last measured job finish and choose the chain of non-overlapping
  job windows that explains the most wall time. Each window includes measured job queue and execution (only execution if
  the queue is unknown). Parallel windows are not added together; gaps and workflow-level orchestration are not
  attributed to a job. The reported duration is exact for those measured windows, not a claim that GitHub scheduled the
  jobs in dependency order. The job API does not expose `needs` edges. In a fixture with a known graph, set `needs` to
  an array of measured predecessor job IDs on every measured job (`[]` for roots). This selects the longest weighted
  dependency path and counts only queue time after all of a job's predecessors finished toward the path; the runner
  table still shows raw job queue time. Edges to unmeasured jobs or schedules inconsistent with the graph are rejected.
- **Top bottlenecks:** the first ten workflow/job/runner combinations by accumulated queue plus execution on selected
  paths. This is observed wall-clock contribution across the sample, not a predicted speedup. Compare the queue and
  execution columns to decide what to investigate first.
- **Cancellation waste:** sums observed execution time on assigned runners for `cancelled` attempts, including jobs that
  finished before the rest of the attempt was cancelled. Parallel jobs consume runner-minutes independently. A
  cancellation with no assignment consumes no measured runner-minutes even if GitHub filled in job timestamps. Assigned
  jobs lacking a valid execution interval are reported separately; they make the total a lower bound. GitHub's
  `cancelled` conclusion does not distinguish [`cancel-in-progress`](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
  from a manual cancellation or replacement of a pending run. Use `--branch main --event push` to isolate main pushes,
  not to infer the cause of every cancellation.

Only completed attempts are profiled, and skipped jobs do not contribute. P50/P90 use nearest rank and exclude missing
or reversed timestamp pairs instead of treating them as zero. JSON uses milliseconds (except `wastedComputeMinutes`)
and `null` for unavailable timing; Markdown displays seconds and runner-minutes. Both formats are deterministic for the
same input sample.
