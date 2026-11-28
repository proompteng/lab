import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ProfileReport, parseFixture, parseJobPages, profileAttempts } from '../profile-ci-critical-path-core'

type Lifecycle = [created: number | null, started: number | null, completed: number | null]
const time = (seconds: number | null) =>
  seconds === null ? null : new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString()

const job = (id: number, name: string, labels: string[], [created, started, completed]: Lifecycle) => ({
  id,
  name,
  labels,
  runner_id: id,
  status: 'completed',
  conclusion: 'success',
  created_at: time(created),
  started_at: time(started),
  completed_at: time(completed),
})

const run = (id: number, [created, started, completed]: Lifecycle, jobs: unknown[] = []) => ({
  id,
  workflow_id: 101,
  name: 'Build / publish',
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  created_at: time(created),
  run_started_at: time(started),
  updated_at: time(completed),
  jobs,
})

const profile = (...runs: unknown[]) => profileAttempts(parseFixture({ runs }))

test('computes nearest-rank attempt percentiles per workflow ID without treating missing times as zero', () => {
  const output = profile(
    run(1, [0, 10, 100]),
    run(2, [0, 20, 130]),
    { ...run(3, [0, 0, 900]), completed_at: time(60) },
    run(4, [5, 4, 35]),
    { ...run(5, [0, null, 10]), workflow_id: 102 },
    { ...run(6, [0, 0, null]), status: 'in_progress', conclusion: null },
  )
  expect(output.workflows).toMatchObject([
    {
      workflowId: 101,
      attempts: 4,
      wallMs: { samples: 4, p50: 60_000, p90: 130_000 },
      queueWaitMs: { samples: 3, p50: 10_000, p90: 20_000 },
      executionMs: { samples: 4, p50: 60_000, p90: 110_000 },
      criticalPathMs: { samples: 0, p50: null, p90: null },
    },
    { workflowId: 102, attempts: 1, executionMs: { samples: 0, p50: null, p90: null } },
  ])
  expect(output.attempts.find((attempt) => attempt.runId === 3)).toMatchObject({
    wallMs: 60_000,
    queueWaitMs: 0,
    completionSource: 'completed_at',
  })
  expect(output.attempts.find((attempt) => attempt.runId === 4)).toMatchObject({
    wallMs: 30_000,
    queueWaitMs: null,
    completionSource: 'updated_at',
  })
})

test('uses the longest non-overlapping chain to the last finish and ranks wall-clock impact', () => {
  const jobs = [
    job(1, 'prepare', ['ubuntu-latest'], [10, 12, 20]),
    job(2, 'main build', ['self-hosted', 'Linux', 'ARC-AMD64'], [20, 28, 70]),
    job(3, 'shorter branch', ['arc-arm64'], [61, 69, 76]),
    job(4, 'publish', ['ubuntu-latest'], [76, 80, 100]),
  ]
  const output = profile(run(1, [0, 10, 101], jobs), run(2, [0, 10, 101], jobs))
  expect(output.attempts[0]?.criticalPath).toEqual({
    method: 'observed',
    durationMs: 84_000,
    jobs: [
      { jobId: 1, name: 'prepare', runner: 'ubuntu-latest', queueWaitMs: 2000, executionMs: 8000, wallMs: 10_000 },
      { jobId: 2, name: 'main build', runner: 'arc-amd64', queueWaitMs: 8000, executionMs: 42_000, wallMs: 50_000 },
      { jobId: 4, name: 'publish', runner: 'ubuntu-latest', queueWaitMs: 4000, executionMs: 20_000, wallMs: 24_000 },
    ],
  })
  expect(output.runners).toMatchObject([
    { runner: 'arc-amd64', queueWaitMs: { p50: 8000, p90: 8000, samples: 2 }, executionMs: { p90: 42_000 } },
    { runner: 'arc-arm64', queueWaitMs: { p90: 8000, samples: 2 }, executionMs: { p90: 7000 } },
    { runner: 'ubuntu-latest', queueWaitMs: { p50: 2000, p90: 4000, samples: 4 }, executionMs: { p90: 20_000 } },
  ])
  expect(output.bottlenecks.map(({ job, hits, wallMs }) => [job, hits, wallMs])).toEqual([
    ['main build', 2, 100_000],
    ['publish', 2, 48_000],
    ['prepare', 2, 20_000],
  ])
  expect(profile(run(2, [0, 10, 101], jobs.toReversed()), run(1, [0, 10, 101], jobs))).toEqual(output)
})

