import { isAbsolute, join } from 'node:path'

export interface WorkerLoadConfig {
  readonly workflowCount: number
  readonly workflowBatchSize: number
  readonly workflowConcurrencyTarget: number
  readonly activityConcurrencyTarget: number
  readonly throughputFloorPerSecond: number
  readonly stickyHitRatioTarget: number
  readonly workflowPollP95TargetMs: number
  readonly activityPollP95TargetMs: number
  readonly workflowDurationBudgetMs: number
  readonly metricsFlushTimeoutMs: number
  readonly computeIterations: number
  readonly cpuRounds: number
  readonly timerDelayMs: number
  readonly activityBurstsPerWorkflow: number
  readonly activityDelayMs: number
  readonly activityPayloadBytes: number
  readonly artifactsDir: string
  readonly metricsStreamPath: string
  readonly metricsReportPath: string
  readonly cliLogPath: string
  readonly workflowTaskQueuePrefix: string
  readonly metricEnv: Record<string, string>
}

const DEFAULT_WORKFLOW_COUNT = 36
const DEFAULT_WORKFLOW_CONCURRENCY = 10
const DEFAULT_ACTIVITY_CONCURRENCY = 14
const DEFAULT_ACTIVITY_DELAY_MS = 175
const DEFAULT_ACTIVITY_BURSTS = 4
const DEFAULT_ACTIVITY_PAYLOAD_BYTES = 2_048
const DEFAULT_COMPUTE_ITERATIONS = 160_000
const DEFAULT_CPU_ROUNDS = 5
const DEFAULT_TIMER_DELAY_MS = 60
const DEFAULT_THROUGHPUT_FLOOR = 2
const DEFAULT_STICKY_RATIO = 0.5
const DEFAULT_WORKFLOW_POLL_P95_MS = 5_000
const DEFAULT_ACTIVITY_POLL_P95_MS = 3_500
const DEFAULT_WORKFLOW_DEADLINE_MS = 100_000
const DEFAULT_METRICS_FLUSH_MS = 5_000
const DEFAULT_TASK_QUEUE_PREFIX = 'worker-load'

