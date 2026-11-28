import { z } from 'zod'

export class ProfileError extends Error {}

const id = z.int().positive()
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => Date.parse(value))
  .nullish()
  .transform((value) => value ?? null)

const status = z.enum(['completed', 'in_progress', 'pending', 'queued', 'requested', 'waiting'])
const conclusion = z
  .enum([
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
    'success',
    'timed_out',
  ])
  .nullable()
const displayName = z
  .string()
  .min(1)
  .transform((value) => {
    const name = value.replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim()
    // Names can contain expressions resolved from PR or matrix data. Never emit URLs or token-like names.
    if (
      /[a-z][a-z\d+.-]*:\/\/|\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA|ASIA)\w|(?:^|[^a-z\d])(?:password|token|secret|api[_-]?key)\s*[:=]/i.test(
        name,
      )
    ) {
      return '[redacted]'
    }
    return name || '[unnamed]'
  })

const runSchema = z.object({
  id,
  workflow_id: id,
  name: displayName,
  run_attempt: id,
  status,
  conclusion,
  created_at: timestamp,
  run_started_at: timestamp,
  completed_at: timestamp,
  updated_at: timestamp,
})

const jobSchema = z.object({
  id,
  run_id: id.optional(),
  run_attempt: id.optional(),
  name: displayName,
  status,
  conclusion,
  labels: z.array(displayName),
  runner_id: z.int().nonnegative().nullable(),
  created_at: timestamp,
  started_at: timestamp,
  completed_at: timestamp,
  needs: z.array(id).optional(),
})

const fixtureSchema = z.object({ runs: z.array(runSchema.extend({ jobs: z.array(jobSchema) })) })
const runListSchema = z.object({ workflow_runs: z.array(runSchema) })
const jobPagesSchema = z.array(z.object({ total_count: z.int().nonnegative(), jobs: z.array(jobSchema) })).min(1)

export type WorkflowAttempt = z.output<typeof fixtureSchema>['runs'][number]
type Job = z.output<typeof jobSchema>

const parse = <T extends z.ZodType>(schema: T, input: unknown, source: string): z.output<T> => {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const field = result.error.issues[0]?.path.join('.')
  throw new ProfileError(`Invalid ${source}${field ? ` at ${field}` : ''}.`)
}

export const parseFixture = (input: unknown) => parse(fixtureSchema, input, 'fixture').runs
export const parseRunList = (input: unknown) => parse(runListSchema, input, 'GitHub run list').workflow_runs
export const parseRun = (input: unknown, runId: number, attempt: number) => {
  const run = parse(runSchema, input, 'GitHub run attempt')
  if (run.id !== runId || run.run_attempt !== attempt || run.status !== 'completed') {
    throw new ProfileError(`GitHub did not return completed run ${runId} attempt ${attempt}.`)
  }
  return run
}

export const parseJobPages = (input: unknown, runId: number, attempt: number) => {
  const pages = parse(jobPagesSchema, input, 'GitHub job pages')
  const jobs = pages.flatMap((page) => page.jobs)
  if (pages.some((page) => page.total_count !== jobs.length)) {
    throw new ProfileError(`Incomplete GitHub job list for run ${runId} attempt ${attempt}.`)
  }
  if (jobs.some((job) => (job.run_id ?? runId) !== runId || (job.run_attempt ?? attempt) !== attempt)) {
    throw new ProfileError(`GitHub returned jobs from outside run ${runId} attempt ${attempt}.`)
  }
  return jobs
}

const elapsed = (start: number | null, end: number | null) =>
  start !== null && end !== null && end >= start ? end - start : null

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

const distribution = (samples: (number | null)[]) => {
  const sorted = samples.filter((sample) => sample !== null).sort((a, b) => a - b)
  const percentile = (q: number) => sorted[Math.ceil(sorted.length * q) - 1] ?? null
  return { samples: sorted.length, p50: percentile(0.5), p90: percentile(0.9) }
}

const runnerPool = (labels: string[]) => {
  const normalized = [...new Set(labels.map((label) => label.toLowerCase()))].sort(compareText)
  const arc = normalized.filter((label) => label.startsWith('arc-'))
  return (arc.length === 1 ? arc[0] : normalized.join(' + ')) || 'unlabeled'
}

const measureJob = (job: Job) => {
  // GitHub can populate both timestamps for cancelled jobs that never received a runner.
  const assigned = Boolean(job.runner_id)
  const queueWaitMs = assigned ? elapsed(job.created_at, job.started_at) : null
  const executionMs = assigned && job.status === 'completed' ? elapsed(job.started_at, job.completed_at) : null
  return {
    id: job.id,
    name: job.name,
    runner: runnerPool(job.labels),
    assigned,
    queueWaitMs,
    executionMs,
    start: job.started_at,
    end: job.completed_at,
    needs: job.needs,
  }
}

