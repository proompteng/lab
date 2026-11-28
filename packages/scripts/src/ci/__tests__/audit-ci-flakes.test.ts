import { expect, onTestFinished, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type AuditRun, auditCIFlakes, formatMarkdown, withFailureLog } from '../audit-ci-flakes-core'

type Job = AuditRun['jobs'][number]
type Step = Job['steps'][number]
const job = (id: number, name: string, conclusion: Job['conclusion'], extra: Partial<Job> = {}): Job => ({
  id,
  name,
  conclusion,
  run_attempt: 1,
  status: 'completed',
  labels: ['ubuntu-latest'],
  steps: [],
  ...extra,
})
const step = (number: number, name: string, conclusion: Step['conclusion'], extra: Partial<Step> = {}): Step => ({
  number,
  name,
  conclusion,
  ...extra,
})
const run = (id: number, jobs: Job[], extra: Partial<AuditRun> = {}): AuditRun => ({
  id,
  workflow_id: 100,
  name: 'packages-scripts',
  run_attempt: 1,
  jobs,
  ...extra,
})
const start = '2026-11-28T04:00:00Z'
const end = '2026-11-28T04:15:00Z'
const timing = { started_at: start, completed_at: end }
const bunTimeout = '2026-11-28T04:00:07.5381143Z   ^ this test timed out after 5000ms.'
const preloadTimeout =
  "2026-11-28T04:15:00.8344767Z ##[error]The action 'Preload published Agents runner' has timed out after 15 minutes."
const finding = (report: ReturnType<typeof auditCIFlakes>, id: number) =>
  report.findings.find((item) => item.jobId === id)

test('uses only a unique, later matching job or step in the same run as retry evidence', () => {
  const jobs = [
    job(1, 'test', 'failure', { steps: [step(3, 'Test', 'failure'), step(4, 'Optional', 'failure')] }),
    job(2, 'matrix', 'failure'),
    job(3, 'matrix', 'success'),
    job(4, 'other', 'failure'),
    job(5, 'test', 'failure', { run_attempt: 2, steps: [step(3, 'Test', 'success')] }),
    job(6, 'matrix', 'success', { run_attempt: 2 }),
    job(7, 'test', 'success', { run_attempt: 3, steps: [step(4, 'Optional', 'skipped')] }),
    job(8, 'other', 'success', { run_attempt: 4 }),
  ]
  const report = auditCIFlakes([run(1001, jobs, { run_attempt: 3 }), run(1002, [job(9, 'other', 'success')])])
  expect(finding(report, 1)).toMatchObject({
    classification: 'flake_retry_passed',
    passedOnAttempt: 3,
    steps: [
      { step: 'Test', classification: 'flake_retry_passed', passedOnAttempt: 2 },
      { step: 'Optional', classification: 'deterministic_regression' },
    ],
  })
  expect(finding(report, 2)?.classification).toBe('deterministic_regression')
  expect(finding(report, 4)?.classification).toBe('deterministic_regression')
  expect(finding(report, 5)).toMatchObject({ classification: 'flake_retry_passed', passedOnAttempt: 3 })
})

test('recognizes Bun and Actions timeouts at the affected steps and keeps them classified on a retry pass', () => {
  const scripts = withFailureLog(
    job(1, 'lint-and-test / run', 'failure', { steps: [step(2, 'Test', 'failure', timing)] }),
    bunTimeout,
  )
  const preload = withFailureLog(
    job(3, 'Agents Kind smoke', 'cancelled', {
      steps: [step(7, 'Preload published Agents runner', 'cancelled', timing)],
    }),
    preloadTimeout,
  )
  const report = auditCIFlakes([
    run(1001, [scripts, job(2, scripts.name, 'success', { run_attempt: 2 })], { run_attempt: 2 }),
    run(1002, [preload, job(4, 'build', 'cancelled'), job(5, 'matrix', 'timed_out')], {
      workflow_id: 101,
      name: 'agents-ci',
    }),
  ])
  expect(finding(report, 1)).toMatchObject({
    classification: 'runner_timeout',
    evidence: 'log',
    steps: [{ step: 'Test', classification: 'runner_timeout', evidence: 'log' }],
  })
  expect(finding(report, 3)).toMatchObject({
    classification: 'runner_timeout',
    steps: [{ step: 'Preload published Agents runner', classification: 'runner_timeout' }],
  })
  expect(finding(report, 4)?.classification).toBe('infra_cancelled')
  expect(finding(report, 5)).toMatchObject({ classification: 'runner_timeout', evidence: 'conclusion' })
})