export const readWorkerLoadConfig = (): WorkerLoadConfig => {
  const workflowCount = readInt('TEMPORAL_LOAD_TEST_WORKFLOWS', DEFAULT_WORKFLOW_COUNT, { min: 1 })
  const workflowConcurrencyTarget = readInt(
    'TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY',
    Math.min(DEFAULT_WORKFLOW_CONCURRENCY, workflowCount),
    { min: 1 },
  )
  const activityConcurrencyTarget = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY',
    Math.max(DEFAULT_ACTIVITY_CONCURRENCY, workflowConcurrencyTarget),
    { min: 1 },
  )
  const throughputFloorPerSecond = readFloat(
    'TEMPORAL_LOAD_TEST_THROUGHPUT_PER_SEC',
    Math.max(DEFAULT_THROUGHPUT_FLOOR, Math.floor(workflowConcurrencyTarget / 3)),
    { min: 0.5 },
  )
  const stickyHitRatioTarget = readFloat('TEMPORAL_LOAD_TEST_STICKY_MIN_RATIO', DEFAULT_STICKY_RATIO, {
    min: 0,
    max: 1,
  })
  const workflowPollP95TargetMs = readInt(
    'TEMPORAL_LOAD_TEST_WORKFLOW_POLL_P95_MS',
    DEFAULT_WORKFLOW_POLL_P95_MS,
    { min: 10 },
  )
  const activityPollP95TargetMs = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_POLL_P95_MS',
    DEFAULT_ACTIVITY_POLL_P95_MS,
    { min: 10 },
  )
  const workflowDurationBudgetMs = readInt(
    'TEMPORAL_LOAD_TEST_TIMEOUT_MS',
    DEFAULT_WORKFLOW_DEADLINE_MS,
    { min: 10_000 },
  )
  const metricsFlushTimeoutMs = readInt(
    'TEMPORAL_LOAD_TEST_METRICS_FLUSH_MS',
    DEFAULT_METRICS_FLUSH_MS,
    { min: 500 },
  )
  const computeIterations = readInt(
    'TEMPORAL_LOAD_TEST_COMPUTE_ITERATIONS',
    DEFAULT_COMPUTE_ITERATIONS,
    { min: 1_000 },
  )
  const cpuRounds = readInt('TEMPORAL_LOAD_TEST_CPU_ROUNDS', DEFAULT_CPU_ROUNDS, { min: 1 })
  const timerDelayMs = readInt('TEMPORAL_LOAD_TEST_TIMER_DELAY_MS', DEFAULT_TIMER_DELAY_MS, { min: 10 })
  const activityBurstsPerWorkflow = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_BURSTS',
    DEFAULT_ACTIVITY_BURSTS,
    { min: 1 },
  )
  const activityDelayMs = readInt('TEMPORAL_LOAD_TEST_ACTIVITY_DELAY_MS', DEFAULT_ACTIVITY_DELAY_MS, { min: 25 })
  const activityPayloadBytes = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_PAYLOAD_BYTES',
    DEFAULT_ACTIVITY_PAYLOAD_BYTES,
    { min: 256 },
  )

  const artifactsDir = resolvePath(
    process.env.TEMPORAL_WORKER_LOAD_ARTIFACTS_DIR ?? process.env.TEMPORAL_ARTIFACTS_DIR,
    join(process.cwd(), '.artifacts', 'worker-load'),
  )
  const metricsStreamPath = resolvePath(
    process.env.TEMPORAL_LOAD_TEST_METRICS_PATH,
    join(artifactsDir, 'metrics.jsonl'),
  )
  const metricsReportPath = resolvePath(
    process.env.TEMPORAL_LOAD_TEST_REPORT_PATH,
    join(artifactsDir, 'report.json'),
  )
  const cliLogPath = resolvePath(
    process.env.TEMPORAL_LOAD_TEST_CLI_LOG_PATH,
    join(artifactsDir, 'temporal-cli.log'),
  )
  const workflowTaskQueuePrefix =
    process.env.TEMPORAL_LOAD_TEST_TASK_QUEUE_PREFIX?.trim() || DEFAULT_TASK_QUEUE_PREFIX

  return {
    workflowCount,
    workflowBatchSize: Math.max(workflowConcurrencyTarget, Math.min(workflowCount, workflowConcurrencyTarget * 2)),
    workflowConcurrencyTarget,
    activityConcurrencyTarget,
    throughputFloorPerSecond,
    stickyHitRatioTarget,
    workflowPollP95TargetMs,
    activityPollP95TargetMs,
    workflowDurationBudgetMs,
    metricsFlushTimeoutMs,
    computeIterations,
    cpuRounds,
    timerDelayMs,
    activityBurstsPerWorkflow,
    activityDelayMs,
    activityPayloadBytes,
    artifactsDir,
    metricsStreamPath,
    metricsReportPath,
    cliLogPath,
    workflowTaskQueuePrefix,
    metricEnv: {
      TEMPORAL_METRICS_EXPORTER: 'file',
      TEMPORAL_METRICS_ENDPOINT: metricsStreamPath,
    },
  }
}

const readInt = (name: string, fallback: number, options: { min?: number; max?: number } = {}): number => {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return clamp(fallback, options)
  }
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    return clamp(fallback, options)
  }
  return clamp(parsed, options)
}

const readFloat = (name: string, fallback: number, options: { min?: number; max?: number } = {}): number => {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return clamp(fallback, options)
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) {
    return clamp(fallback, options)
  }
  return clamp(parsed, options)
}

const clamp = (value: number, options: { min?: number; max?: number }): number => {
  const min = typeof options.min === 'number' ? options.min : undefined
  const max = typeof options.max === 'number' ? options.max : undefined
  if (typeof min === 'number' && value < min) {
    return min
  }
  if (typeof max === 'number' && value > max) {
    return max
  }
  return value
}

const resolvePath = (value: string | undefined, fallback: string): string => {
  if (!value) {
    return fallback
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return fallback
  }
  return isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed)
}