type JobTiming = ReturnType<typeof measureJob>
type Window = { job: JobTiming; ready: number; start: number; end: number; executionMs: number }
type Path = { window: Window; previous?: Path; queueWaitMs: number | null; durationMs: number }

const extend = (window: Window, previous?: Path, eligible = window.ready): Path => {
  const queueWaitMs = window.job.queueWaitMs === null ? null : window.start - eligible
  return {
    window,
    previous,
    queueWaitMs,
    durationMs: (previous?.durationMs ?? 0) + (queueWaitMs ?? 0) + window.executionMs,
  }
}

const heavier = (candidate: Path, best?: Path) =>
  !best ||
  candidate.durationMs > best.durationMs ||
  (candidate.durationMs === best.durationMs && candidate.window.job.id < best.window.job.id)
    ? candidate
    : best

const observedPath = (windows: Window[]) => {
  // Weighted interval scheduling: a predecessor must finish before this job's queue can begin.
  const ordered = windows.sort((a, b) => a.end - b.end || a.ready - b.ready || a.job.id - b.job.id)
  const prefixBest: Path[] = []
  let terminal: Path | undefined
  for (const [index, window] of ordered.entries()) {
    let lower = 0
    let upper = index
    while (lower < upper) {
      const mid = Math.floor((lower + upper) / 2)
      if (ordered[mid]!.end <= window.ready) lower = mid + 1
      else upper = mid
    }
    const path = extend(window, prefixBest[lower - 1])
    prefixBest.push(heavier(path, prefixBest[index - 1]))
    if (window.end === ordered.at(-1)?.end) terminal = heavier(path, terminal)
  }
  return terminal
}

const dependencyPath = (windows: Window[], runId: number) => {
  const byId = new Map(windows.map((window) => [window.job.id, window]))
  const paths = new Map<number, Path>()
  const visiting = new Set<number>()
  const visit = (window: Window): Path => {
    const { id, needs } = window.job
    const existing = paths.get(id)
    if (existing) return existing
    if (visiting.has(id)) throw new ProfileError(`Dependency cycle in run ${runId} at job ${id}.`)
    if (!needs) throw new ProfileError(`Missing needs array in run ${runId} for measured job ${id}.`)
    visiting.add(id)
    let previous: Path | undefined
    let eligible = window.ready
    for (const dependency of needs) {
      const parent = byId.get(dependency)
      if (!parent) throw new ProfileError(`Unmeasured dependency ${dependency} in run ${runId} for job ${id}.`)
      if (parent.end > window.start) throw new ProfileError(`Job ${id} started before its dependency in run ${runId}.`)
      eligible = Math.max(eligible, parent.end)
      previous = heavier(visit(parent), previous)
    }
    visiting.delete(id)
    const path = extend(window, previous, eligible)
    paths.set(id, path)
    return path
  }

  let best: Path | undefined
  for (const window of windows) best = heavier(visit(window), best)
  return best
}

const criticalPath = (jobs: JobTiming[], runId: number) => {
  const windows = jobs.flatMap((job): Window[] => {
    if (job.start === null || job.end === null || job.executionMs === null) return []
    return [
      { job, ready: job.start - (job.queueWaitMs ?? 0), start: job.start, end: job.end, executionMs: job.executionMs },
    ]
  })
  const method = jobs.some((job) => job.needs !== undefined) ? 'dependencies' : 'observed'
  const path = method === 'dependencies' ? dependencyPath(windows, runId) : observedPath(windows)
  if (!path) return null
  const chain = []
  for (let node: Path | undefined = path; node; node = node.previous) {
    const { job, executionMs } = node.window
    chain.push({
      jobId: job.id,
      name: job.name,
      runner: job.runner,
      queueWaitMs: node.queueWaitMs,
      executionMs,
      wallMs: (node.queueWaitMs ?? 0) + executionMs,
    })
  }
  return { method, durationMs: path.durationMs, jobs: chain.reverse() }
}

const computeMinutes = (ms: number) => ms / 60_000

const groupBy = <T, K>(items: T[], key: (item: T) => K) => {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const group = key(item)
    const members = groups.get(group)
    if (members) members.push(item)
    else groups.set(group, [item])
  }
  return groups
}

