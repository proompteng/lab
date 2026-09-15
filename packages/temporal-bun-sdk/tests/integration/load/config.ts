import { isAbsolute, join } from 'node:path'

export interface WorkerLoadConfig {
  readonly workflowCount: number
  readonly workflowBatchSize: number
  readonly workflowConcurrencyTarget: number
  readonly activityConcurrencyTarget: number
  readonly updateWorkflowRatio: number
  readonly updatesPerWorkflow: number
  readonly updateDelayMs: number
  readonly throughputFloorPerSecond: number
  readonly stickyHitRatioTarget: number
  readonly stickyCacheSize: number
  readonly stickyTtlMs: number
  readonly restartAfterSubmit: boolean
  readonly restartDelayMs: number
  readonly activityCancellationRatio: number
  readonly activityCancellationDelayMs: number
  readonly workflowPollP95TargetMs: number
  readonly activityPollP95TargetMs: number
  readonly workflowDurationBudgetMs: number
  readonly workflowDescribeConcurrency: number
  readonly metricsFlushTimeoutMs: number
  readonly computeIterations: number
  readonly cpuRounds: number
  readonly timerDelayMs: number
  readonly activityBurstsPerWorkflow: number
  readonly activityDelayMs: number
  readonly activityPayloadBytes: number
  readonly activityHeartbeatTimeoutMs: number
  readonly activityStartToCloseTimeoutMs: number
  readonly activityScheduleToStartTimeoutMs: number
  readonly activityScheduleToCloseTimeoutMs: number
  readonly memorySampleIntervalMs: number
  readonly memorySlopeMaxMbPerHour: number
  readonly memorySlopeMinElapsedMs: number
  readonly artifactsDir: string
  readonly metricsStreamPath: string
  readonly memoryStreamPath: string
  readonly metricsReportPath: string
  readonly cliLogPath: string
  readonly workflowTaskQueuePrefix: string
  readonly metricEnv: Record<string, string>
}

