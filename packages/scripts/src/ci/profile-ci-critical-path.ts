import { parseArgs } from 'node:util'
import {
  type ProfileReport,
  type WorkflowAttempt,
  ProfileError,
  parseFixture,
  parseJobPages,
  parseRun,
  parseRunList,
  profileAttempts,
} from './profile-ci-critical-path-core'

const help = `Usage: bun run packages/scripts/src/ci/profile-ci-critical-path.ts [options]

  --fixture <path>        Read a local JSON fixture instead of contacting GitHub
  --format <format>      markdown (default) or json
  --repo <owner/repo>    GitHub.com repository (default: proompteng/lab)
  --workflow <file|id>   Restrict live runs to a workflow filename or ID
  --branch <name>        Restrict live runs to a branch
  --event <event>        Restrict live runs to an event (e.g. push)
  --limit <1-100>        Latest completed run IDs to sample (default: 30)
  --help                Show this help`

const parseOptions = (args: string[]) => {
  try {
    return parseArgs({
      args,
      options: {
        fixture: { type: 'string' },
        format: { type: 'string' },
        repo: { type: 'string' },
        workflow: { type: 'string' },
        branch: { type: 'string' },
        event: { type: 'string' },
        limit: { type: 'string' },
        help: { type: 'boolean' },
      },
    }).values
  } catch {
    throw new ProfileError('Invalid arguments. See --help for supported options.')
  }
}

const parseJson = (contents: string, source: string): unknown => {
  try {
    return JSON.parse(contents)
  } catch {
    throw new ProfileError(`Invalid JSON from ${source}.`)
  }
}

const readFixture = async (path: string) => {
  let contents: string
  try {
    contents = await Bun.file(path).text()
  } catch {
    throw new ProfileError('Could not read the fixture file.')
  }
  return parseFixture(parseJson(contents, 'the fixture'))
}