test('ignores incidental timeout text and process timeouts outside a failed step; exposes missing logs', () => {
  const noisy = job(1, 'test', 'failure', {
    steps: [
      step(1, 'Passed', 'success', { started_at: start, completed_at: '2026-11-28T04:01:00Z' }),
      step(2, 'Failed', 'failure', { started_at: '2026-11-28T04:01:00Z', completed_at: end }),
    ],
  })
  const report = auditCIFlakes([
    run(1001, [
      withFailureLog(
        noisy,
        [
          bunTimeout,
          '2026-11-28T04:01:00.500Z subprocess timed out after 5s.',
          '2026-11-28T04:02:00Z echo "test timed out after 5000ms."',
          '2026-11-28T04:02:00Z configured timeout: 15 minutes',
        ].join('\n'),
      ),
      withFailureLog(job(2, 'unavailable', 'failure')),
      withFailureLog(job(3, 'cancelled', 'cancelled')),
    ]),
  ])
  expect(finding(report, 1)).toMatchObject({
    classification: 'deterministic_regression',
    failureLogUnavailable: false,
    steps: [{ step: 'Failed', classification: 'deterministic_regression' }],
  })
  expect(finding(report, 2)).toMatchObject({ classification: 'deterministic_regression', failureLogUnavailable: true })
  expect(finding(report, 3)).toMatchObject({ classification: 'infra_cancelled', failureLogUnavailable: false })
  expect(report.failureLogsUnavailable).toBe(1)
})

test('computes rates on non-cancelled outcomes and separates exact runner labels and workflow IDs', () => {
  const amd64 = { labels: ['arc-amd64'] }
  const arm64 = { labels: ['arc-arm64'] }
  const report = auditCIFlakes([
    run(
      1001,
      [
        job(1, 'test', 'failure', amd64),
        job(2, 'test', 'failure', { ...amd64, run_attempt: 2, steps: [step(2, 'Test', 'timed_out')] }),
        job(3, 'test', 'success', { ...amd64, run_attempt: 3 }),
        job(4, 'cancelled', 'cancelled', amd64),
        job(5, 'skipped', 'skipped', amd64),
        job(6, 'neutral', 'neutral', amd64),
        job(7, 'incomplete', null, { ...amd64, status: 'in_progress' }),
      ],
      { run_attempt: 3 },
    ),
    run(
      1002,
      [
        job(8, 'test', 'failure', arm64),
        job(9, 'smoke', 'timed_out', { labels: ['ubuntu-24.04'] }),
        job(10, 'build', 'success', { labels: ['arc-arm64', 'arc-amd64', 'arc-arm64'] }),
      ],
      { workflow_id: 101 },
    ),
    run(1003, [], { workflow_id: 102 }),
  ])
  expect(report.byWorkflow).toMatchObject([
    {
      workflowId: 100,
      runs: 1,
      jobAttempts: 4,
      failed: 2,
      timedOut: 1,
      cancelled: 1,
      failureRate: 2 / 3,
      timeoutRate: 1 / 3,
      topFailingJobs: [{ job: 'test', failures: 2 }],
    },
    { workflowId: 101, jobAttempts: 3, failed: 2, timedOut: 1, topFailingJobs: [] },
    { workflowId: 102, jobAttempts: 0, failureRate: null },
  ])
  expect(report.byRunnerLabel).toMatchObject([
    { label: 'arc-amd64', jobAttempts: 5, failureRate: 0.5, timeoutRate: 0.25 },
    { label: 'arc-arm64', jobAttempts: 2, failureRate: 0.5, timeoutRate: 0 },
    { label: 'ubuntu-latest', jobAttempts: 0, failureRate: null, timeoutRate: null },
    { label: 'other', jobAttempts: 1, failureRate: 1, timeoutRate: 1 },
  ])
  expect(report.priorities.map(({ classification, jobAttempts }) => [classification, jobAttempts])).toEqual([
    ['deterministic_regression', 1],
    ['runner_timeout', 2],
    ['flake_retry_passed', 1],
    ['infra_cancelled', 1],
  ])
})

test('keeps ranking, JSON and Markdown stable when run, job and step order changes', () => {
  const names = ['z', 'f', 'b', 'e', 'd', 'c', 'a']
  const jobs = names.map((name, i) =>
    job(i + 1, name, 'failure', {
      steps: [step(2, 'Test | <label>', 'failure'), step(1, 'Setup', 'failure')],
    }),
  )
  const runs = [
    run(1001, jobs),
    run(
      1002,
      jobs.map((job) => ({ ...job, id: job.id + 10 })),
    ),
    run(1003, [job(21, 'z', 'failure')]),
  ]
  const report = auditCIFlakes(runs)
  const reordered = auditCIFlakes(
    runs.toReversed().map((run) => ({
      ...run,
      jobs: run.jobs.toReversed().map((job) => ({ ...job, steps: job.steps.toReversed() })),
    })),
  )
  expect(report.byWorkflow[0].topFailingJobs.map(({ job, failures }) => [job, failures])).toEqual([
    ['z', 3],
    ['a', 2],
    ['b', 2],
    ['c', 2],
    ['d', 2],
  ])
  expect(JSON.stringify(report)).toBe(JSON.stringify(reordered))
  const markdown = formatMarkdown(report)
  expect(markdown).toBe(formatMarkdown(reordered))
  expect(markdown).toContain('Test &#124; &#60;label&#62;')
  expect(markdown).toContain('| ubuntu-latest | 15 | 15 | 0 | 0 | 100.0% |')
})

const cli = fileURLToPath(new URL('../audit-ci-flakes.ts', import.meta.url))
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-flake-audit-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const invoke = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawnSync([process.execPath, 'run', cli, ...args], { env: { PATH: dir, ...env }, timeout: 4000 })
  return { dir, invoke }
}