const DEFAULT_WORKFLOW_COUNT = 64
const DEFAULT_WORKFLOW_CONCURRENCY = 10
const DEFAULT_ACTIVITY_CONCURRENCY = 14
const DEFAULT_ACTIVITY_DELAY_MS = 175
const DEFAULT_ACTIVITY_BURSTS = 4
const DEFAULT_ACTIVITY_PAYLOAD_BYTES = 2_048
const DEFAULT_ACTIVITY_HEARTBEAT_TIMEOUT_MS = 30_000
const DEFAULT_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS = 60_000
const DEFAULT_ACTIVITY_SCHEDULE_TO_START_TIMEOUT_MS = 90_000
const DEFAULT_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT_MS = 150_000
const DEFAULT_COMPUTE_ITERATIONS = 160_000
const DEFAULT_CPU_ROUNDS = 5
const DEFAULT_TIMER_DELAY_MS = 60
const DEFAULT_UPDATE_WORKFLOW_RATIO = 0.2
const DEFAULT_UPDATES_PER_WORKFLOW = 3
const DEFAULT_UPDATE_DELAY_MS = 500
const DEFAULT_THROUGHPUT_FLOOR = 2
const DEFAULT_STICKY_RATIO = 0.5
const DEFAULT_STICKY_TTL_MS = 5 * 60_000
const DEFAULT_RESTART_AFTER_SUBMIT = false
const DEFAULT_RESTART_DELAY_MS = 500
const DEFAULT_ACTIVITY_CANCELLATION_RATIO = 0
const DEFAULT_ACTIVITY_CANCELLATION_DELAY_MS = 250
const DEFAULT_WORKFLOW_POLL_P95_MS = 6_000
const DEFAULT_ACTIVITY_POLL_P95_MS = 6_000
const DEFAULT_WORKFLOW_DEADLINE_MS = 100_000
const DEFAULT_WORKFLOW_DEADLINE_PER_CONCURRENCY_SLOT_MS = 15_000
const DEFAULT_WORKFLOW_DESCRIBE_CONCURRENCY = 16
const DEFAULT_METRICS_FLUSH_MS = 5_000
const DEFAULT_MEMORY_SAMPLE_INTERVAL_MS = 5_000
const DEFAULT_MEMORY_SLOPE_MAX_MB_PER_HOUR = 128
const DEFAULT_MEMORY_SLOPE_MIN_ELAPSED_MS = 600_000
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
  const stickyCacheSize = readInt(
    'TEMPORAL_LOAD_TEST_STICKY_CACHE_SIZE',
    Math.max(workflowConcurrencyTarget * 8, 64),
    { min: 1 },
  )
  const stickyTtlMs = readInt(
    'TEMPORAL_LOAD_TEST_STICKY_TTL_MS',
    readInt('TEMPORAL_STICKY_TTL_MS', DEFAULT_STICKY_TTL_MS, { min: 0 }),
    { min: 0 },
  )
  const restartAfterSubmit = readBoolean('TEMPORAL_LOAD_TEST_RESTART_AFTER_SUBMIT', DEFAULT_RESTART_AFTER_SUBMIT)
  const restartDelayMs = readInt('TEMPORAL_LOAD_TEST_RESTART_DELAY_MS', DEFAULT_RESTART_DELAY_MS, { min: 0 })
  const activityCancellationRatio = readFloat(
    'TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_RATIO',
    DEFAULT_ACTIVITY_CANCELLATION_RATIO,
    { min: 0, max: 1 },
  )
  const activityCancellationDelayMs = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_DELAY_MS',
    DEFAULT_ACTIVITY_CANCELLATION_DELAY_MS,
    { min: 0 },
  )
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
    defaultWorkflowDurationBudgetMs(workflowCount, workflowConcurrencyTarget),
    { min: 10_000 },
  )
  const workflowDescribeConcurrency = readInt(
    'TEMPORAL_LOAD_TEST_DESCRIBE_CONCURRENCY',
    Math.min(32, Math.max(DEFAULT_WORKFLOW_DESCRIBE_CONCURRENCY, workflowConcurrencyTarget)),
    { min: 1, max: 128 },
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
  const activityHeartbeatTimeoutMs = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_HEARTBEAT_TIMEOUT_MS',
    Math.max(DEFAULT_ACTIVITY_HEARTBEAT_TIMEOUT_MS, activityDelayMs * 8),
    { min: 1_000 },
  )
  const activityStartToCloseTimeoutMs = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS',
    Math.max(DEFAULT_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS, activityHeartbeatTimeoutMs, activityDelayMs * 30),
    { min: activityHeartbeatTimeoutMs },
  )
  const activityScheduleToStartTimeoutMs = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_START_TIMEOUT_MS',
    DEFAULT_ACTIVITY_SCHEDULE_TO_START_TIMEOUT_MS,
    { min: 1_000 },
  )
  const activityScheduleToCloseTimeoutMs = readInt(
    'TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT_MS',
    Math.max(
      DEFAULT_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT_MS,
      activityScheduleToStartTimeoutMs + activityStartToCloseTimeoutMs,
    ),
    { min: activityScheduleToStartTimeoutMs + activityStartToCloseTimeoutMs },
  )
  const updateWorkflowRatio = readFloat(
    'TEMPORAL_LOAD_TEST_UPDATE_RATIO',
    DEFAULT_UPDATE_WORKFLOW_RATIO,
    { min: 0, max: 1 },
  )
  const updatesPerWorkflow = readInt(
    'TEMPORAL_LOAD_TEST_UPDATES_PER_WORKFLOW',
    DEFAULT_UPDATES_PER_WORKFLOW,
    { min: 1 },
  )
  const updateDelayMs = readInt('TEMPORAL_LOAD_TEST_UPDATE_DELAY_MS', DEFAULT_UPDATE_DELAY_MS, { min: 25 })
  const memorySampleIntervalMs = readInt(
    'TEMPORAL_LOAD_TEST_MEMORY_SAMPLE_INTERVAL_MS',
    DEFAULT_MEMORY_SAMPLE_INTERVAL_MS,
    { min: 100 },
  )
  const memorySlopeMaxMbPerHour = readFloat(
    'TEMPORAL_LOAD_TEST_MEMORY_SLOPE_MAX_MB_PER_HOUR',
    DEFAULT_MEMORY_SLOPE_MAX_MB_PER_HOUR,
    { min: 0 },
  )
  const memorySlopeMinElapsedMs = readInt(
    'TEMPORAL_LOAD_TEST_MEMORY_SLOPE_MIN_MS',
    DEFAULT_MEMORY_SLOPE_MIN_ELAPSED_MS,
    { min: 1_000 },
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
  const memoryStreamPath = resolvePath(
    process.env.TEMPORAL_LOAD_TEST_MEMORY_PATH,
    join(artifactsDir, 'memory.jsonl'),
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
    updateWorkflowRatio,
    updatesPerWorkflow,
    updateDelayMs,
    throughputFloorPerSecond,
    stickyHitRatioTarget,
    stickyCacheSize,
    stickyTtlMs,
    restartAfterSubmit,
    restartDelayMs,
    activityCancellationRatio,
    activityCancellationDelayMs,
    workflowPollP95TargetMs,
    activityPollP95TargetMs,
    workflowDurationBudgetMs,
    workflowDescribeConcurrency,
    metricsFlushTimeoutMs,
    computeIterations,
    cpuRounds,
    timerDelayMs,
    activityBurstsPerWorkflow,
    activityDelayMs,
    activityPayloadBytes,
    activityHeartbeatTimeoutMs,
    activityStartToCloseTimeoutMs,
    activityScheduleToStartTimeoutMs,
    activityScheduleToCloseTimeoutMs,
    memorySampleIntervalMs,
    memorySlopeMaxMbPerHour,
    memorySlopeMinElapsedMs,
    artifactsDir,
    metricsStreamPath,
    memoryStreamPath,
    metricsReportPath,
    cliLogPath,
    workflowTaskQueuePrefix,
    metricEnv: {
      TEMPORAL_METRICS_EXPORTER: 'file',
      TEMPORAL_METRICS_ENDPOINT: metricsStreamPath,
    },
  }
}

const defaultWorkflowDurationBudgetMs = (workflowCount: number, workflowConcurrencyTarget: number): number => {
  const concurrency = Math.max(1, workflowConcurrencyTarget)
  const requiredSlots = Math.ceil(Math.max(1, workflowCount) / concurrency)
  return Math.max(DEFAULT_WORKFLOW_DEADLINE_MS, requiredSlots * DEFAULT_WORKFLOW_DEADLINE_PER_CONCURRENCY_SLOT_MS)
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

const readBoolean = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) {
    return fallback
  }
  if (raw === '1' || raw === 'true' || raw === 't' || raw === 'yes' || raw === 'y' || raw === 'on') {
    return true
  }
  if (raw === '0' || raw === 'false' || raw === 'f' || raw === 'no' || raw === 'n' || raw === 'off') {
    return false
  }
  return fallback
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