const ghGet = (endpoint: string, operation: string, paginate = false) => {
  const result = Bun.spawnSync(
    [
      'gh',
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      ...(paginate ? ['--paginate', '--slurp'] : []),
      endpoint,
    ],
    {
      env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (result.exitCode !== 0) {
    // Error bodies may echo request data; retain only the status code for diagnosis.
    const status = /\(HTTP (\d{3})\)/.exec(result.stderr.toString())?.[1]
    throw new ProfileError(
      `Could not ${operation}${status ? ` (HTTP ${status})` : ''}. Check gh access and Actions read permission.`,
    )
  }
  return parseJson(result.stdout.toString(), operation)
}

const readGitHub = ({
  repo = 'proompteng/lab',
  workflow,
  branch,
  event,
  limit = '30',
}: ReturnType<typeof parseOptions>) => {
  if (!/^[\w-]+\/(?!\.{1,2}$)[\w.-]+$/.test(repo)) throw new ProfileError('--repo must be an owner/repository pair.')
  if (workflow !== undefined && !/^(?:[1-9]\d*|[\w.-]+\.ya?ml)$/i.test(workflow)) {
    throw new ProfileError('--workflow must be a workflow filename or numeric ID.')
  }
  if (!/^(?:[1-9]\d?|100)$/.test(limit)) throw new ProfileError('--limit must be an integer from 1 to 100.')
  if (branch === '' || event === '') throw new ProfileError('--branch and --event must not be empty.')
  if (!Bun.which('gh')) throw new ProfileError('Live mode requires gh on PATH. Use --fixture to run offline.')

  const query = new URLSearchParams({ status: 'completed', per_page: limit })
  if (branch) query.set('branch', branch)
  if (event) query.set('event', event)
  const actions = `repos/${repo}/actions`
  const list = workflow ? `${actions}/workflows/${workflow}/runs` : `${actions}/runs`
  const runs = parseRunList(ghGet(`${list}?${query}`, 'list completed workflow runs'))

  const attempts: WorkflowAttempt[] = []
  for (const run of runs) {
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      // The run list keeps the original creation time even when it describes a later attempt.
      const resource = `run ${run.id} attempt ${attempt}`
      const endpoint = `${actions}/runs/${run.id}/attempts/${attempt}`
      const metadata = run.run_attempt === 1 ? run : parseRun(ghGet(endpoint, `read ${resource}`), run.id, attempt)
      const jobs = parseJobPages(
        ghGet(`${endpoint}/jobs?per_page=100`, `list jobs for ${resource}`, true),
        run.id,
        attempt,
      )
      attempts.push({ ...metadata, jobs })
    }
  }
  return attempts
}

const cell = (value: string) => value.replace(/[&<>|\\`*_~[\]]/g, (character) => `&#${character.charCodeAt(0)};`)
const seconds = (ms: number | null) => (ms === null ? '—' : (ms / 1000).toFixed(3))
const percentiles = ({ p50, p90, samples }: ProfileReport['workflows'][number]['wallMs']) =>
  `${seconds(p50)} / ${seconds(p90)} (${samples})`

const markdown = ({ workflows, runners, bottlenecks, attempts }: ProfileReport) =>
  [
    '# CI critical-path profile',
    '',
    `${attempts.length} completed attempts. Timings are in seconds; distribution cells show P50 / P90 (sample count).`,
    'Workflow completion uses `completed_at` when supplied and `updated_at` otherwise.',
    'Observed paths use job timestamps, not GitHub dependency edges. Cancelled runner-minutes do not identify the cause of cancellation.',
    '',
    '## Workflows',
    '',
    '| Workflow (ID) | Attempts | Wall | Queue | Execution | Critical path | Cancelled | No runner on cancellation | Untimed cancelled runner jobs | Wasted runner-min |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...workflows.map(
      (row) =>
        `| ${cell(row.workflow)} (${row.workflowId}) | ${row.attempts} | ${percentiles(row.wallMs)} | ${percentiles(row.queueWaitMs)} | ${percentiles(row.executionMs)} | ${percentiles(row.criticalPathMs)} | ${row.cancelledAttempts} | ${row.cancelledWithoutAssignedJobs} | ${row.untimedCancelledRunnerJobs} | ${row.wastedComputeMinutes.toFixed(3)} |`,
    ),
    '',
    '## Runner pools',
    '',
    '| Runner label | Jobs | Assigned | Queue | Execution | Wasted runner-min |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...runners.map(
      (row) =>
        `| ${cell(row.runner)} | ${row.jobs} | ${row.assignedJobs} | ${percentiles(row.queueWaitMs)} | ${percentiles(row.executionMs)} | ${row.wastedComputeMinutes.toFixed(3)} |`,
    ),
    '',
    '## Top bottlenecks by critical-path time',
    '',
    '| Workflow (ID) | Job | Runner | Appearances | Queue | Execution | Total |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...bottlenecks.map(
      (row) =>
        `| ${cell(row.workflow)} (${row.workflowId}) | ${cell(row.job)} | ${cell(row.runner)} | ${row.hits} | ${seconds(row.queueWaitMs)} | ${seconds(row.executionMs)} | ${seconds(row.wallMs)} |`,
    ),
    '',
    '## Per-attempt critical paths',
    '',
    '| Run / attempt | Conclusion | Wall | Queue | Execution | Path | Jobs (runner; queue / execution) |',
    '| --- | --- | ---: | ---: | ---: | --- | --- |',
    ...attempts.map((row) => {
      const path = row.criticalPath
      const jobs = path?.jobs.map(
        (job) => `${cell(job.name)} [${cell(job.runner)}; ${seconds(job.queueWaitMs)} / ${seconds(job.executionMs)}]`,
      )
      return `| ${row.runId} / ${row.attempt} | ${row.conclusion ?? '—'} | ${seconds(row.wallMs)} | ${seconds(row.queueWaitMs)} | ${seconds(row.executionMs)} | ${path ? `${seconds(path.durationMs)} (${path.method})` : '—'} | ${jobs?.join(' → ') ?? '—'} |`
    }),
  ].join('\n')

const main = async (args: string[]) => {
  const options = parseOptions(args)
  if (options.help) {
    console.log(help)
    return
  }
  const { fixture, format = 'markdown', repo, workflow, branch, event, limit } = options
  if (format !== 'json' && format !== 'markdown') throw new ProfileError('--format must be json or markdown.')
  if (
    fixture !== undefined &&
    (!fixture || [repo, workflow, branch, event, limit].some((value) => value !== undefined))
  ) {
    throw new ProfileError('--fixture requires a path and cannot be used with live filters.')
  }
  const report = profileAttempts(fixture === undefined ? readGitHub(options) : await readFixture(fixture))
  console.log(format === 'json' ? JSON.stringify(report, null, 2) : markdown(report))
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof ProfileError ? error.message : 'Could not produce the CI profile.')
    process.exitCode = 1
  }
}