export const profileAttempts = (input: WorkflowAttempt[]) => {
  const seen = new Set<string>()
  const attempts = input
    .filter((run) => run.status === 'completed')
    .sort(
      (a, b) =>
        a.workflow_id - b.workflow_id ||
        (b.created_at ?? 0) - (a.created_at ?? 0) ||
        b.id - a.id ||
        b.run_attempt - a.run_attempt,
    )
    .map((run) => {
      const key = `${run.id}/${run.run_attempt}`
      if (seen.has(key)) throw new ProfileError(`Duplicate run attempt ${key}.`)
      seen.add(key)
      if (new Set(run.jobs.map((job) => job.id)).size !== run.jobs.length) {
        throw new ProfileError(`Duplicate job ID in run attempt ${key}.`)
      }
      const jobs = run.jobs.filter((job) => job.conclusion !== 'skipped').map(measureJob)
      const cancelled = run.conclusion === 'cancelled'
      const completion = run.completed_at ?? run.updated_at
      const completionSource =
        run.completed_at !== null ? 'completed_at' : run.updated_at !== null ? 'updated_at' : null
      const executionMs = elapsed(run.run_started_at, completion)
      const path = criticalPath(jobs, run.id)
      return {
        jobs,
        cancelled,
        report: {
          runId: run.id,
          attempt: run.run_attempt,
          workflowId: run.workflow_id,
          workflow: run.name,
          conclusion: run.conclusion,
          completionSource,
          wallMs: elapsed(run.created_at, completion),
          queueWaitMs: elapsed(run.created_at, run.run_started_at),
          executionMs,
          criticalPath: path,
          wastedComputeMinutes: cancelled
            ? computeMinutes(jobs.reduce((sum, job) => sum + (job.executionMs ?? 0), 0))
            : 0,
        },
      }
    })

  const workflows = [...groupBy(attempts, ({ report }) => report.workflowId)].map(([workflowId, runs]) => {
    const cancelled = runs.filter((run) => run.cancelled)
    const cancelledJobs = cancelled.flatMap((run) => run.jobs)
    return {
      workflowId,
      workflow: runs[0]!.report.workflow,
      attempts: runs.length,
      wallMs: distribution(runs.map(({ report }) => report.wallMs)),
      queueWaitMs: distribution(runs.map(({ report }) => report.queueWaitMs)),
      executionMs: distribution(runs.map(({ report }) => report.executionMs)),
      criticalPathMs: distribution(runs.map(({ report }) => report.criticalPath?.durationMs ?? null)),
      cancelledAttempts: cancelled.length,
      cancelledWithoutAssignedJobs: cancelled.filter(({ jobs }) => !jobs.some((job) => job.assigned)).length,
      untimedCancelledRunnerJobs: cancelledJobs.filter((job) => job.assigned && job.executionMs === null).length,
      wastedComputeMinutes: computeMinutes(cancelledJobs.reduce((sum, job) => sum + (job.executionMs ?? 0), 0)),
    }
  })

  const jobsByRunner = groupBy(
    attempts.flatMap(({ jobs, cancelled }) => jobs.map((job) => ({ ...job, cancelled }))),
    (job) => job.runner,
  )
  const runners = [...jobsByRunner].map(([runner, jobs]) => ({
    runner,
    jobs: jobs.length,
    assignedJobs: jobs.filter((job) => job.assigned).length,
    queueWaitMs: distribution(jobs.map((job) => job.queueWaitMs)),
    executionMs: distribution(jobs.map((job) => job.executionMs)),
    wastedComputeMinutes: computeMinutes(
      jobs.reduce((sum, job) => sum + (job.cancelled ? (job.executionMs ?? 0) : 0), 0),
    ),
  }))
  runners.sort((a, b) => (b.queueWaitMs.p90 ?? -1) - (a.queueWaitMs.p90 ?? -1) || compareText(a.runner, b.runner))

  const bottlenecks = new Map<
    string,
    {
      workflowId: number
      workflow: string
      job: string
      runner: string
      hits: number
      queueWaitMs: number
      executionMs: number
      wallMs: number
    }
  >()
  const workflowNames = new Map(workflows.map(({ workflowId, workflow }) => [workflowId, workflow]))
  for (const { report } of attempts) {
    for (const job of report.criticalPath?.jobs ?? []) {
      if (job.wallMs === 0) continue
      const { workflowId } = report
      const key = JSON.stringify([workflowId, job.name, job.runner])
      const row = bottlenecks.get(key) ?? {
        workflowId,
        workflow: workflowNames.get(workflowId) ?? report.workflow,
        job: job.name,
        runner: job.runner,
        hits: 0,
        queueWaitMs: 0,
        executionMs: 0,
        wallMs: 0,
      }
      row.hits++
      row.queueWaitMs += job.queueWaitMs ?? 0
      row.executionMs += job.executionMs
      row.wallMs += job.wallMs
      bottlenecks.set(key, row)
    }
  }

  return {
    workflows,
    runners,
    bottlenecks: [...bottlenecks.values()]
      .sort(
        (a, b) =>
          b.wallMs - a.wallMs ||
          a.workflowId - b.workflowId ||
          compareText(a.job, b.job) ||
          compareText(a.runner, b.runner),
      )
      .slice(0, 10),
    attempts: attempts.map(({ report }) => report),
  }
}

export type ProfileReport = ReturnType<typeof profileAttempts>