test('uses explicit dependency edges when supplied and attributes only post-dependency queue time', () => {
  const jobs = [
    { ...job(1, 'unrelated', ['ubuntu-latest'], [0, 1, 35]), needs: [] },
    { ...job(2, 'build', ['arc-amd64'], [30, 33, 60]), needs: [] },
    { ...job(3, 'publish', ['arc-arm64'], [35, 67, 100]), needs: [2] },
  ]
  const output = profile(run(1, [0, 0, 101], jobs))
  expect(output.attempts[0]?.criticalPath).toMatchObject({
    method: 'dependencies',
    durationMs: 70_000,
    jobs: [{ jobId: 2 }, { jobId: 3, queueWaitMs: 7000, executionMs: 33_000 }],
  })
  expect(output.runners.find(({ runner }) => runner === 'arc-arm64')?.queueWaitMs.p90).toBe(32_000)
  expect(() => profile(run(1, [0, 0, 101], [jobs[2]!]))).toThrow('Unmeasured dependency 2')
  const cycle = [
    { ...job(4, 'four', [], [1, 1, 1]), needs: [5] },
    { ...job(5, 'five', [], [1, 1, 1]), needs: [4] },
  ]
  expect(() => profile(run(1, [0, 0, 101], cycle))).toThrow('Dependency cycle')
})

test('sums assigned runner time only for cancelled attempts, including jobs that finished before cancellation', () => {
  const jobs = [
    job(1, 'finished', ['arc-amd64'], [0, 30, 90]),
    { ...job(2, 'interrupted', ['arc-arm64'], [0, 60, 180]), conclusion: 'cancelled' },
    { ...job(3, 'never assigned', ['arc-arm64'], [0, 0, 180]), conclusion: 'cancelled', runner_id: null },
    { ...job(4, 'skipped', ['arc-arm64'], [0, 0, 180]), conclusion: 'skipped' },
    { ...job(5, 'untimed', ['arc-amd64'], [null, null, 180]), conclusion: 'cancelled' },
    job(6, 'no creation timestamp', ['arc-arm64'], [null, 120, 180]),
  ]
  const output = profile(
    { ...run(1, [0, 0, 181], jobs), conclusion: 'cancelled' },
    { ...run(1, [200, 205, 400], [job(7, 'success', ['arc-amd64'], [205, 210, 390])]), run_attempt: 2 },
    { ...run(2, [0, 0, 181]), conclusion: 'cancelled' },
    { ...run(3, [0, 0, 181], [job(8, 'failed workflow', ['arc-amd64'], [0, 0, 180])]), conclusion: 'failure' },
  )
  expect(output.workflows[0]).toMatchObject({
    attempts: 4,
    cancelledAttempts: 2,
    cancelledWithoutAssignedJobs: 1,
    untimedCancelledRunnerJobs: 1,
    wastedComputeMinutes: 4,
  })
  expect(output.runners.find(({ runner }) => runner === 'arc-arm64')).toMatchObject({
    jobs: 3,
    assignedJobs: 2,
    queueWaitMs: { samples: 1, p50: 60_000, p90: 60_000 },
    executionMs: { samples: 2, p50: 60_000, p90: 120_000 },
    wastedComputeMinutes: 3,
  })
  expect(output.attempts.find((attempt) => attempt.runId === 2)?.criticalPath).toBeNull()
  expect(() => profile(run(1, [0, 0, 10]), run(1, [0, 0, 10]))).toThrow('Duplicate run attempt 1/1')
})

test('rejects truncated or mismatched GitHub job pages rather than producing a partial report', () => {
  const jobs = [{ ...job(1, 'build', ['arc-arm64'], [0, 1, 2]), run_id: 5, run_attempt: 1 }]
  expect(() => parseJobPages([{ jobs, total_count: 2 }], 5, 1)).toThrow('Incomplete GitHub job list')
  expect(() => parseJobPages([{ jobs, total_count: 1 }], 5, 2)).toThrow(
    'GitHub returned jobs from outside run 5 attempt 2',
  )
})

const cli = fileURLToPath(new URL('../profile-ci-critical-path.ts', import.meta.url))
const execute = (path: string, ...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, cli, ...args], { env: { ...process.env, PATH: path } })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