test('fixture mode runs without gh and does not print log text, credentials, or other raw fields', () => {
  const { dir, invoke } = sandbox()
  const path = join(dir, 'fixture.json')
  const canaries = ['ghp_synthetic_token', 'synthetic-password', 'postgresql://database.invalid/db', 'log-only-canary']
  writeFileSync(
    path,
    JSON.stringify({
      runs: [
        {
          ...run(1001, [], { name: canaries[0] }),
          jobs: [
            {
              ...job(1, `password=${canaries[1]}`, 'failure', {
                labels: [canaries[0]],
                steps: [step(2, canaries[2], 'failure', timing)],
              }),
              log: `${bunTimeout}\n${canaries[3]}`,
            },
          ],
        },
      ],
    }),
  )
  for (const format of ['json', 'markdown']) {
    const result = invoke(['--fixture', path, '--format', format])
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    for (const canary of canaries) expect(output).not.toContain(canary)
    expect(result.stderr.toString()).toBe('')
    expect(output).toContain('runner_timeout')
    expect(output).toContain(format === 'json' ? '[redacted]' : '&#91;redacted&#93;')
  }
})

test('invalid flags and fixtures fail with safe contextual errors', () => {
  const { dir, invoke } = sandbox()
  const path = join(dir, 'untrusted-path-name.json')
  const invalid = 'password=do-not-print'
  writeFileSync(path, JSON.stringify({ runs: [{ ...run(1001, []), run_attempt: invalid }] }))
  const result = invoke(['--fixture', path])
  expect(result.exitCode).toBe(1)
  expect(result.stdout.toString()).toBe('')
  expect(result.stderr.toString()).toBe('CI audit: Fixture has invalid data at runs.0.run_attempt.\n')
  const unknown = invoke([`--${invalid}`])
  expect(unknown.exitCode).toBe(1)
  expect(unknown.stderr.toString()).toBe('CI audit: Invalid arguments. See --help.\n')
  const mixed = invoke(['--fixture', path, '--limit', '2'])
  expect(mixed.exitCode).toBe(1)
  expect(mixed.stderr.toString()).toContain('--fixture cannot be combined')
})

test('live mode reads completed runs and every job page using GET, and treats log errors as unavailable', () => {
  const { dir, invoke } = sandbox()
  const calls = join(dir, 'calls')
  const actions = 'repos/example/repo/actions'
  const list = `${actions}/workflows/scripts-ci.yml/runs?branch=main&status=completed&per_page=2`
  const pages = `--paginate --slurp ${actions}/runs/1001/jobs?filter=all&per_page=100`
  const log = `${actions}/jobs/1/logs`
  const missingLog = `${actions}/jobs/2/logs`
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh
test "$1 $2 $3 $4 $5" = 'api --hostname github.com --method GET' || exit 99
shift 5
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  '${list}') printf '%s' "$RUNS" ;;
  '${pages}') printf '%s' "$JOBS" ;;
  '${log}') printf '%s' "$LOG" ;;
  '${missingLog}') printf '%s' 'password=not-for-output' >&2; exit 1 ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o700 },
  )
  const result = invoke(
    ['--repo', 'example/repo', '--workflow', 'scripts-ci.yml', '--limit', '2', '--format', 'json'],
    {
      CALLS: calls,
      RUNS: JSON.stringify({ workflow_runs: [run(1001, [], { run_attempt: 2 })] }),
      JOBS: JSON.stringify([
        { jobs: [job(1, 'test', 'failure', { steps: [step(2, 'Test', 'failure', timing)] })] },
        {
          jobs: [
            job(2, 'build', 'failure'),
            job(3, 'build', 'success', { run_attempt: 2 }),
            job(4, 'build', 'success', { run_attempt: 3 }),
          ],
        },
      ]),
      LOG: bunTimeout,
    },
  )
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe('')
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([list, pages, log, missingLog])
  const report: ReturnType<typeof auditCIFlakes> = JSON.parse(result.stdout.toString())
  expect(report.byWorkflow[0]).toMatchObject({ jobAttempts: 3, failureRate: 2 / 3, timeoutRate: 1 / 3 })
  expect(finding(report, 1)?.classification).toBe('runner_timeout')
  expect(finding(report, 2)).toMatchObject({
    classification: 'flake_retry_passed',
    passedOnAttempt: 2,
    failureLogUnavailable: true,
  })
})

test('a failed run metadata query exits nonzero without printing the raw gh error or a report', () => {
  const { dir, invoke } = sandbox()
  writeFileSync(join(dir, 'gh'), "#!/bin/sh\nprintf '%s' 'token=do-not-print' >&2\nexit 1\n", { mode: 0o700 })
  const result = invoke(['--limit', '1', '--format', 'json'])
  expect(result.exitCode).toBe(1)
  expect(result.stdout.toString()).toBe('')
  expect(result.stderr.toString()).toBe(
    'CI audit: GitHub query for completed runs failed (gh exit 1). Verify connectivity and Actions read access.\n',
  )
})
