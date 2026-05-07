#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const failureModes = [
  'baseline',
  'worker-restart',
  'sticky-cache-churn',
  'update-rejection-termination',
  'activity-cancellation',
] as const
type FailureMode = (typeof failureModes)[number]

const argv = parseArgs({
  options: {
    duration: { type: 'string' },
    iterations: { type: 'string' },
    workflows: { type: 'string' },
    'workflow-concurrency': { type: 'string' },
    'activity-concurrency': { type: 'string' },
    'failure-modes': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (argv.values.help) {
  console.log(`Usage: bun scripts/run-worker-soak.ts [options]

Options:
  --duration <ms>             Soak duration. Defaults to TEMPORAL_SOAK_DURATION_MS or 7200000.
  --iterations <n>            Minimum load iterations before exiting.
  --workflows <n>             Workflows per load iteration.
  --workflow-concurrency <n>  Workflow concurrency target.
  --activity-concurrency <n>  Activity concurrency target.
  --failure-modes <csv>       Failure modes to cycle: ${failureModes.join(', ')}.
  --help                      Show this help text.
`)
  process.exit(0)
}

const durationMs = Math.max(
  1_000,
  Number.parseInt(String(argv.values.duration ?? process.env.TEMPORAL_SOAK_DURATION_MS ?? '7200000'), 10),
)
const minimumIterations = Math.max(
  1,
  Number.parseInt(String(argv.values.iterations ?? process.env.TEMPORAL_SOAK_ITERATIONS ?? '1'), 10),
)
const startedAt = Date.now()
const deadline = startedAt + durationMs
const artifactsDir = process.env.TEMPORAL_SOAK_ARTIFACTS_DIR ?? join(process.cwd(), '.artifacts', 'worker-soak')
const requestedFailureModes = parseFailureModes(
  String(argv.values['failure-modes'] ?? process.env.TEMPORAL_SOAK_FAILURE_MODES ?? 'baseline'),
)
const iterations: SoakIteration[] = []
const memorySamplesPath = join(artifactsDir, 'memory.jsonl')

const applyOverride = (name: string, value: string | boolean | undefined) => {
  if (value !== undefined) {
    process.env[name] = String(value)
  }
}

applyOverride('TEMPORAL_LOAD_TEST_WORKFLOWS', argv.values.workflows)
applyOverride('TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY', argv.values['workflow-concurrency'])
applyOverride('TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY', argv.values['activity-concurrency'])

await mkdir(artifactsDir, { recursive: true })
const memoryRecorder = createMemoryRecorder(memorySamplesPath, startedAt)
await memoryRecorder.sample('start')

let iteration = 0
while (Date.now() < deadline || iteration < minimumIterations) {
  iteration += 1
  const iterationStartedAt = new Date().toISOString()
  const mode = requestedFailureModes[(iteration - 1) % requestedFailureModes.length] ?? 'baseline'
  const iterationDir = join(artifactsDir, `iteration-${iteration}`)
  await mkdir(iterationDir, { recursive: true })
  const modeEnv = failureModeEnvironment(mode, iteration)
  const memoryBefore = await memoryRecorder.sample('before-iteration', { iteration, mode })

  const child = Bun.spawn(['bun', 'scripts/run-worker-load.ts'], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      TEMPORAL_WORKER_LOAD_ARTIFACTS_DIR: iterationDir,
      ...modeEnv,
    },
  })
  const exitCode = await child.exited
  const completedAt = new Date().toISOString()
  const loadReportPath = join(iterationDir, 'report.json')
  const loadReport = await readOptionalJson<WorkerLoadReport>(loadReportPath)
  const memoryAfter = await memoryRecorder.sample('after-iteration', { iteration, mode, exitCode })
  iterations.push({
    iteration,
    mode,
    modeDescription: failureModeDescription(mode),
    startedAt: iterationStartedAt,
    completedAt,
    exitCode,
    loadReportPath,
    loadReportSummary: summarizeLoadReport(loadReport),
    memoryBefore,
    memoryAfter,
    memoryDelta: summarizeMemoryDelta(memoryBefore, memoryAfter),
  })
  if (exitCode !== 0) {
    process.exitCode = exitCode
    break
  }
}
await memoryRecorder.sample('end', { iterations: iteration })
await memoryRecorder.flush()
const memorySummary = summarizeMemorySamples(memoryRecorder.samples, Date.now() - startedAt)

const report = {
  generatedAt: new Date().toISOString(),
  durationMs,
  elapsedMs: Date.now() - startedAt,
  minimumIterations,
  requestedFailureModes,
  failureModeCoverage: buildFailureModeCoverage(iterations),
  failureModeEvidence: buildFailureModeEvidence(iterations),
  memorySamplesPath,
  memorySummary,
  environment: {
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  },
  passed: iterations.length > 0 && iterations.every((entry) => entry.exitCode === 0),
  iterations,
}

await writeFile(join(artifactsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`[worker-soak] report written to ${join(artifactsDir, 'report.json')}`)

type SoakIteration = {
  readonly iteration: number
  readonly mode: FailureMode
  readonly modeDescription: string
  readonly startedAt: string
  readonly completedAt: string
  readonly exitCode: number
  readonly loadReportPath: string
  readonly loadReportSummary: LoadReportSummary | null
  readonly memoryBefore: MemorySample
  readonly memoryAfter: MemorySample
  readonly memoryDelta: MemoryDelta
}

type WorkerLoadReport = {
  readonly config?: {
    readonly workflowCount?: number
    readonly workflowConcurrencyTarget?: number
    readonly activityConcurrencyTarget?: number
    readonly stickyCacheSize?: number
    readonly stickyTtlMs?: number
    readonly restartAfterSubmit?: boolean
    readonly restartDelayMs?: number
    readonly activityCancellationRatio?: number
    readonly activityCancellationDelayMs?: number
  }
  readonly stats?: {
    readonly submitted?: number
    readonly completed?: number
    readonly peakConcurrent?: number
    readonly durationMs?: number
  }
  readonly workflowStatusCounts?: Record<string, number>
  readonly metrics?: {
    readonly workflowThroughputPerSecond?: number
    readonly stickyHitRatio?: number
    readonly workflowPollLatency?: { readonly p95?: number }
    readonly activityPollLatency?: { readonly p95?: number }
  }
  readonly memory?: MemorySummary
  readonly scenarioCoverage?: Record<string, number>
  readonly failureInjection?: FailureInjectionReport
  readonly environment?: {
    readonly temporalCliVersion?: string
    readonly taskQueue?: string
  }
}

type LoadReportSummary = {
  readonly submitted: number
  readonly completed: number
  readonly peakConcurrent: number
  readonly workflowThroughputPerSecond: number
  readonly stickyHitRatio: number
  readonly workflowPollP95Ms: number
  readonly activityPollP95Ms: number
  readonly scenarioCoverage: Record<string, number>
  readonly workflowStatusCounts: Record<string, number>
  readonly memorySummary: MemorySummary | null
  readonly failureInjection: FailureInjectionReport | null
  readonly temporalCliVersion: string
  readonly taskQueue: string
}

type FailureInjectionReport = {
  readonly restartAfterSubmit?: boolean
  readonly runtimeRestartCount?: number
  readonly restartEvents?: readonly {
    readonly reason?: string
    readonly previousGeneration?: number
    readonly nextGeneration?: number
  }[]
  readonly activityCancellationRatio?: number
  readonly activityCancellationDelayMs?: number
  readonly activityCancellationAttemptCount?: number
  readonly activityCancellationSuccessCount?: number
  readonly activityCancellationFinalCanceledCount?: number
  readonly activityCancellationEvents?: readonly {
    readonly workflowId?: string
    readonly runId?: string
    readonly status?: string
  }[]
}

type MemorySample = {
  readonly timestamp: string
  readonly elapsedMs: number
  readonly phase: string
  readonly rssBytes: number
  readonly heapTotalBytes: number
  readonly heapUsedBytes: number
  readonly externalBytes: number
  readonly arrayBuffersBytes: number
  readonly context?: Record<string, string | number | boolean>
}

type MemoryDelta = {
  readonly elapsedMs: number
  readonly rssDeltaBytes: number
  readonly heapUsedDeltaBytes: number
}

type MemorySummary = {
  readonly sampleCount: number
  readonly startedAt: string
  readonly completedAt: string
  readonly elapsedMs: number
  readonly startRssBytes: number
  readonly endRssBytes: number
  readonly maxRssBytes: number
  readonly rssDeltaBytes: number
  readonly heapUsedDeltaBytes: number
  readonly rssSlopeBytesPerHour: number
  readonly rssSlopeMbPerHour: number
  readonly slopeLimitMbPerHour: number
  readonly slopeMinElapsedMs: number
  readonly slopeAssessment: 'passed' | 'failed' | 'insufficient-duration'
  readonly withinSlopeLimit: boolean
}

function parseFailureModes(raw: string): FailureMode[] {
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  const result: FailureMode[] = []
  for (const entry of parsed) {
    if (!failureModes.includes(entry as FailureMode)) {
      throw new Error(`Unsupported soak failure mode: ${entry}`)
    }
    result.push(entry as FailureMode)
  }
  return result.length > 0 ? result : ['baseline']
}

function failureModeEnvironment(mode: FailureMode, iteration: number): Record<string, string> {
  const prefix = `worker-soak-${mode}-${iteration}`
  if (mode === 'sticky-cache-churn') {
    return {
      TEMPORAL_LOAD_TEST_TASK_QUEUE_PREFIX: prefix,
      TEMPORAL_LOAD_TEST_STICKY_CACHE_SIZE: '1',
      TEMPORAL_LOAD_TEST_STICKY_MIN_RATIO: '0',
    }
  }
  if (mode === 'worker-restart') {
    return {
      TEMPORAL_LOAD_TEST_TASK_QUEUE_PREFIX: prefix,
      TEMPORAL_LOAD_TEST_RESTART_AFTER_SUBMIT: '1',
      TEMPORAL_LOAD_TEST_RESTART_DELAY_MS: '250',
      TEMPORAL_LOAD_TEST_STICKY_TTL_MS: '1000',
    }
  }
  if (mode === 'update-rejection-termination') {
    return {
      TEMPORAL_LOAD_TEST_TASK_QUEUE_PREFIX: prefix,
      TEMPORAL_LOAD_TEST_UPDATE_RATIO: '0.5',
      TEMPORAL_LOAD_TEST_UPDATES_PER_WORKFLOW: '1',
      TEMPORAL_LOAD_TEST_UPDATE_DELAY_MS: '25',
    }
  }
  if (mode === 'activity-cancellation') {
    return {
      TEMPORAL_LOAD_TEST_TASK_QUEUE_PREFIX: prefix,
      TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_RATIO: '1',
      TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_DELAY_MS: '100',
      TEMPORAL_LOAD_TEST_ACTIVITY_DELAY_MS: '750',
      TEMPORAL_LOAD_TEST_ACTIVITY_BURSTS: '3',
      TEMPORAL_LOAD_TEST_UPDATE_RATIO: '0',
    }
  }
  return {
    TEMPORAL_LOAD_TEST_TASK_QUEUE_PREFIX: prefix,
  }
}

function failureModeDescription(mode: FailureMode): string {
  if (mode === 'worker-restart') {
    return 'restart the worker runtime after workflow submission and verify the restarted worker drains the queue'
  }
  if (mode === 'sticky-cache-churn') {
    return 'force a tiny sticky cache and relaxed sticky ratio target to exercise cache churn'
  }
  if (mode === 'update-rejection-termination') {
    return 'increase update workflows to exercise accepted, rejected, delayed, and termination paths'
  }
  if (mode === 'activity-cancellation') {
    return 'cancel activity-heavy workflows while heartbeat activities are running and verify cancellation drains'
  }
  return 'normal worker-load iteration'
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

function summarizeLoadReport(report: WorkerLoadReport | null): LoadReportSummary | null {
  if (!report) {
    return null
  }
  return {
    submitted: report.stats?.submitted ?? 0,
    completed: report.stats?.completed ?? 0,
    peakConcurrent: report.stats?.peakConcurrent ?? 0,
    workflowThroughputPerSecond: report.metrics?.workflowThroughputPerSecond ?? 0,
    stickyHitRatio: report.metrics?.stickyHitRatio ?? 0,
    workflowPollP95Ms: report.metrics?.workflowPollLatency?.p95 ?? 0,
    activityPollP95Ms: report.metrics?.activityPollLatency?.p95 ?? 0,
    scenarioCoverage: report.scenarioCoverage ?? {},
    workflowStatusCounts: report.workflowStatusCounts ?? {},
    memorySummary: report.memory ?? null,
    failureInjection: report.failureInjection ?? null,
    temporalCliVersion: report.environment?.temporalCliVersion ?? 'unknown',
    taskQueue: report.environment?.taskQueue ?? 'unknown',
  }
}

function buildFailureModeCoverage(entries: readonly SoakIteration[]): Record<FailureMode, number> {
  const coverage = Object.fromEntries(failureModes.map((mode) => [mode, 0])) as Record<FailureMode, number>
  for (const entry of entries) {
    if (entry.exitCode === 0) {
      coverage[entry.mode] += 1
    }
  }
  return coverage
}

function buildFailureModeEvidence(entries: readonly SoakIteration[]): Record<FailureMode, Record<string, number>> {
  const evidence = Object.fromEntries(failureModes.map((mode) => [mode, {}])) as Record<
    FailureMode,
    Record<string, number>
  >

  for (const entry of entries) {
    if (entry.exitCode !== 0 || !entry.loadReportSummary) {
      continue
    }
    const modeEvidence = evidence[entry.mode]
    modeEvidence.iterations = (modeEvidence.iterations ?? 0) + 1
    modeEvidence.completedWorkflows = (modeEvidence.completedWorkflows ?? 0) + entry.loadReportSummary.completed
    modeEvidence.memorySamples =
      (modeEvidence.memorySamples ?? 0) + (entry.loadReportSummary.memorySummary?.sampleCount ?? 0)

    if (entry.mode === 'worker-restart') {
      modeEvidence.runtimeRestarts =
        (modeEvidence.runtimeRestarts ?? 0) + (entry.loadReportSummary.failureInjection?.runtimeRestartCount ?? 0)
      modeEvidence.restartAfterSubmitIterations =
        (modeEvidence.restartAfterSubmitIterations ?? 0) +
        (entry.loadReportSummary.failureInjection?.restartAfterSubmit ? 1 : 0)
    }

    if (entry.mode === 'sticky-cache-churn') {
      modeEvidence.stickyCacheChurnIterations = (modeEvidence.stickyCacheChurnIterations ?? 0) + 1
      modeEvidence.minimumStickyHitRatio =
        typeof modeEvidence.minimumStickyHitRatio === 'number'
          ? Math.min(modeEvidence.minimumStickyHitRatio, entry.loadReportSummary.stickyHitRatio)
          : entry.loadReportSummary.stickyHitRatio
    }

    if (entry.mode === 'update-rejection-termination') {
      modeEvidence.updateWorkflowIterations = (modeEvidence.updateWorkflowIterations ?? 0) + 1
      modeEvidence.updateWorkflows =
        (modeEvidence.updateWorkflows ?? 0) + (entry.loadReportSummary.scenarioCoverage.workerLoadUpdateWorkflow ?? 0)
    }

    if (entry.mode === 'activity-cancellation') {
      modeEvidence.activityCancellationIterations = (modeEvidence.activityCancellationIterations ?? 0) + 1
      modeEvidence.activityCancellationAttempts =
        (modeEvidence.activityCancellationAttempts ?? 0) +
        (entry.loadReportSummary.failureInjection?.activityCancellationAttemptCount ?? 0)
      modeEvidence.activityCancellationSuccesses =
        (modeEvidence.activityCancellationSuccesses ?? 0) +
        (entry.loadReportSummary.failureInjection?.activityCancellationSuccessCount ?? 0)
      modeEvidence.activityCancellationFinalCanceled =
        (modeEvidence.activityCancellationFinalCanceled ?? 0) +
        (entry.loadReportSummary.failureInjection?.activityCancellationFinalCanceledCount ?? 0)
    }
  }

  return evidence
}

type MemoryRecorder = {
  readonly samples: MemorySample[]
  sample: (phase: string, context?: Record<string, string | number | boolean>) => Promise<MemorySample>
  flush: () => Promise<void>
}

function createMemoryRecorder(path: string, startedAt: number): MemoryRecorder {
  const samples: MemorySample[] = []
  let pendingWrite = Promise.resolve()

  return {
    samples,
    sample: async (phase, context) => {
      const usage = process.memoryUsage()
      const sample: MemorySample = {
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        phase,
        rssBytes: usage.rss,
        heapTotalBytes: usage.heapTotal,
        heapUsedBytes: usage.heapUsed,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
        ...(context ? { context } : {}),
      }
      samples.push(sample)
      pendingWrite = pendingWrite.then(() => appendFile(path, `${JSON.stringify(sample)}\n`, 'utf8'))
      await pendingWrite
      return sample
    },
    flush: () => pendingWrite,
  }
}

function summarizeMemoryDelta(before: MemorySample, after: MemorySample): MemoryDelta {
  return {
    elapsedMs: Math.max(1, after.elapsedMs - before.elapsedMs),
    rssDeltaBytes: after.rssBytes - before.rssBytes,
    heapUsedDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
  }
}

function summarizeMemorySamples(samples: readonly MemorySample[], fallbackElapsedMs: number): MemorySummary {
  const first = samples[0]
  const last = samples.at(-1)
  const slopeLimitMbPerHour = readMemorySlopeLimitMbPerHour()
  const slopeMinElapsedMs = readMemorySlopeMinElapsedMs()
  if (!first || !last) {
    return {
      sampleCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      elapsedMs: fallbackElapsedMs,
      startRssBytes: 0,
      endRssBytes: 0,
      maxRssBytes: 0,
      rssDeltaBytes: 0,
      heapUsedDeltaBytes: 0,
      rssSlopeBytesPerHour: 0,
      rssSlopeMbPerHour: 0,
      slopeLimitMbPerHour,
      slopeMinElapsedMs,
      slopeAssessment: 'insufficient-duration',
      withinSlopeLimit: true,
    }
  }

  const elapsedMs = Math.max(1, last.elapsedMs - first.elapsedMs, fallbackElapsedMs)
  const rssDeltaBytes = last.rssBytes - first.rssBytes
  const rssSlopeBytesPerHour = rssDeltaBytes * (3_600_000 / elapsedMs)
  const rssSlopeMbPerHour = rssSlopeBytesPerHour / (1024 * 1024)
  const slopeAssessment =
    elapsedMs < slopeMinElapsedMs
      ? 'insufficient-duration'
      : rssSlopeMbPerHour <= slopeLimitMbPerHour
        ? 'passed'
        : 'failed'

  return {
    sampleCount: samples.length,
    startedAt: first.timestamp,
    completedAt: last.timestamp,
    elapsedMs,
    startRssBytes: first.rssBytes,
    endRssBytes: last.rssBytes,
    maxRssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
    rssDeltaBytes,
    heapUsedDeltaBytes: last.heapUsedBytes - first.heapUsedBytes,
    rssSlopeBytesPerHour,
    rssSlopeMbPerHour,
    slopeLimitMbPerHour,
    slopeMinElapsedMs,
    slopeAssessment,
    withinSlopeLimit: slopeAssessment !== 'failed',
  }
}

function readMemorySlopeLimitMbPerHour(): number {
  const parsed = Number.parseFloat(process.env.TEMPORAL_SOAK_MEMORY_SLOPE_MAX_MB_PER_HOUR ?? '128')
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 128
}

function readMemorySlopeMinElapsedMs(): number {
  const parsed = Number.parseInt(process.env.TEMPORAL_SOAK_MEMORY_SLOPE_MIN_MS ?? '600000', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000
}