test('runs entirely offline and renders byte-stable JSON and safe Markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-profile-fixture-'))
  try {
    const path = join(dir, 'fixture.json')
    const untrusted = 'test credential marker'
    const runs = [
      {
        ...run(1, [0, 1, 12], [job(11, 'compile | <em>check</em>', ['arc-arm64-tmpfs'], [1, 7, 11])]),
        display_title: untrusted,
      },
      run(2, [0, 1, 12], [job(12, `GITHUB_TOKEN=${untrusted}`, ['ubuntu-latest'], [1, 2, 10])]),
    ]
    writeFileSync(path, JSON.stringify({ runs }))
    const json = execute(dir, '--fixture', path, '--format', 'json')
    const markdown = execute(dir, '--fixture', path, '--format', 'markdown')
    expect(json).toMatchObject({ code: 0, stderr: '' })
    expect(markdown).toMatchObject({ code: 0, stderr: '' })
    expect(json.stdout).not.toContain(untrusted)
    expect(markdown.stdout).not.toContain(untrusted)
    expect(markdown.stdout).toContain('compile &#124; &#60;em&#62;check&#60;/em&#62;')
    expect(markdown.stdout).toContain('## Top bottlenecks by critical-path time')
    writeFileSync(path, JSON.stringify({ runs: runs.toReversed() }))
    expect(execute(dir, '--fixture', path, '--format', 'json')).toEqual(json)
    expect(execute(dir, '--fixture', path)).toEqual(markdown)

    writeFileSync(path, `{"runs":[${untrusted}]}`)
    expect(execute(dir, '--fixture', path)).toEqual({ code: 1, stdout: '', stderr: 'Invalid JSON from the fixture.\n' })
    expect(execute(dir, `--${untrusted}`).stderr).toBe('Invalid arguments. See --help for supported options.\n')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('live mode uses only GET requests, pages jobs, and keeps rerun attempt timings separate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-profile-gh-'))
  try {
    const original = { ...run(42, [0, 0, 61]), conclusion: 'cancelled' }
    const rerun = { ...run(42, [200, 201, 222]), run_attempt: 2 }
    const actions = 'repos/proompteng/lab/actions'
    const responses = {
      [`${actions}/workflows/build.yml/runs?status=completed&per_page=3&branch=main&event=push`]: {
        workflow_runs: [{ ...rerun, created_at: original.created_at }],
      },
      [`${actions}/runs/42/attempts/1`]: original,
      [`${actions}/runs/42/attempts/2`]: rerun,
      [`${actions}/runs/42/attempts/1/jobs?per_page=100`]: [
        { total_count: 2, jobs: [job(10, 'first', ['arc-amd64'], [0, 0, 60])] },
        { total_count: 2, jobs: [job(20, 'second', ['arc-arm64'], [0, 30, 60])] },
      ],
      [`${actions}/runs/42/attempts/2/jobs?per_page=100`]: [
        { total_count: 1, jobs: [job(30, 'retried', ['ubuntu-latest'], [201, 206, 221])] },
      ],
    }
    writeFileSync(
      join(dir, 'gh'),
      `#!${process.execPath}
const responses = ${JSON.stringify(responses)};
const args = Bun.argv.slice(2);
const endpoint = args.pop();
const expected = ['api', '--hostname', 'github.com', '--method', 'GET'];
if (endpoint.includes('/jobs?')) expected.push('--paginate', '--slurp');
if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(3);
if (!(endpoint in responses)) {
  console.error('test credential marker (HTTP 403)');
  process.exit(1);
}
console.log(JSON.stringify(responses[endpoint]));
`,
      { mode: 0o700 },
    )
    const result = execute(
      dir,
      '--workflow',
      'build.yml',
      '--branch',
      'main',
      '--event',
      'push',
      '--limit',
      '3',
      '--format',
      'json',
    )
    expect(result).toMatchObject({ code: 0, stderr: '' })
    const report: ProfileReport = JSON.parse(result.stdout)
    expect(report.attempts.map(({ wallMs, queueWaitMs, attempt }) => [attempt, wallMs, queueWaitMs])).toEqual([
      [2, 22_000, 1000],
      [1, 61_000, 0],
    ])
    expect(report.attempts[1]?.criticalPath?.jobs.map(({ jobId }) => jobId)).toEqual([10])
    expect(report.workflows[0]?.wastedComputeMinutes).toBe(1.5)
    expect(report.runners.map(({ runner }) => runner)).toEqual(['arc-arm64', 'ubuntu-latest', 'arc-amd64'])
    expect(execute(dir, '--workflow', 'unknown.yml')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Could not list completed workflow runs (HTTP 403). Check gh access and Actions read permission.\n',
    })
  } finally {
    rmSync(dir, { recursive: true })
  }
})
