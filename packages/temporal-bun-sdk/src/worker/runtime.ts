import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { create } from '@bufbuild/protobuf'
import type { Timestamp } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError, createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Cause, Duration, Effect, Exit, Fiber, Schedule } from 'effect'

import {
  type ActivityHeartbeatRegistration,
  type ActivityLifecycle,
  type ActivityRetryState,
  makeActivityLifecycle,
} from '../activities/lifecycle'
import { buildTransportOptions, normalizeTemporalAddress } from '../client'
import { durationFromMillis, durationToMillis } from '../common/duration'
import {
  buildCodecsFromConfig,
  createDefaultDataConverter,
  type DataConverter,
  decodePayloadsToValues,
  encodeValuesToPayloads,
} from '../common/payloads/converter'
import { encodeErrorToFailure, encodeFailurePayloads, failureToError } from '../common/payloads/failure'
import { sleep } from '../common/sleep'
import { loadTemporalConfig, type DeterminismMarkerMode, type TemporalConfig } from '../config'
import type { InterceptorKind, TemporalInterceptor as WorkerInterceptor } from '../interceptors/types'
import {
  makeDefaultWorkerInterceptors,
  runWorkerInterceptors,
  type WorkerInterceptorBuilder,
} from '../interceptors/worker'
import { createObservabilityServices, type OpenTelemetryHandle } from '../observability'
import type { LogFields, Logger, LogLevel } from '../observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from '../observability/metrics'
import {
  type Command,
  CommandSchema,
  RecordMarkerCommandAttributesSchema,
} from '../proto/temporal/api/command/v1/message_pb'
import {
  type Payloads,
  PayloadsSchema,
  type RetryPolicy,
  WorkflowExecutionSchema,
} from '../proto/temporal/api/common/v1/message_pb'
import {
  type WorkerDeploymentOptions,
  WorkerDeploymentOptionsSchema,
} from '../proto/temporal/api/deployment/v1/message_pb'
import { CommandType } from '../proto/temporal/api/enums/v1/command_type_pb'
import { WorkerVersioningMode } from '../proto/temporal/api/enums/v1/deployment_pb'
import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { WorkflowTaskFailedCause } from '../proto/temporal/api/enums/v1/failed_cause_pb'
import { QueryResultType } from '../proto/temporal/api/enums/v1/query_pb'
import { HistoryEventFilterType, TimeoutType, VersioningBehavior } from '../proto/temporal/api/enums/v1/workflow_pb'
import type {
  ChildWorkflowExecutionCanceledEventAttributes,
  ChildWorkflowExecutionCompletedEventAttributes,
  ChildWorkflowExecutionFailedEventAttributes,
  ChildWorkflowExecutionTerminatedEventAttributes,
  ChildWorkflowExecutionTimedOutEventAttributes,
  HistoryEvent,
  WorkflowExecutionSignaledEventAttributes,
} from '../proto/temporal/api/history/v1/message_pb'
import type { WorkflowQuery, WorkflowQueryResult } from '../proto/temporal/api/query/v1/message_pb'
import {
  type StickyExecutionAttributes,
  StickyExecutionAttributesSchema,
  TaskQueueSchema,
} from '../proto/temporal/api/taskqueue/v1/message_pb'
import {
  GetWorkflowExecutionHistoryRequestSchema,
  PollActivityTaskQueueRequestSchema,
  type PollActivityTaskQueueResponse,
  PollWorkflowTaskQueueRequestSchema,
  type PollWorkflowTaskQueueResponse,
  RespondActivityTaskCanceledRequestSchema,
  RespondActivityTaskCompletedRequestSchema,
  RespondActivityTaskFailedRequestSchema,
  RespondQueryTaskCompletedRequestSchema,
  RespondWorkflowTaskCompletedRequestSchema,
  RespondWorkflowTaskFailedRequestSchema,
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from '../proto/temporal/api/workflowservice/v1/service_pb'
import type { WorkflowCommandIntent } from '../workflow/commands'
import type { ActivityResolution, WorkflowInfo } from '../workflow/context'
import type { WorkflowDefinition, WorkflowDefinitions } from '../workflow/definition'
import type {
  WorkflowCommandHistoryEntry,
  WorkflowDeterminismFailureMetadata,
  WorkflowDeterminismQueryRecord,
  WorkflowDeterminismSignalRecord,
  WorkflowDeterminismState,
  WorkflowRetryPolicyInput,
  stableStringify,
} from '../workflow/determinism'
import { WorkflowNondeterminismError } from '../workflow/errors'
import type { WorkflowQueryEvaluationResult, WorkflowUpdateInvocation } from '../workflow/executor'
import { WorkflowExecutor } from '../workflow/executor'
import {
  CHILD_WORKFLOW_COMPLETED_SIGNAL,
  type WorkflowQueryRequest,
  type WorkflowSignalDeliveryInput,
} from '../workflow/inbound'
import { WorkflowRegistry } from '../workflow/registry'
import {
  DETERMINISM_MARKER_NAME,
  type DeterminismStateDelta,
  type DeterminismMismatch,
  diffDeterminismState,
  encodeDeterminismMarkerDetails,
  ingestWorkflowHistory,
  type ReplayResult,
  resolveHistoryLastEventId,
} from '../workflow/replay'
import { type ActivityContext, type ActivityInfo, runWithActivityContext } from './activity-context'
import { checkWorkerVersioningCapability, registerWorkerBuildIdCompatibility } from './build-id'
import {
  type ActivityTaskEnvelope,
  makeWorkerScheduler,
  type WorkerScheduler,
  type WorkerSchedulerHooks,
  type WorkflowTaskEnvelope,
} from './concurrency'
import {
  makeStickyCache,
  type StickyCache,
  type StickyCacheEntry,
  type StickyCacheHooks,
  type StickyCacheKey,
} from './sticky-cache'
import { buildUpdateProtocolMessages, collectWorkflowUpdates } from './update-protocol'

type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>

type WorkerRuntimeMetrics = {
  readonly stickyCacheHit: Counter
  readonly stickyCacheMiss: Counter
  readonly stickyCacheEviction: Counter
  readonly stickyCacheHeal: Counter
  readonly nondeterminism: Counter
  readonly workflowPollLatency: Histogram
  readonly activityPollLatency: Histogram
  readonly workflowPollErrors: Counter
  readonly activityPollErrors: Counter
  readonly heartbeatRetries: Counter
  readonly heartbeatFailures: Counter
  readonly activityFailures: Counter
  readonly workflowFailures: Counter
  readonly workflowTaskStarted: Counter
  readonly workflowTaskCompleted: Counter
  readonly activityTaskStarted: Counter
  readonly activityTaskCompleted: Counter
  readonly queryTaskStarted: Counter
  readonly queryTaskCompleted: Counter
  readonly queryTaskFailed: Counter
  readonly queryTaskLatency: Histogram
}

const mergeUpdateInvocations = (
  historyInvocations: readonly WorkflowUpdateInvocation[],
  messageInvocations: readonly WorkflowUpdateInvocation[],
): WorkflowUpdateInvocation[] => {
  const merged: WorkflowUpdateInvocation[] = []
  const seen = new Set<string>()

  for (const invocation of historyInvocations ?? []) {
    if (!seen.has(invocation.updateId)) {
      merged.push(invocation)
      seen.add(invocation.updateId)
    }
  }

  for (const invocation of messageInvocations ?? []) {
    if (!seen.has(invocation.updateId)) {
      merged.push(invocation)
      seen.add(invocation.updateId)
    }
  }

  return merged
}

type NondeterminismContext = {
  readonly execution: { workflowId: string; runId: string }
  readonly workflowType: string
  readonly stickyLastEventId?: string | null
  readonly historyLastEventId?: string | null
  readonly workflowTaskAttempt?: number
}

const POLL_TIMEOUT_MS = 60_000
const RESPOND_TIMEOUT_MS = 15_000
const HISTORY_FETCH_TIMEOUT_MS = 60_000
const DEFAULT_METRICS_FLUSH_INTERVAL_MS = 10_000
const HEARTBEAT_RETRY_INITIAL_DELAY_MS = 250
const HEARTBEAT_RETRY_MAX_DELAY_MS = 5_000
const HEARTBEAT_RETRY_MAX_ATTEMPTS = 5
const HEARTBEAT_RETRY_BACKOFF = 2
const HEARTBEAT_RETRY_JITTER = 0.2
const parseMetricsFlushInterval = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}
const STICKY_QUEUE_PREFIX = 'sticky'
const COMPLETION_COMMAND_TYPES = new Set<CommandType>([
  CommandType.COMPLETE_WORKFLOW_EXECUTION,
  CommandType.FAIL_WORKFLOW_EXECUTION,
  CommandType.CONTINUE_AS_NEW_WORKFLOW_EXECUTION,
])

export type { WorkflowServiceClient }

export type ActivityHandler = (...args: unknown[]) => unknown | Promise<unknown>

export interface WorkerConcurrencyOptions {
  workflow?: number
  activity?: number
}

export interface WorkerPollerOptions {
  workflow?: number
}

export interface WorkerStickyCacheOptions {
  size?: number
  ttlMs?: number
}

export interface WorkerDeploymentConfig {
  name?: string
  buildId?: string
  versioningMode?: WorkerVersioningMode
  versioningBehavior?: VersioningBehavior
}

export interface WorkerRuntimeOptions {
  workflowsPath?: string
  workflows?: WorkflowDefinitions
  activities?: Record<string, ActivityHandler>
  taskQueue?: string
  namespace?: string
  dataConverter?: DataConverter
  identity?: string
  config?: TemporalConfig
  workflowService?: WorkflowServiceClient
  logger?: Logger
  metrics?: MetricsRegistry
  metricsExporter?: MetricsExporter
  metricsFlushIntervalMs?: number
  interceptors?: WorkerInterceptor[]
  interceptorBuilder?: WorkerInterceptorBuilder
  tracingEnabled?: boolean
  concurrency?: WorkerConcurrencyOptions
  pollers?: WorkerPollerOptions
  stickyCache?: WorkerStickyCacheOptions | StickyCache
  stickyScheduling?: boolean
  deployment?: WorkerDeploymentConfig
  schedulerHooks?: WorkerSchedulerHooks
}
export class WorkerRuntime {
  static async create(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
    const config = options.config ?? (await loadTemporalConfig())

    const namespace = options.namespace ?? config.namespace
    if (!namespace) {
      throw new Error('Temporal namespace must be provided')
    }

    const taskQueue = options.taskQueue ?? config.taskQueue
    if (!taskQueue) {
      throw new Error('Temporal task queue must be provided')
    }

    const identity = options.identity ?? config.workerIdentity
    const workflows = await loadWorkflows(options.workflowsPath, options.workflows)
    if (workflows.length === 0) {
      throw new Error('No workflow definitions were registered; provide workflows or workflowsPath')
    }

    const activities = options.activities ?? {}
    const observability = await Effect.runPromise(
      createObservabilityServices(
        {
          logLevel: config.logLevel,
          logFormat: config.logFormat,
          metrics: config.metricsExporter,
        },
        {
          logger: options.logger,
          metricsRegistry: options.metrics,
          metricsExporter: options.metricsExporter,
        },
      ),
    )
    const { logger, metricsRegistry, metricsExporter, openTelemetry } = observability
    const metricsFlushIntervalMs =
      options.metricsFlushIntervalMs ??
      parseMetricsFlushInterval(process.env.TEMPORAL_METRICS_FLUSH_INTERVAL_MS) ??
      DEFAULT_METRICS_FLUSH_INTERVAL_MS
    const dataConverter =
      options.dataConverter ??
      createDefaultDataConverter({
        payloadCodecs: buildCodecsFromConfig(config.payloadCodecs),
        logger,
        metricsRegistry,
      })
    const registry = new WorkflowRegistry()
    registry.registerMany(workflows)
    const executor = new WorkflowExecutor({
      registry,
      dataConverter,
      logger,
    })

    const runtimeMetrics = await WorkerRuntime.#initMetrics(metricsRegistry)
    let workflowService: WorkflowServiceClient
    if (options.workflowService) {
      workflowService = options.workflowService
    } else {
      const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
      const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
      const transport = createGrpcTransport(buildTransportOptions(baseUrl, config))
      workflowService = createClient(WorkflowService, transport)
    }

    const workflowConcurrency = options.concurrency?.workflow ?? config.workerWorkflowConcurrency
    const defaultActivityConcurrency = options.concurrency?.activity ?? config.workerActivityConcurrency
    const activityConcurrency = defaultActivityConcurrency > 0 ? defaultActivityConcurrency : 1
    const workflowPollerCount = options.pollers?.workflow ?? Math.max(1, workflowConcurrency)

    const scheduler = await Effect.runPromise(
      makeWorkerScheduler({
        workflowConcurrency,
        activityConcurrency,
        hooks: options.schedulerHooks,
        logger,
        metrics: {
          workflowTaskStarted: runtimeMetrics.workflowTaskStarted,
          workflowTaskCompleted: runtimeMetrics.workflowTaskCompleted,
          activityTaskStarted: runtimeMetrics.activityTaskStarted,
          activityTaskCompleted: runtimeMetrics.activityTaskCompleted,
        },
      }),
    )

    const stickyCacheCandidate = options.stickyCache
    const hasStickyCacheInstance = WorkerRuntime.#isStickyCacheInstance(stickyCacheCandidate)
    const stickyCacheOptions = hasStickyCacheInstance ? undefined : stickyCacheCandidate
    const stickyCacheSize = stickyCacheOptions?.size ?? config.workerStickyCacheSize
    const stickyCacheTtlMs = stickyCacheOptions?.ttlMs ?? config.workerStickyTtlMs
    const stickyCacheHooks: StickyCacheHooks = {
      onEvict: (entry, reason) =>
        logger.log('debug', 'sticky cache eviction', {
          namespace: entry.key.namespace,
          taskQueue,
          workflowId: entry.key.workflowId,
          runId: entry.key.runId,
          workflowType: entry.workflowType,
          reason,
        }),
    }
    const stickyCache = hasStickyCacheInstance
      ? (stickyCacheCandidate as StickyCache)
      : await Effect.runPromise(
          makeStickyCache({
            maxEntries: stickyCacheSize,
            ttlMs: stickyCacheTtlMs,
            metrics: {
              hits: runtimeMetrics.stickyCacheHit,
              misses: runtimeMetrics.stickyCacheMiss,
              evictions: runtimeMetrics.stickyCacheEviction,
            },
            hooks: stickyCacheHooks,
          }),
        )

    const stickyQueue = WorkerRuntime.#buildStickyQueueName(taskQueue, identity)
    const stickyScheduleToStartTimeoutMs = stickyCacheTtlMs
    const stickySchedulingEnabled =
      options.stickyScheduling ??
      (config.stickySchedulingEnabled &&
        (hasStickyCacheInstance ? config.workerStickyCacheSize > 0 : stickyCacheSize > 0))
    const determinismMarkerMode = config.determinismMarkerMode
    const determinismMarkerIntervalTasks = config.determinismMarkerIntervalTasks
    const determinismMarkerFullSnapshotIntervalTasks = config.determinismMarkerFullSnapshotIntervalTasks
    const determinismMarkerSkipUnchanged = config.determinismMarkerSkipUnchanged

    const deploymentName =
      options.deployment?.name ?? config.workerDeploymentName ?? WorkerRuntime.#defaultDeploymentName(taskQueue)
    const buildId = options.deployment?.buildId ?? config.workerBuildId ?? identity
    const workerVersioningMode = options.deployment?.versioningMode ?? WorkerVersioningMode.UNVERSIONED
    const versioningBehavior =
      workerVersioningMode === WorkerVersioningMode.VERSIONED
        ? (options.deployment?.versioningBehavior ?? VersioningBehavior.PINNED)
        : null
    const deploymentOptions = create(WorkerDeploymentOptionsSchema, {
      deploymentName,
      buildId,
      workerVersioningMode,
    })
    const rpcDeploymentOptions = workerVersioningMode === WorkerVersioningMode.VERSIONED ? deploymentOptions : undefined

    if (workerVersioningMode === WorkerVersioningMode.VERSIONED) {
      const capability = await checkWorkerVersioningCapability(workflowService, namespace, taskQueue)
      if (capability.supported) {
        await registerWorkerBuildIdCompatibility(workflowService, namespace, taskQueue, buildId, { logger })
      } else {
        await Effect.runPromise(
          logger.log('warn', 'skipping worker build ID registration', {
            namespace,
            taskQueue,
            reason: capability.reason ?? 'unknown capability error',
            note: 'Temporal CLI dev server (scripts/start-temporal-cli.ts) does not implement worker versioning yet',
          }),
        )
      }
    }

    const tracingEnabled = options.tracingEnabled ?? config.tracingInterceptorsEnabled ?? false
    const workerInterceptorBuilder: WorkerInterceptorBuilder = options.interceptorBuilder ?? {
      build: (input) => makeDefaultWorkerInterceptors(input),
    }
    const defaultWorkerInterceptors = await Effect.runPromise(
      workerInterceptorBuilder.build({
        namespace,
        taskQueue,
        identity,
        buildId,
        logger,
        metricsRegistry,
        metricsExporter,
        dataConverter,
        tracingEnabled,
      }),
    )
    const workerInterceptors: WorkerInterceptor[] = [...defaultWorkerInterceptors, ...(options.interceptors ?? [])]

    const activityLifecycle = await Effect.runPromise(
      makeActivityLifecycle({
        heartbeatIntervalMs: config.activityHeartbeatIntervalMs,
        heartbeatRpcTimeoutMs: config.activityHeartbeatRpcTimeoutMs,
        heartbeatRetry: {
          initialIntervalMs: HEARTBEAT_RETRY_INITIAL_DELAY_MS,
          maxIntervalMs: HEARTBEAT_RETRY_MAX_DELAY_MS,
          backoffCoefficient: HEARTBEAT_RETRY_BACKOFF,
          maxAttempts: HEARTBEAT_RETRY_MAX_ATTEMPTS,
          jitterRatio: HEARTBEAT_RETRY_JITTER,
        },
        observability: {
          logger,
          heartbeatRetryCounter: runtimeMetrics.heartbeatRetries,
          heartbeatFailureCounter: runtimeMetrics.heartbeatFailures,
        },
      }),
    )

    await Effect.runPromise(
      logger.log('info', 'temporal worker runtime configured', {
        namespace,
        taskQueue,
        identity,
        workflowConcurrency,
        activityConcurrency,
        stickySchedulingEnabled,
        determinismMarkerMode,
        determinismMarkerIntervalTasks,
        determinismMarkerFullSnapshotIntervalTasks,
        determinismMarkerSkipUnchanged,
        deploymentName,
        buildId,
        logLevel: config.logLevel,
        logFormat: config.logFormat,
        metricsExporter: config.metricsExporter.type,
        metricsFlushIntervalMs,
      }),
    )

    return new WorkerRuntime({
      config,
      workflowService,
      dataConverter,
      registry,
      executor,
      activities,
      logger,
      metricsRegistry,
      metricsExporter,
      metricsFlushIntervalMs,
      metrics: runtimeMetrics,
      openTelemetry,
      namespace,
      taskQueue,
      identity,
      activityLifecycle,
      scheduler,
      stickyCache,
      stickyQueue,
      stickyScheduleToStartTimeoutMs,
      deploymentOptions,
      rpcDeploymentOptions,
      versioningBehavior,
      stickySchedulingEnabled,
      determinismMarkerMode,
      determinismMarkerIntervalTasks,
      determinismMarkerFullSnapshotIntervalTasks,
      determinismMarkerSkipUnchanged,
      workflowPollerCount,
      interceptors: workerInterceptors,
    })
  }

  readonly #config: TemporalConfig
  readonly #workflowService: ReturnType<typeof createClient<typeof WorkflowService>>
  readonly #dataConverter: DataConverter
  readonly #registry: WorkflowRegistry
  readonly #executor: WorkflowExecutor
  readonly #activities: Record<string, ActivityHandler>
  readonly #logger: Logger
  readonly #metricsRegistry: MetricsRegistry
  readonly #metrics: WorkerRuntimeMetrics
  readonly #metricsExporter: MetricsExporter
  readonly #metricsFlushIntervalMs: number
  #metricsFlushInFlight = false
  readonly #openTelemetry?: OpenTelemetryHandle
  readonly #namespace: string
  readonly #taskQueue: string
  readonly #identity: string
  readonly #interceptors: WorkerInterceptor[]
  readonly #activityLifecycle: ActivityLifecycle
  readonly #scheduler: WorkerScheduler
  readonly #stickyCache: StickyCache
  readonly #stickyQueue: string
  readonly #stickySchedulingEnabled: boolean
  readonly #determinismMarkerMode: DeterminismMarkerMode
  readonly #determinismMarkerIntervalTasks: number
  readonly #determinismMarkerFullSnapshotIntervalTasks: number
  readonly #determinismMarkerSkipUnchanged: boolean
  readonly #stickyAttributes: StickyExecutionAttributes
  readonly #deploymentOptions: WorkerDeploymentOptions
  readonly #rpcDeploymentOptions: WorkerDeploymentOptions | undefined
  readonly #versioningBehavior: VersioningBehavior | null
  readonly #workflowPollerCount: number
  #running = false
  #runFiber: Fiber.RuntimeFiber<void, unknown> | null = null
  #schedulerStarted = false
  #schedulerStopPromise: Promise<void> | null = null

  private constructor(params: {
    config: TemporalConfig
    workflowService: ReturnType<typeof createClient<typeof WorkflowService>>
    dataConverter: DataConverter
    registry: WorkflowRegistry
    executor: WorkflowExecutor
    activities: Record<string, ActivityHandler>
    logger: Logger
    metricsRegistry: MetricsRegistry
    metrics: WorkerRuntimeMetrics
    metricsExporter: MetricsExporter
    metricsFlushIntervalMs: number
    openTelemetry?: OpenTelemetryHandle
    namespace: string
    taskQueue: string
    identity: string
    interceptors: WorkerInterceptor[]
    activityLifecycle: ActivityLifecycle
    scheduler: WorkerScheduler
    stickyCache: StickyCache
    stickyQueue: string
    stickyScheduleToStartTimeoutMs: number
    deploymentOptions: WorkerDeploymentOptions
    rpcDeploymentOptions: WorkerDeploymentOptions | undefined
    versioningBehavior: VersioningBehavior | null
    stickySchedulingEnabled: boolean
    determinismMarkerMode: DeterminismMarkerMode
    determinismMarkerIntervalTasks: number
    determinismMarkerFullSnapshotIntervalTasks: number
    determinismMarkerSkipUnchanged: boolean
    workflowPollerCount: number
  }) {
    this.#config = params.config
    this.#workflowService = params.workflowService
    this.#dataConverter = params.dataConverter
    this.#registry = params.registry
    this.#executor = params.executor
    this.#activities = params.activities
    this.#logger = params.logger
    this.#metricsRegistry = params.metricsRegistry
    this.#metrics = params.metrics
    this.#metricsExporter = params.metricsExporter
    this.#metricsFlushIntervalMs = Math.max(0, params.metricsFlushIntervalMs)
    this.#openTelemetry = params.openTelemetry
    this.#namespace = params.namespace
    this.#taskQueue = params.taskQueue
    this.#identity = params.identity
    this.#interceptors = params.interceptors
    this.#activityLifecycle = params.activityLifecycle
    this.#scheduler = params.scheduler
    this.#stickyCache = params.stickyCache
    this.#stickyQueue = params.stickyQueue
    this.#stickySchedulingEnabled = params.stickySchedulingEnabled
    this.#determinismMarkerMode = params.determinismMarkerMode
    this.#determinismMarkerIntervalTasks = Math.max(1, params.determinismMarkerIntervalTasks)
    this.#determinismMarkerFullSnapshotIntervalTasks = Math.max(1, params.determinismMarkerFullSnapshotIntervalTasks)
    this.#determinismMarkerSkipUnchanged = params.determinismMarkerSkipUnchanged
    this.#deploymentOptions = params.deploymentOptions
    this.#rpcDeploymentOptions = params.rpcDeploymentOptions
    this.#versioningBehavior = params.versioningBehavior
    this.#workflowPollerCount = params.workflowPollerCount
    this.#stickyAttributes = create(StickyExecutionAttributesSchema, {
      workerTaskQueue: create(TaskQueueSchema, { name: this.#stickyQueue }),
      scheduleToStartTimeout: durationFromMillis(params.stickyScheduleToStartTimeoutMs),
    })
  }

  #isValidDeterminismSnapshot(state: WorkflowDeterminismState | undefined): boolean {
    if (!state) {
      return false
    }
    return (
      state.commandHistory.length > 0 ||
      state.randomValues.length > 0 ||
      state.timeValues.length > 0 ||
      (state.signals?.length ?? 0) > 0 ||
      (state.queries?.length ?? 0) > 0
    )
  }

  #resolvePreviousHistoryEventId(response: PollWorkflowTaskQueueResponse): string | null {
    const previous = response.previousStartedEventId
    if (previous === undefined || previous === null) {
      return null
    }
    if (typeof previous === 'bigint') {
      return previous > 0n ? previous.toString() : null
    }
    const numeric = Number(previous)
    return Number.isFinite(numeric) && numeric > 0 ? numeric.toString() : null
  }

  #resolveCurrentStartedEventId(response: PollWorkflowTaskQueueResponse): string | null {
    const started = response.startedEventId
    if (started === undefined || started === null) {
      return null
    }
    if (typeof started === 'bigint') {
      return started > 0n ? started.toString() : null
    }
    const numeric = Number(started)
    return Number.isFinite(numeric) && numeric > 0 ? numeric.toString() : null
  }

  static #sanitizeTaskQueueComponent(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-')
  }

  static #buildStickyQueueName(taskQueue: string, identity: string): string {
    const queueComponent = WorkerRuntime.#sanitizeTaskQueueComponent(taskQueue)
    const identityComponent = WorkerRuntime.#sanitizeTaskQueueComponent(identity) || 'worker'
    return `${queueComponent}-${STICKY_QUEUE_PREFIX}-${identityComponent}`
  }

  static #defaultDeploymentName(taskQueue: string): string {
    const component = WorkerRuntime.#sanitizeTaskQueueComponent(taskQueue) || 'default'
    return `${component}-deployment`
  }

  static async #initMetrics(registry: MetricsRegistry): Promise<WorkerRuntimeMetrics> {
    const makeCounter = (name: string, description: string) => Effect.runPromise(registry.counter(name, description))
    const makeHistogram = (name: string, description: string) =>
      Effect.runPromise(registry.histogram(name, description))

    return {
      stickyCacheHit: await makeCounter('temporal_worker_sticky_cache_hits_total', 'Sticky cache reuse events'),
      stickyCacheMiss: await makeCounter('temporal_worker_sticky_cache_misses_total', 'Sticky cache rebuild events'),
      stickyCacheEviction: await makeCounter(
        'temporal_worker_sticky_cache_evictions_total',
        'Sticky cache evictions due to TTL/LRU',
      ),
      stickyCacheHeal: await makeCounter(
        'temporal_worker_sticky_cache_heal_total',
        'Sticky cache entries removed after determinism divergence',
      ),
      nondeterminism: await makeCounter(
        'temporal_worker_nondeterminism_total',
        'Workflow tasks failed because of nondeterminism mismatches',
      ),
      workflowPollLatency: await makeHistogram('temporal_worker_poll_latency_ms', 'Workflow task poll latency'),
      activityPollLatency: await makeHistogram(
        'temporal_worker_activity_poll_latency_ms',
        'Activity task poll latency',
      ),
      workflowPollErrors: await makeCounter('temporal_worker_poll_errors_total', 'Workflow polling errors'),
      activityPollErrors: await makeCounter('temporal_worker_activity_poll_errors_total', 'Activity polling errors'),
      heartbeatRetries: await makeCounter('temporal_worker_heartbeat_retries_total', 'Activity heartbeat retries'),
      heartbeatFailures: await makeCounter('temporal_worker_heartbeat_failures_total', 'Activity heartbeat failures'),
      activityFailures: await makeCounter(
        'temporal_worker_activity_failures_total',
        'Activity failures delivered to Temporal',
      ),
      workflowFailures: await makeCounter(
        'temporal_worker_workflow_failures_total',
        'Workflow failure responses sent to Temporal',
      ),
      workflowTaskStarted: await makeCounter(
        'temporal_worker_workflow_tasks_started_total',
        'Workflow tasks dispatched to the scheduler',
      ),
      workflowTaskCompleted: await makeCounter(
        'temporal_worker_workflow_tasks_completed_total',
        'Workflow tasks completed by the scheduler',
      ),
      activityTaskStarted: await makeCounter(
        'temporal_worker_activity_tasks_started_total',
        'Activity tasks dispatched to the scheduler',
      ),
      activityTaskCompleted: await makeCounter(
        'temporal_worker_activity_tasks_completed_total',
        'Activity tasks completed by the scheduler',
      ),
      queryTaskStarted: await makeCounter(
        'temporal_worker_query_started_total',
        'Query-only workflow tasks dispatched to the scheduler',
      ),
      queryTaskCompleted: await makeCounter(
        'temporal_worker_query_completed_total',
        'Query-only workflow tasks completed successfully',
      ),
      queryTaskFailed: await makeCounter(
        'temporal_worker_query_failed_total',
        'Query-only workflow tasks responded with failure',
      ),
      queryTaskLatency: await makeHistogram(
        'temporal_worker_query_latency_ms',
        'End-to-end workflow query latency (ms)',
      ),
    }
  }

  async run(): Promise<void> {
    if (this.#runFiber) {
      await this.#awaitRuntimeFiber(this.#runFiber)
      return
    }

    this.#running = true
    const runtimeFiber = Effect.runFork(this.#buildRuntimeEffect())
    this.#runFiber = runtimeFiber

    try {
      await this.#awaitRuntimeFiber(runtimeFiber)
    } finally {
      this.#runFiber = null
      this.#running = false
    }
  }

  async shutdown(): Promise<void> {
    this.#log('info', 'temporal worker shutdown requested', this.#runtimeLogFields({ running: this.#running }))
    const runtimeFiber = this.#runFiber
    if (!runtimeFiber) {
      await this.#stopScheduler()
      await this.#flushMetrics()
      await this.#shutdownOpenTelemetry()
      this.#running = false
      this.#log('info', 'temporal worker shutdown complete', this.#runtimeLogFields({ drained: false }))
      return
    }
    await Effect.runPromise(Fiber.interrupt(runtimeFiber))
    try {
      await this.#awaitRuntimeFiber(runtimeFiber)
    } catch {
      // ignore failures during shutdown; polling loops log errors before exiting
    } finally {
      this.#runFiber = null
      this.#running = false
    }
    await this.#shutdownOpenTelemetry()
    this.#log('info', 'temporal worker shutdown complete', this.#runtimeLogFields({ drained: true }))
  }

  #buildRuntimeEffect(): Effect.Effect<void> {
    const runtime = this
    const workflowPollers = Array.from({ length: runtime.#workflowPollerCount }, () =>
      runtime.#workflowPollerEffect(runtime.#taskQueue),
    )
    const stickyPollers = runtime.#stickySchedulingEnabled
      ? Array.from({ length: runtime.#workflowPollerCount }, () => runtime.#workflowPollerEffect(runtime.#stickyQueue))
      : []
    const activityPollers = runtime.#hasActivities() ? [runtime.#activityPollerEffect()] : []
    const pollerLoops = [...workflowPollers, ...stickyPollers, ...activityPollers]

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(() => runtime.#startScheduler())
        runtime.#log(
          'info',
          'temporal worker runtime started',
          runtime.#runtimeLogFields({
            workflowPollers: runtime.#workflowPollerCount,
            stickySchedulingEnabled: runtime.#stickySchedulingEnabled,
          }),
        )
        if (runtime.#metricsFlushIntervalMs > 0) {
          const flushLoop = Effect.repeat(
            Effect.promise(() => runtime.#flushMetrics()),
            Schedule.spaced(Duration.millis(runtime.#metricsFlushIntervalMs)),
          )
          yield* Effect.forkScoped(flushLoop)
        }
        if (pollerLoops.length > 0) {
          yield* Effect.forEach(pollerLoops, (loop) => Effect.forkScoped(loop), { concurrency: 'unbounded' })
        }
        yield* Effect.never
      }),
    ).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await runtime.#stopScheduler()
          await runtime.#flushMetrics()
          await runtime.#shutdownOpenTelemetry()
          runtime.#log('info', 'temporal worker runtime stopped', runtime.#runtimeLogFields())
        }),
      ),
    )
  }

  async #shutdownOpenTelemetry(): Promise<void> {
    if (!this.#openTelemetry) {
      return
    }
    await this.#openTelemetry.shutdown()
  }

  async #awaitRuntimeFiber(fiber: Fiber.RuntimeFiber<void, unknown>): Promise<void> {
    const exit = await Effect.runPromiseExit(Fiber.join(fiber))
    if (Exit.isFailure(exit)) {
      if (Cause.isInterrupted(exit.cause)) {
        return
      }
      throw Cause.squash(exit.cause)
    }
  }

  async #startScheduler(): Promise<void> {
    if (this.#schedulerStarted) {
      return
    }
    await Effect.runPromise(this.#scheduler.start)
    this.#schedulerStarted = true
    this.#log(
      'info',
      'worker scheduler started',
      this.#runtimeLogFields({ stickySchedulingEnabled: this.#stickySchedulingEnabled }),
    )
  }

  async #stopScheduler(): Promise<void> {
    if (!this.#schedulerStarted) {
      return
    }
    if (!this.#schedulerStopPromise) {
      this.#schedulerStopPromise = Effect.runPromise(this.#scheduler.stop).finally(() => {
        this.#schedulerStarted = false
        this.#schedulerStopPromise = null
        this.#log('info', 'worker scheduler stopped', this.#runtimeLogFields())
      })
    }
    await this.#schedulerStopPromise
  }

  #workflowPollerEffect(queueName: string): Effect.Effect<void, never, never> {
    const request = create(PollWorkflowTaskQueueRequestSchema, {
      namespace: this.#namespace,
      taskQueue: create(TaskQueueSchema, { name: queueName }),
      identity: this.#identity,
      deploymentOptions: this.#rpcDeploymentOptions,
    })

    const pollOnce = this.#withRpcAbort(async (signal) => {
      const start = Date.now()
      const response = await this.#workflowService.pollWorkflowTaskQueue(request, {
        timeoutMs: POLL_TIMEOUT_MS,
        signal,
      })
      this.#observeHistogram(this.#metrics.workflowPollLatency, Date.now() - start)
      if (!response.taskToken || response.taskToken.length === 0) {
        return
      }
      await this.#enqueueWorkflowTask(response)
    }).pipe(
      Effect.catchAll((error) =>
        this.#isRpcAbortError(error) ? Effect.void : this.#handleWorkflowPollerError(queueName, error),
      ),
    )

    return Effect.forever(pollOnce)
  }

  async #enqueueWorkflowTask(response: PollWorkflowTaskQueueResponse): Promise<void> {
    const taskToken = response.taskToken ?? new Uint8Array()
    const envelope: WorkflowTaskEnvelope = {
      taskToken,
      execute: () =>
        Effect.promise(async () => {
          await this.#handleWorkflowTask(response, 0)
        }),
    }
    await Effect.runPromise(this.#scheduler.enqueueWorkflow(envelope))
  }

  #activityPollerEffect(): Effect.Effect<void, never, never> {
    if (!this.#hasActivities()) {
      return Effect.void
    }
    const request = create(PollActivityTaskQueueRequestSchema, {
      namespace: this.#namespace,
      taskQueue: create(TaskQueueSchema, { name: this.#taskQueue }),
      identity: this.#identity,
      deploymentOptions: this.#rpcDeploymentOptions,
    })

    const pollOnce = this.#withRpcAbort(async (signal) => {
      const start = Date.now()
      const response = await this.#workflowService.pollActivityTaskQueue(request, {
        timeoutMs: POLL_TIMEOUT_MS,
        signal,
      })
      this.#observeHistogram(this.#metrics.activityPollLatency, Date.now() - start)
      if (!response.taskToken || response.taskToken.length === 0) {
        return
      }
      await this.#enqueueActivityTask(response)
    }).pipe(
      Effect.catchAll((error) => (this.#isRpcAbortError(error) ? Effect.void : this.#handleActivityPollerError(error))),
    )

    return Effect.forever(pollOnce)
  }

  #withRpcAbort<A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, unknown, never> {
    return Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.tryPromise({
          try: () => run(controller.signal),
          catch: (error) => error,
        }),
      (controller) =>
        Effect.sync(() => {
          controller.abort()
        }),
    )
  }

  #isRpcAbortError(error: unknown): boolean {
    return isAbortError(error) || (error instanceof ConnectError && error.code === Code.Canceled)
  }

  #isBenignPollTimeout(error: unknown): boolean {
    if (error instanceof ConnectError) {
      return error.code === Code.DeadlineExceeded || error.code === Code.Canceled
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase()
      return msg.includes('deadline') && msg.includes('exceeded')
    }
    if (typeof error === 'string') {
      const msg = error.toLowerCase()
      return msg.includes('deadline') && msg.includes('exceeded')
    }
    return false
  }

  async #enqueueActivityTask(response: PollActivityTaskQueueResponse): Promise<void> {
    const taskToken = response.taskToken ?? new Uint8Array()
    const envelope: ActivityTaskEnvelope = {
      taskToken,
      handler: () => this.#runActivityTask(response),
      args: [],
    }
    await Effect.runPromise(this.#scheduler.enqueueActivity(envelope))
  }

  #handleWorkflowPollerError(queueName: string, error: unknown): Effect.Effect<void, never, never> {
    return Effect.promise(async () => {
      if (this.#isBenignPollTimeout(error)) {
        this.#log('debug', 'workflow poll timeout (no tasks)', {
          queueName,
          namespace: this.#namespace,
        })
        return
      }
      this.#incrementCounter(this.#metrics.workflowPollErrors)
      this.#log('warn', 'workflow polling failed', {
        queueName,
        namespace: this.#namespace,
        error: error instanceof Error ? error.message : String(error),
      })
      await sleep(250)
    }).pipe(Effect.catchAll(() => Effect.void))
  }

  #handleActivityPollerError(error: unknown): Effect.Effect<void, never, never> {
    return Effect.promise(async () => {
      if (this.#isBenignPollTimeout(error)) {
        this.#log('debug', 'activity poll timeout (no tasks)', {
          namespace: this.#namespace,
          taskQueue: this.#taskQueue,
        })
        return
      }
      this.#incrementCounter(this.#metrics.activityPollErrors)
      this.#log('warn', 'activity polling failed', {
        namespace: this.#namespace,
        taskQueue: this.#taskQueue,
        error: error instanceof Error ? error.message : String(error),
      })
      await sleep(250)
    }).pipe(Effect.catchAll(() => Effect.void))
  }

  async #handleWorkflowTask(response: PollWorkflowTaskQueueResponse, nondeterminismRetry = 0): Promise<void> {
    const execution = this.#resolveWorkflowExecution(response)
    const queryCount =
      response.queries && typeof response.queries === 'object' && !Array.isArray(response.queries)
        ? Object.keys(response.queries).length
        : Array.isArray(response.queries)
          ? response.queries.length
          : 0
    const hasQueryRequests = Boolean(response.query) || queryCount > 0
    const hasUpdateMessages = (response.messages?.length ?? 0) > 0
    const kind: InterceptorKind = hasUpdateMessages
      ? 'worker.updateTask'
      : hasQueryRequests
        ? 'worker.queryTask'
        : 'worker.workflowTask'
    const context = {
      kind,
      namespace: this.#namespace,
      taskQueue: this.#taskQueue,
      identity: this.#identity,
      buildId: this.#deploymentOptions.buildId,
      workflowId: execution.workflowId,
      runId: execution.runId,
      attempt: Number(response.attempt ?? 1),
      metadata: { nondeterminismRetry },
    }
    const effect = runWorkerInterceptors(this.#interceptors, context, () =>
      Effect.tryPromise(() => this.#processWorkflowTask(response, nondeterminismRetry, execution)),
    )
    await Effect.runPromise(effect)
  }

  async #processWorkflowTask(
    response: PollWorkflowTaskQueueResponse,
    nondeterminismRetry = 0,
    executionOverride?: { workflowId: string; runId: string },
  ): Promise<void> {
    const execution = executionOverride ?? this.#resolveWorkflowExecution(response)
    const workflowTaskAttempt = Number(response.attempt ?? 1)
    const isLegacyQueryTask = Boolean(response.query)
    const queryStartTime = isLegacyQueryTask ? Date.now() : null
    if (isLegacyQueryTask) {
      this.#incrementCounter(this.#metrics.queryTaskStarted)
    }
    const historyEvents = await this.#collectWorkflowHistory(execution, response)
    const workflowType = this.#resolveWorkflowType(response, historyEvents)
    const args = await this.#decodeWorkflowArgs(historyEvents)
    const workflowInfo = this.#buildWorkflowInfo(workflowType, execution)
    const collectedUpdates = await collectWorkflowUpdates({
      messages: response.messages ?? [],
      dataConverter: this.#dataConverter,
      log: (level, message, fields) => this.#log(level, message, fields),
    })
    const baseLogFields = this.#workflowLogFields(execution, workflowType, {
      workflowTaskAttempt,
      stickyScheduling: this.#stickySchedulingEnabled,
      nondeterminismRetry,
    })
    const signalDeliveries = await this.#extractSignalDeliveries(historyEvents)
    if (signalDeliveries.length > 0) {
      this.#log('debug', 'workflow signal deliveries buffered', {
        ...baseLogFields,
        signalCount: signalDeliveries.length,
      })
    }
    const queryRequests = await this.#extractWorkflowQueryRequests(response)
    const hasQueryRequests = queryRequests.length > 0
    const hasMultiQueries = queryRequests.some((request) => request.source === 'multi')
    const hasLegacyQueries = queryRequests.some((request) => request.source === 'legacy')
    if (hasQueryRequests) {
      this.#log('debug', 'workflow queries pending evaluation', {
        ...baseLogFields,
        queryCount: queryRequests.length,
      })
    }
    this.#log('info', 'debug: workflow task metadata', {
      ...baseLogFields,
      taskTokenBytes: response.taskToken?.length ?? 0,
      queryCount: queryRequests.length,
      historyEventCount: response.history?.events?.length ?? 0,
    })
    const stickyKey = this.#buildStickyKey(execution.workflowId, execution.runId)
    const stickyEntry = stickyKey ? await this.#getStickyEntry(stickyKey) : undefined
    const historyReplay = await this.#ingestDeterminismState(workflowInfo, historyEvents, {
      queryRequests,
    })
    const hasHistorySnapshot = this.#isValidDeterminismSnapshot(historyReplay?.determinismState)
    let previousState: WorkflowDeterminismState | undefined

    if (stickyEntry && this.#isValidDeterminismSnapshot(stickyEntry.determinismState)) {
      const historyBaselineEventId = this.#resolvePreviousHistoryEventId(response) ?? historyReplay?.lastEventId ?? null
      const cacheMatchesHistory = (stickyEntry.lastEventId ?? null) === historyBaselineEventId

      if (cacheMatchesHistory) {
        previousState = stickyEntry.determinismState
        this.#log('debug', 'sticky cache hit', {
          ...baseLogFields,
          cacheLastEventId: stickyEntry.lastEventId ?? null,
          historyBaselineEventId,
        })
        this.#incrementCounter(this.#metrics.stickyCacheHit)
      } else if (hasHistorySnapshot && historyReplay) {
        const diff = await Effect.runPromise(
          diffDeterminismState(stickyEntry.determinismState, historyReplay.determinismState),
        )
        const logLevel: LogLevel = diff.mismatches.length > 0 ? 'warn' : 'info'
        this.#log(logLevel, 'sticky cache drift detected', {
          ...baseLogFields,
          cacheLastEventId: stickyEntry.lastEventId ?? null,
          historyBaselineEventId,
          mismatches: diff.mismatches,
        })
        previousState = historyReplay.determinismState
      }
    } else if (stickyEntry && this.#stickySchedulingEnabled) {
      this.#log('info', 'sticky cache entry invalid; rebuilding snapshot', {
        ...baseLogFields,
        cacheLastEventId: stickyEntry.lastEventId ?? null,
      })
    } else if (!stickyEntry && this.#stickySchedulingEnabled) {
      this.#log('debug', 'sticky cache miss (no entry)', baseLogFields)
      this.#incrementCounter(this.#metrics.stickyCacheMiss)
    }

    if (!previousState && hasHistorySnapshot && historyReplay) {
      if (this.#stickySchedulingEnabled) {
        this.#log('debug', 'sticky cache snapshot rebuilt from history', {
          ...baseLogFields,
          historyBaselineEventId: historyReplay.lastEventId ?? null,
        })
      }
      previousState = historyReplay.determinismState
    }

    const expectedDeterminismState = previousState

    try {
      const { results: activityResults, scheduledEventIds: activityScheduleEventIds } =
        await this.#extractActivityResolutions(historyEvents)
      const timerResults = await this.#extractTimerResolutions(historyEvents)
      const pendingChildWorkflows = await this.#extractPendingChildWorkflows(historyEvents)

      const replayUpdates = historyReplay?.updates ?? []
      const mergedUpdates = mergeUpdateInvocations(replayUpdates, collectedUpdates.invocations)
      const output = await this.#executor.execute({
        workflowType,
        workflowId: execution.workflowId,
        runId: execution.runId,
        namespace: this.#namespace,
        taskQueue: this.#taskQueue,
        arguments: args,
        determinismState: previousState,
        activityResults,
        activityScheduleEventIds,
        pendingChildWorkflows,
        signalDeliveries,
        timerResults,
        queryRequests,
        updates: mergedUpdates,
        mode: isLegacyQueryTask ? 'query' : 'workflow',
      })
      this.#log('debug', 'workflow query evaluation summary', {
        ...baseLogFields,
        queryResultCount: output.queryResults.length,
      })
      this.#log('debug', 'workflow query results raw', {
        ...baseLogFields,
        queryResults: output.queryResults.map((entry) => ({
          name: entry.request.name,
          source: entry.request.source,
          id: entry.request.id ?? null,
        })),
      })
      const multiQueryResults: Record<string, WorkflowQueryResult> = {}
      let legacyQueryResult: WorkflowQueryEvaluationResult | undefined
      for (const entry of output.queryResults) {
        this.#log('debug', 'workflow query evaluation completed', {
          ...baseLogFields,
          querySource: entry.request.source,
          queryName: entry.request.name,
          queryId: entry.request.id ?? null,
        })
        if (entry.request.source === 'multi' && entry.request.id) {
          multiQueryResults[entry.request.id] = entry.result
        } else if (entry.request.source === 'legacy') {
          legacyQueryResult = entry
        }
      }

      if (isLegacyQueryTask) {
        const target = legacyQueryResult ?? output.queryResults.find((entry) => entry.request.source === 'legacy')
        if (!target) {
          throw new Error('Legacy query result missing from workflow execution')
        }
        await this.#respondLegacyQueryTask(response, target)
        if (queryStartTime !== null) {
          this.#observeHistogram(this.#metrics.queryTaskLatency, Date.now() - queryStartTime)
        }
        this.#incrementCounter(this.#metrics.queryTaskCompleted)
        return
      }

      const cacheBaselineEventId = this.#resolveCurrentStartedEventId(response) ?? historyReplay?.lastEventId ?? null
      let commandsForResponse = output.commands
      const workflowTaskCount =
        output.completion === 'pending'
          ? (stickyEntry?.workflowTaskCount ?? 0) + 1
          : (stickyEntry?.workflowTaskCount ?? 0)
      let markerHash = stickyEntry?.lastDeterminismMarkerHash
      let lastMarkerTask = stickyEntry?.lastDeterminismMarkerTask
      let lastFullSnapshotTask = stickyEntry?.lastDeterminismFullSnapshotTask
      let markerType =
        output.completion === 'pending' ? this.#resolveDeterminismMarkerType(workflowTaskCount, stickyEntry) : null
      let determinismDelta: DeterminismStateDelta | undefined
      let markerLastEventId: string | null = null
      const dispatchesForNewMessages = (output.updateDispatches ?? []).filter((dispatch) => {
        if (dispatch.type === 'acceptance' || dispatch.type === 'rejection') {
          return collectedUpdates.requestsByUpdateId.has(dispatch.updateId)
        }
        // Allow completion messages to be emitted even if the request metadata was seen on a prior task.
        return true
      })
      const updateProtocolMessages = await buildUpdateProtocolMessages({
        dispatches: dispatchesForNewMessages,
        collected: collectedUpdates,
        dataConverter: this.#dataConverter,
        defaultIdentity: this.#identity,
        log: (level, message, fields) => this.#log(level, message, fields),
      })

      if (markerType === 'delta') {
        determinismDelta = this.#buildDeterminismDelta(stickyEntry?.determinismState, output.determinismState)
        if (!determinismDelta) {
          markerType = 'full'
        } else if (this.#determinismMarkerSkipUnchanged && this.#isDeterminismDeltaEmpty(determinismDelta)) {
          markerType = null
        }
      }

      if (markerType) {
        markerLastEventId =
          historyReplay?.lastEventId ??
          this.#resolveWorkflowHistoryLastEventId(response) ??
          stickyEntry?.lastEventId ??
          null
        const markerHashCandidate = this.#hashDeterminismMarker({
          markerType,
          lastEventId: markerLastEventId,
          determinismState: markerType === 'full' ? output.determinismState : undefined,
          determinismDelta: markerType === 'delta' ? determinismDelta : undefined,
        })
        if (this.#determinismMarkerSkipUnchanged && markerHashCandidate === stickyEntry?.lastDeterminismMarkerHash) {
          markerType = null
        } else {
          markerHash = markerHashCandidate
          lastMarkerTask = workflowTaskCount
          if (markerType === 'full') {
            lastFullSnapshotTask = workflowTaskCount
          }
          const markerDetails = await Effect.runPromise(
            encodeDeterminismMarkerDetails(this.#dataConverter, {
              info: workflowInfo,
              determinismState: output.determinismState,
              determinismDelta,
              markerType,
              lastEventId: markerLastEventId,
            }),
          )
          const markerCommand = this.#buildDeterminismMarkerCommand(markerDetails)
          commandsForResponse = this.#injectDeterminismMarker(commandsForResponse, markerCommand)
        }
      }

      if (stickyKey) {
        if (output.completion === 'pending') {
          await this.#upsertStickyEntry(stickyKey, output.determinismState, cacheBaselineEventId, workflowType, {
            workflowTaskCount,
            lastDeterminismMarkerHash: markerHash,
            lastDeterminismMarkerTask: lastMarkerTask,
            lastDeterminismFullSnapshotTask: lastFullSnapshotTask,
          })
          this.#log('debug', 'sticky cache snapshot persisted', {
            ...baseLogFields,
            cacheBaselineEventId,
          })
        } else {
          await this.#removeStickyEntry(stickyKey)
          await this.#removeStickyEntriesForWorkflow(stickyKey.workflowId)
          this.#log('debug', 'sticky cache entry cleared (workflow completed)', baseLogFields)
        }
      }

      const shouldRespondWorkflowTask = hasMultiQueries || !hasLegacyQueries
      if (shouldRespondWorkflowTask) {
        const completion = create(RespondWorkflowTaskCompletedRequestSchema, {
          taskToken: response.taskToken,
          commands: commandsForResponse,
          identity: this.#identity,
          namespace: this.#namespace,
          deploymentOptions: this.#rpcDeploymentOptions,
          queryResults: multiQueryResults,
          ...(this.#stickySchedulingEnabled && !hasLegacyQueries ? { stickyAttributes: this.#stickyAttributes } : {}),
          ...(this.#versioningBehavior !== null ? { versioningBehavior: this.#versioningBehavior } : {}),
          ...(updateProtocolMessages.length > 0 ? { messages: updateProtocolMessages } : {}),
        })
        try {
          await this.#workflowService.respondWorkflowTaskCompleted(completion, { timeoutMs: RESPOND_TIMEOUT_MS })
        } catch (rpcError) {
          this.#log('error', 'debug: respondWorkflowTaskCompleted failed', {
            ...baseLogFields,
            error: rpcError instanceof Error ? rpcError.message : String(rpcError),
          })
          if (this.#isTaskNotFoundError(rpcError)) {
            this.#logWorkflowTaskNotFound('respondWorkflowTaskCompleted', execution)
            return
          }
          throw rpcError
        }
      }
      if (legacyQueryResult) {
        await this.#respondLegacyQueryTask(response, legacyQueryResult)
      }
    } catch (error) {
      let stickyEntryCleared = false
      if (stickyKey) {
        await this.#removeStickyEntry(stickyKey)
        await this.#removeStickyEntriesForWorkflow(stickyKey.workflowId)
        stickyEntryCleared = true
      }
      if (this.#isTaskNotFoundError(error)) {
        this.#logWorkflowTaskNotFound('respondWorkflowTaskCompleted', execution)
        return
      }
      if (isLegacyQueryTask) {
        this.#incrementCounter(this.#metrics.queryTaskFailed)
        if (queryStartTime !== null) {
          this.#observeHistogram(this.#metrics.queryTaskLatency, Date.now() - queryStartTime)
        }
        if (error instanceof WorkflowNondeterminismError) {
          const mismatches = await this.#computeNondeterminismMismatches(error, expectedDeterminismState)
          this.#incrementCounter(this.#metrics.nondeterminism)
          this.#log('error', 'workflow query nondeterminism detected', {
            ...baseLogFields,
            mismatches,
          })
        }
        await this.#respondLegacyQueryFailure(response, error)
        return
      }
      if (error instanceof WorkflowNondeterminismError) {
        const mismatches = await this.#computeNondeterminismMismatches(error, expectedDeterminismState)
        if (stickyKey && stickyEntryCleared) {
          this.#incrementCounter(this.#metrics.stickyCacheHeal)
          this.#log('warn', 'sticky cache entry cleared after nondeterminism', {
            ...baseLogFields,
            cacheLastEventId: stickyEntry?.lastEventId ?? null,
          })
        }
        if (nondeterminismRetry === 0) {
          this.#log('info', 'retrying workflow task after nondeterminism', {
            ...baseLogFields,
            mismatches,
            retryReason: 'history-refresh',
          })
          await this.#handleWorkflowTask(response, nondeterminismRetry + 1)
          return
        }
        this.#incrementCounter(this.#metrics.nondeterminism)
        this.#log('error', 'workflow nondeterminism detected', {
          ...baseLogFields,
          mismatches,
        })
        const enriched = this.#augmentNondeterminismError(error, mismatches, {
          execution,
          workflowType,
          stickyLastEventId: stickyEntry?.lastEventId ?? null,
          historyLastEventId: historyReplay?.lastEventId ?? null,
          workflowTaskAttempt,
        })
        await this.#failWorkflowTask(response, execution, enriched, WorkflowTaskFailedCause.NON_DETERMINISTIC_ERROR)
        return
      }
      if (stickyEntryCleared && this.#stickySchedulingEnabled) {
        this.#log('debug', 'sticky cache entry cleared after workflow failure', baseLogFields)
      }
      await this.#failWorkflowTask(response, execution, error)
    }
  }

  #buildStickyKey(workflowId: string, runId: string): StickyCacheKey | null {
    if (!workflowId || !runId) {
      return null
    }
    return {
      namespace: this.#namespace,
      workflowId,
      runId,
    }
  }

  async #ingestDeterminismState(
    workflowInfo: WorkflowInfo,
    historyEvents: HistoryEvent[],
    options?: { queryRequests?: readonly WorkflowQueryRequest[] },
  ): Promise<ReplayResult | undefined> {
    if (historyEvents.length === 0) {
      return undefined
    }
    return await Effect.runPromise(
      ingestWorkflowHistory({
        info: workflowInfo,
        history: historyEvents,
        dataConverter: this.#dataConverter,
        queries: options?.queryRequests,
      }),
    )
  }

  async #collectWorkflowHistory(
    execution: { workflowId: string; runId: string },
    _response: PollWorkflowTaskQueueResponse,
  ): Promise<HistoryEvent[]> {
    const events: HistoryEvent[] = []
    let token: Uint8Array | undefined
    while (true) {
      const page = await this.#fetchWorkflowHistoryPage(execution, token)
      if (page.events.length > 0) {
        events.push(...page.events)
      }
      if (!page.nextPageToken || page.nextPageToken.length === 0) {
        break
      }
      token = page.nextPageToken
    }
    return events
  }

  async #extractActivityResolutions(events: HistoryEvent[]): Promise<{
    results: Map<string, ActivityResolution>
    scheduledEventIds: Map<string, string>
  }> {
    const resolutions = new Map<string, ActivityResolution>()
    const scheduledActivityIds = new Map<string, string>()
    const activityScheduleById = new Map<string, string>()

    const normalizeEventId = (value: bigint | number | string | undefined | null): string | undefined => {
      if (value === undefined || value === null) {
        return undefined
      }
      if (typeof value === 'string') {
        return value
      }
      return value.toString()
    }

    const resolveActivityId = (
      attrs: Record<string, unknown>,
      scheduledEventId?: bigint | number | string | undefined | null,
    ): string | undefined => {
      const direct = typeof attrs.activityId === 'string' ? attrs.activityId : undefined
      if (direct) {
        return direct
      }
      const key = normalizeEventId(scheduledEventId)
      if (!key) {
        return undefined
      }
      return scheduledActivityIds.get(key)
    }

    for (const event of events) {
      switch (event.eventType) {
        case EventType.ACTIVITY_TASK_SCHEDULED: {
          if (event.attributes?.case !== 'activityTaskScheduledEventAttributes') {
            break
          }
          const activityId = event.attributes.value.activityId
          const scheduledKey = normalizeEventId(event.eventId)
          if (activityId && scheduledKey) {
            scheduledActivityIds.set(scheduledKey, activityId)
            activityScheduleById.set(activityId, scheduledKey)
          }
          break
        }
        case EventType.ACTIVITY_TASK_COMPLETED: {
          if (event.attributes?.case !== 'activityTaskCompletedEventAttributes') {
            break
          }
          const activityId = resolveActivityId(event.attributes.value, event.attributes.value.scheduledEventId)
          if (!activityId) {
            break
          }
          const payloads = event.attributes.value.result?.payloads ?? []
          const decoded = await decodePayloadsToValues(this.#dataConverter, payloads)
          const value =
            decoded.length === 0 ? undefined : decoded.length === 1 ? decoded[0] : Object.freeze([...decoded])
          resolutions.set(activityId, { status: 'completed', value })
          break
        }
        case EventType.ACTIVITY_TASK_FAILED: {
          if (event.attributes?.case !== 'activityTaskFailedEventAttributes') {
            break
          }
          const activityId = resolveActivityId(event.attributes.value, event.attributes.value.scheduledEventId)
          if (!activityId) {
            break
          }
          const failureError =
            (await failureToError(this.#dataConverter, event.attributes.value.failure)) ??
            new Error(`Activity ${activityId} failed`)
          resolutions.set(activityId, { status: 'failed', error: failureError })
          break
        }
        case EventType.ACTIVITY_TASK_TIMED_OUT: {
          if (event.attributes?.case !== 'activityTaskTimedOutEventAttributes') {
            break
          }
          const activityId = resolveActivityId(event.attributes.value, event.attributes.value.scheduledEventId)
          if (!activityId) {
            break
          }
          const timeoutFailure = event.attributes.value.failure?.failureInfo
          const timeoutTypeValue =
            timeoutFailure?.case === 'timeoutFailureInfo' ? timeoutFailure.value.timeoutType : undefined
          const timeoutType =
            timeoutTypeValue !== undefined ? (TimeoutType[timeoutTypeValue] ?? String(timeoutTypeValue)) : 'unknown'
          const failureError =
            (await failureToError(this.#dataConverter, event.attributes.value.failure)) ??
            new Error(`Activity ${activityId} timed out (${timeoutType})`)
          resolutions.set(activityId, { status: 'failed', error: failureError })
          break
        }
        case EventType.ACTIVITY_TASK_CANCELED: {
          if (event.attributes?.case !== 'activityTaskCanceledEventAttributes') {
            break
          }
          const activityId = resolveActivityId(event.attributes.value, event.attributes.value.scheduledEventId)
          if (!activityId) {
            break
          }
          const details = await decodePayloadsToValues(
            this.#dataConverter,
            event.attributes.value.details?.payloads ?? [],
          )
          const error = new Error(`Activity ${activityId} was canceled`)
          ;(error as { details?: unknown[] }).details = details
          resolutions.set(activityId, { status: 'failed', error })
          break
        }
        default:
          break
      }
    }
    return { results: resolutions, scheduledEventIds: activityScheduleById }
  }

  async #extractSignalDeliveries(events: HistoryEvent[]): Promise<WorkflowSignalDeliveryInput[]> {
    const deliveries: WorkflowSignalDeliveryInput[] = []

    const normalizeEventId = (value: bigint | number | string | undefined | null): string | null => {
      if (value === undefined || value === null) {
        return null
      }
      if (typeof value === 'string') {
        return value
      }
      return value.toString()
    }

    const recordChildCompletion = (
      event: HistoryEvent,
      status: 'completed' | 'failed' | 'canceled' | 'terminated' | 'timed_out',
      attrs:
        | ChildWorkflowExecutionCompletedEventAttributes
        | ChildWorkflowExecutionFailedEventAttributes
        | ChildWorkflowExecutionCanceledEventAttributes
        | ChildWorkflowExecutionTerminatedEventAttributes
        | ChildWorkflowExecutionTimedOutEventAttributes,
    ) => {
      const workflowId = attrs.workflowExecution?.workflowId
      if (!workflowId) {
        return
      }
      deliveries.push({
        name: CHILD_WORKFLOW_COMPLETED_SIGNAL,
        args: [
          {
            workflowId,
            ...(attrs.workflowExecution?.runId ? { runId: attrs.workflowExecution.runId } : {}),
            status,
          },
        ],
        metadata: {
          eventId: normalizeEventId(event.eventId),
        },
      })
    }

    for (const event of events) {
      switch (event.eventType) {
        case EventType.WORKFLOW_EXECUTION_SIGNALED: {
          if (event.attributes?.case !== 'workflowExecutionSignaledEventAttributes') {
            break
          }
          const attrs = event.attributes.value as WorkflowExecutionSignaledEventAttributes
          const args = await decodePayloadsToValues(this.#dataConverter, attrs.input?.payloads ?? [])
          const workflowTaskCompletedEventId =
            'workflowTaskCompletedEventId' in attrs
              ? normalizeEventId(
                  (attrs as { workflowTaskCompletedEventId?: bigint | number | string | null })
                    .workflowTaskCompletedEventId,
                )
              : null
          deliveries.push({
            name: attrs.signalName ?? 'unknown',
            args,
            metadata: {
              eventId: normalizeEventId(event.eventId),
              workflowTaskCompletedEventId,
              identity: attrs.identity ?? null,
            },
          })
          break
        }
        case EventType.CHILD_WORKFLOW_EXECUTION_COMPLETED: {
          if (event.attributes?.case !== 'childWorkflowExecutionCompletedEventAttributes') {
            break
          }
          recordChildCompletion(
            event,
            'completed',
            event.attributes.value as ChildWorkflowExecutionCompletedEventAttributes,
          )
          break
        }
        case EventType.CHILD_WORKFLOW_EXECUTION_FAILED: {
          if (event.attributes?.case !== 'childWorkflowExecutionFailedEventAttributes') {
            break
          }
          recordChildCompletion(event, 'failed', event.attributes.value as ChildWorkflowExecutionFailedEventAttributes)
          break
        }
        case EventType.CHILD_WORKFLOW_EXECUTION_CANCELED: {
          if (event.attributes?.case !== 'childWorkflowExecutionCanceledEventAttributes') {
            break
          }
          recordChildCompletion(
            event,
            'canceled',
            event.attributes.value as ChildWorkflowExecutionCanceledEventAttributes,
          )
          break
        }
        case EventType.CHILD_WORKFLOW_EXECUTION_TERMINATED: {
          if (event.attributes?.case !== 'childWorkflowExecutionTerminatedEventAttributes') {
            break
          }
          recordChildCompletion(
            event,
            'terminated',
            event.attributes.value as ChildWorkflowExecutionTerminatedEventAttributes,
          )
          break
        }
        case EventType.CHILD_WORKFLOW_EXECUTION_TIMED_OUT: {
          if (event.attributes?.case !== 'childWorkflowExecutionTimedOutEventAttributes') {
            break
          }
          recordChildCompletion(
            event,
            'timed_out',
            event.attributes.value as ChildWorkflowExecutionTimedOutEventAttributes,
          )
          break
        }
        default:
          break
      }
    }

    return deliveries
  }

  async #extractTimerResolutions(events: HistoryEvent[]): Promise<Set<string>> {
    const fired = new Set<string>()
    for (const event of events) {
      if (event.eventType !== EventType.TIMER_FIRED) {
        continue
      }
      if (event.attributes?.case !== 'timerFiredEventAttributes') {
        continue
      }
      const attrs = event.attributes.value as { timerId?: string }
      if (attrs.timerId) {
        fired.add(attrs.timerId)
      }
    }
    return fired
  }

  async #extractPendingChildWorkflows(events: HistoryEvent[]): Promise<Set<string>> {
    const pending = new Map<string, string>()

    const normalizeEventId = (value: bigint | number | string | undefined | null): string | null => {
      if (value === undefined || value === null) {
        return null
      }
      if (typeof value === 'string') {
        return value
      }
      return value.toString()
    }

    for (const event of events) {
      switch (event.eventType) {
        case EventType.START_CHILD_WORKFLOW_EXECUTION_INITIATED: {
          if (event.attributes?.case !== 'startChildWorkflowExecutionInitiatedEventAttributes') {
            break
          }
          const attrs = event.attributes.value
          const initiatedId = normalizeEventId(event.eventId)
          if (initiatedId && attrs.workflowId) {
            pending.set(initiatedId, attrs.workflowId)
          }
          break
        }
        case EventType.CHILD_WORKFLOW_EXECUTION_STARTED: {
          if (event.attributes?.case !== 'childWorkflowExecutionStartedEventAttributes') {
            break
          }
          const initiatedId = normalizeEventId(event.attributes.value.initiatedEventId)
          if (initiatedId) {
            pending.delete(initiatedId)
          }
          break
        }
        case EventType.START_CHILD_WORKFLOW_EXECUTION_FAILED: {
          if (event.attributes?.case !== 'startChildWorkflowExecutionFailedEventAttributes') {
            break
          }
          const initiatedId = normalizeEventId(event.attributes.value.initiatedEventId)
          if (initiatedId) {
            pending.delete(initiatedId)
          }
          break
        }
        default:
          break
      }
    }

    return new Set(pending.values())
  }

  async #extractWorkflowQueryRequests(response: PollWorkflowTaskQueueResponse): Promise<WorkflowQueryRequest[]> {
    const requests: WorkflowQueryRequest[] = []
    const map = response.queries ?? {}
    this.#log('info', 'debug: workflow query payloads detected', {
      namespace: this.#namespace,
      taskQueue: this.#taskQueue,
      workflowId: response.workflowExecution?.workflowId,
      runId: response.workflowExecution?.runId,
      queryMapSize: Object.keys(map).length,
      hasLegacyQuery: Boolean(response.query),
    })
    for (const [id, query] of Object.entries(map)) {
      const args = await decodePayloadsToValues(this.#dataConverter, query.queryArgs?.payloads ?? [])
      const header = await this.#decodeQueryHeader(query)
      requests.push({
        id,
        name: query.queryType ?? 'query',
        args,
        metadata: header ? { header } : undefined,
        source: 'multi',
      })
    }
    if (response.query) {
      const args = await decodePayloadsToValues(this.#dataConverter, response.query.queryArgs?.payloads ?? [])
      const header = await this.#decodeQueryHeader(response.query)
      requests.push({
        name: response.query.queryType ?? 'query',
        args,
        metadata: header ? { header } : undefined,
        source: 'legacy',
      })
    }
    return requests
  }

  async #decodeQueryHeader(query: WorkflowQuery | undefined): Promise<Record<string, unknown> | undefined> {
    const fields = query?.header?.fields
    if (!fields || Object.keys(fields).length === 0) {
      return undefined
    }
    const decoded: Record<string, unknown> = {}
    for (const [key, payload] of Object.entries(fields)) {
      const values = await decodePayloadsToValues(this.#dataConverter, payload ? [payload] : [])
      decoded[key] = values.length === 0 ? undefined : values.length === 1 ? values[0] : Object.freeze([...values])
    }
    return Object.keys(decoded).length > 0 ? decoded : undefined
  }

  async #respondLegacyQueryTask(
    response: PollWorkflowTaskQueueResponse,
    entry: WorkflowQueryEvaluationResult,
  ): Promise<void> {
    const queryResult = entry.result
    this.#log('debug', 'responding to legacy workflow query', {
      namespace: this.#namespace,
      workflowId: response.workflowExecution?.workflowId,
      runId: response.workflowExecution?.runId,
      queryName: entry.request.name,
    })
    const request = create(RespondQueryTaskCompletedRequestSchema, {
      taskToken: response.taskToken ?? new Uint8Array(),
      completedType: queryResult.resultType ?? QueryResultType.ANSWERED,
      queryResult: queryResult.answer,
      errorMessage: queryResult.errorMessage ?? '',
      namespace: this.#namespace,
      failure: queryResult.failure,
      cause: WorkflowTaskFailedCause.UNSPECIFIED,
    })
    await this.#workflowService.respondQueryTaskCompleted(request, { timeoutMs: RESPOND_TIMEOUT_MS })
  }

  async #respondLegacyQueryFailure(response: PollWorkflowTaskQueueResponse, cause: unknown): Promise<void> {
    const failure = await encodeErrorToFailure(this.#dataConverter, cause)
    const message = cause instanceof Error ? cause.message : 'Workflow query failed'
    const request = create(RespondQueryTaskCompletedRequestSchema, {
      taskToken: response.taskToken ?? new Uint8Array(),
      completedType: QueryResultType.FAILED,
      errorMessage: message,
      namespace: this.#namespace,
      failure,
      cause: WorkflowTaskFailedCause.UNSPECIFIED,
    })
    try {
      await this.#workflowService.respondQueryTaskCompleted(request, { timeoutMs: RESPOND_TIMEOUT_MS })
    } catch (rpcError) {
      this.#log('error', 'respondQueryTaskCompleted failed for legacy query', {
        namespace: this.#namespace,
        workflowId: response.workflowExecution?.workflowId,
        runId: response.workflowExecution?.runId,
        error: rpcError instanceof Error ? rpcError.message : String(rpcError),
      })
      if (this.#isTaskNotFoundError(rpcError)) {
        this.#logWorkflowTaskNotFound('respondQueryTaskCompleted', this.#resolveWorkflowExecution(response))
        return
      }
      throw rpcError
    }
  }

  async #fetchWorkflowHistoryPage(
    execution: { workflowId: string; runId: string },
    nextPageToken?: Uint8Array,
  ): Promise<{ events: HistoryEvent[]; nextPageToken: Uint8Array }> {
    if (!execution.workflowId || !execution.runId) {
      return { events: [], nextPageToken: new Uint8Array() }
    }

    const historyRequest = create(GetWorkflowExecutionHistoryRequestSchema, {
      namespace: this.#namespace,
      execution: create(WorkflowExecutionSchema, {
        workflowId: execution.workflowId,
        runId: execution.runId,
      }),
      maximumPageSize: 0,
      ...(nextPageToken && nextPageToken.length > 0 ? { nextPageToken } : {}),
      waitNewEvent: false,
      historyEventFilterType: HistoryEventFilterType.ALL_EVENT,
      skipArchival: true,
    })

    const historyResponse = await this.#workflowService.getWorkflowExecutionHistory(historyRequest, {
      timeoutMs: HISTORY_FETCH_TIMEOUT_MS,
    })

    return {
      events: historyResponse.history?.events ?? [],
      nextPageToken: historyResponse.nextPageToken ?? new Uint8Array(),
    }
  }

  #buildWorkflowInfo(workflowType: string, execution: { workflowId: string; runId: string }): WorkflowInfo {
    return {
      namespace: this.#namespace,
      taskQueue: this.#taskQueue,
      workflowId: execution.workflowId,
      runId: execution.runId,
      workflowType,
    }
  }

  async #getStickyEntry(key: StickyCacheKey): Promise<StickyCacheEntry | undefined> {
    return await Effect.runPromise(this.#stickyCache.get(key))
  }

  async #upsertStickyEntry(
    key: StickyCacheKey,
    state: WorkflowDeterminismState,
    lastEventId: string | null,
    workflowType: string,
    metadata?: Partial<
      Omit<StickyCacheEntry, 'key' | 'determinismState' | 'lastEventId' | 'lastAccessed' | 'workflowType'>
    >,
  ): Promise<void> {
    const entry: StickyCacheEntry = {
      key,
      determinismState: state,
      lastEventId,
      lastAccessed: Date.now(),
      workflowType,
      ...metadata,
    }
    await Effect.runPromise(this.#stickyCache.upsert(entry))
  }

  #resolveWorkflowHistoryLastEventId(response: PollWorkflowTaskQueueResponse): string | null {
    return resolveHistoryLastEventId(response.history?.events ?? [])
  }

  #resolveDeterminismMarkerType(taskIndex: number, stickyEntry?: StickyCacheEntry): 'full' | 'delta' | null {
    if (this.#determinismMarkerMode === 'never') {
      return null
    }
    if (this.#determinismMarkerMode === 'always') {
      return 'full'
    }
    const interval = Math.max(1, this.#determinismMarkerIntervalTasks)
    const shouldRecord = taskIndex === 1 || interval === 1 || taskIndex % interval === 0
    if (!shouldRecord) {
      return null
    }
    if (this.#determinismMarkerMode === 'delta') {
      const lastFullSnapshot = stickyEntry?.lastDeterminismFullSnapshotTask ?? 0
      const fullInterval = Math.max(1, this.#determinismMarkerFullSnapshotIntervalTasks)
      const fullDue = taskIndex === 1 || fullInterval === 1 || taskIndex - lastFullSnapshot >= fullInterval
      return fullDue ? 'full' : 'delta'
    }
    return 'full'
  }

  #buildDeterminismDelta(
    previous: WorkflowDeterminismState | undefined,
    current: WorkflowDeterminismState,
  ): DeterminismStateDelta | undefined {
    if (!previous) {
      return undefined
    }
    const sliceAppend = <T>(currentList: readonly T[], previousList: readonly T[]): T[] | undefined => {
      if (currentList.length < previousList.length) {
        return undefined
      }
      return currentList.slice(previousList.length)
    }

    const commandHistory = sliceAppend(current.commandHistory, previous.commandHistory)
    const randomValues = sliceAppend(current.randomValues, previous.randomValues)
    const timeValues = sliceAppend(current.timeValues, previous.timeValues)
    const signals = sliceAppend(current.signals, previous.signals)
    const queries = sliceAppend(current.queries, previous.queries)
    if (!commandHistory || !randomValues || !timeValues || !signals || !queries) {
      return undefined
    }

    const updatesPrev = previous.updates ?? []
    const updatesNext = current.updates ?? []
    if (updatesNext.length < updatesPrev.length) {
      return undefined
    }
    const updates = updatesNext.slice(updatesPrev.length)
    const logCount =
      current.logCount !== undefined && current.logCount !== previous.logCount ? current.logCount : undefined
    const failureMetadata =
      current.failureMetadata && stableStringify(current.failureMetadata) !== stableStringify(previous.failureMetadata)
        ? current.failureMetadata
        : undefined

    return {
      commandHistory,
      randomValues,
      timeValues,
      signals,
      queries,
      ...(updates.length > 0 ? { updates } : {}),
      ...(logCount !== undefined ? { logCount } : {}),
      ...(failureMetadata ? { failureMetadata } : {}),
    }
  }

  #isDeterminismDeltaEmpty(delta: DeterminismStateDelta): boolean {
    const updatesCount = delta.updates ? delta.updates.length : 0
    return (
      (delta.commandHistory?.length ?? 0) === 0 &&
      (delta.randomValues?.length ?? 0) === 0 &&
      (delta.timeValues?.length ?? 0) === 0 &&
      (delta.signals?.length ?? 0) === 0 &&
      (delta.queries?.length ?? 0) === 0 &&
      updatesCount === 0 &&
      delta.logCount === undefined &&
      delta.failureMetadata === undefined
    )
  }

  #hashDeterminismMarker(input: {
    markerType: 'full' | 'delta'
    lastEventId: string | null
    determinismState?: WorkflowDeterminismState
    determinismDelta?: DeterminismStateDelta
  }): string {
    const payload = stableStringify(input)
    return createHash('sha256').update(payload).digest('hex')
  }

  #isTaskNotFoundError(error: unknown): boolean {
    return error instanceof ConnectError && error.code === Code.NotFound
  }

  #buildDeterminismMarkerCommand(details: Record<string, Payloads>): Command {
    return create(CommandSchema, {
      commandType: CommandType.RECORD_MARKER,
      attributes: {
        case: 'recordMarkerCommandAttributes',
        value: create(RecordMarkerCommandAttributesSchema, {
          markerName: DETERMINISM_MARKER_NAME,
          details,
        }),
      },
    })
  }

  #injectDeterminismMarker(commands: Command[], marker: Command): Command[] {
    if (commands.some((command) => this.#isDeterminismMarkerCommand(command))) {
      return commands
    }
    const next = [...commands]
    const completionIndex = next.findIndex((command) => COMPLETION_COMMAND_TYPES.has(command.commandType))
    if (completionIndex === -1) {
      next.push(marker)
      return next
    }
    next.splice(completionIndex, 0, marker)
    return next
  }

  #isDeterminismMarkerCommand(command: Command): boolean {
    if (command.commandType !== CommandType.RECORD_MARKER) {
      return false
    }
    if (command.attributes?.case !== 'recordMarkerCommandAttributes') {
      return false
    }
    return command.attributes.value.markerName === DETERMINISM_MARKER_NAME
  }

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    void Effect.runPromise(this.#logger.log(level, message, fields))
  }

  #incrementCounter(counter: Counter, value = 1): void {
    void Effect.runPromise(counter.inc(value))
  }

  #observeHistogram(histogram: Histogram, value: number): void {
    void Effect.runPromise(histogram.observe(value))
  }

  #workflowLogFields(
    execution: { workflowId: string; runId: string },
    workflowType: string,
    extra?: LogFields,
  ): LogFields {
    return {
      namespace: this.#namespace,
      taskQueue: this.#taskQueue,
      workflowId: execution.workflowId,
      runId: execution.runId,
      workflowType,
      ...(extra ?? {}),
    }
  }

  #runtimeLogFields(extra?: LogFields): LogFields {
    return {
      namespace: this.#namespace,
      taskQueue: this.#taskQueue,
      identity: this.#identity,
      ...(extra ?? {}),
    }
  }

  async #computeNondeterminismMismatches(
    error: WorkflowNondeterminismError,
    expectedState: WorkflowDeterminismState | undefined,
  ): Promise<DeterminismMismatch[]> {
    const baseline: WorkflowDeterminismState = {
      commandHistory: expectedState?.commandHistory ?? [],
      randomValues: expectedState?.randomValues ?? [],
      timeValues: expectedState?.timeValues ?? [],
      failureMetadata: expectedState?.failureMetadata,
      signals: expectedState?.signals ?? [],
      queries: expectedState?.queries ?? [],
    }
    const hint = error.details?.hint
    if (!hint) {
      return []
    }

    const commandIndex = this.#parseIndexFromHint(hint, 'commandIndex')
    const randomIndex = this.#parseIndexFromHint(hint, 'randomIndex')
    const timeIndex = this.#parseIndexFromHint(hint, 'timeIndex')
    const signalIndex = this.#parseIndexFromHint(hint, 'signalIndex')
    const queryIndex = this.#parseIndexFromHint(hint, 'queryIndex')

    const mutableActual: {
      commandHistory: WorkflowCommandHistoryEntry[]
      randomValues: number[]
      timeValues: number[]
      failureMetadata?: WorkflowDeterminismFailureMetadata
      signals: WorkflowDeterminismSignalRecord[]
      queries: WorkflowDeterminismQueryRecord[]
    } = {
      commandHistory: baseline.commandHistory.map((entry) => ({
        intent: entry.intent,
        metadata: entry.metadata ? { ...entry.metadata } : undefined,
      })),
      randomValues: [...baseline.randomValues],
      timeValues: [...baseline.timeValues],
      failureMetadata: baseline.failureMetadata ? { ...baseline.failureMetadata } : undefined,
      signals: baseline.signals.map((record) => ({ ...record })),
      queries: baseline.queries.map((record) => ({ ...record })),
    }
    let mutated = false

    if (commandIndex !== null) {
      const received = error.details?.received as WorkflowCommandIntent | undefined
      if (received) {
        if (commandIndex < mutableActual.commandHistory.length) {
          mutableActual.commandHistory = mutableActual.commandHistory.map((entry, idx) =>
            idx === commandIndex ? { intent: received, metadata: entry.metadata } : entry,
          )
        } else {
          mutableActual.commandHistory = [...mutableActual.commandHistory, { intent: received }]
        }
        mutated = true
      } else if (commandIndex < mutableActual.commandHistory.length) {
        mutableActual.commandHistory = mutableActual.commandHistory.filter((_, idx) => idx !== commandIndex)
        mutated = true
      }
    }

    if (randomIndex !== null) {
      this.#ensureArrayLength(mutableActual.randomValues, randomIndex)
      mutableActual.randomValues[randomIndex] = Number.NaN
      mutated = true
    }

    if (timeIndex !== null) {
      this.#ensureArrayLength(mutableActual.timeValues, timeIndex)
      mutableActual.timeValues[timeIndex] = Number.NaN
      mutated = true
    }

    if (signalIndex !== null) {
      const receivedSignal = this.#asSignalRecord(error.details?.received)
      if (receivedSignal) {
        if (signalIndex < mutableActual.signals.length) {
          mutableActual.signals = mutableActual.signals.map((record, idx) =>
            idx === signalIndex ? receivedSignal : record,
          )
        } else {
          mutableActual.signals = [...mutableActual.signals, receivedSignal]
        }
      } else if (signalIndex < mutableActual.signals.length) {
        mutableActual.signals = mutableActual.signals.filter((_, idx) => idx !== signalIndex)
      }
      mutated = true
    }

    if (queryIndex !== null) {
      const receivedQuery = this.#asQueryRecord(error.details?.received)
      if (receivedQuery) {
        if (queryIndex < mutableActual.queries.length) {
          mutableActual.queries = mutableActual.queries.map((record, idx) =>
            idx === queryIndex ? receivedQuery : record,
          )
        } else {
          mutableActual.queries = [...mutableActual.queries, receivedQuery]
        }
      } else if (queryIndex < mutableActual.queries.length) {
        mutableActual.queries = mutableActual.queries.filter((_, idx) => idx !== queryIndex)
      }
      mutated = true
    }

    if (!mutated) {
      return []
    }

    const actualState: WorkflowDeterminismState = {
      commandHistory: mutableActual.commandHistory,
      randomValues: mutableActual.randomValues,
      timeValues: mutableActual.timeValues,
      failureMetadata: mutableActual.failureMetadata,
      signals: mutableActual.signals,
      queries: mutableActual.queries,
    }

    const diff = await Effect.runPromise(diffDeterminismState(baseline, actualState))
    return diff.mismatches
  }

  #augmentNondeterminismError(
    error: WorkflowNondeterminismError,
    mismatches: DeterminismMismatch[],
    context: NondeterminismContext,
  ): WorkflowNondeterminismError {
    if (mismatches.length === 0) {
      return error
    }
    const details = {
      ...(error.details ?? {}),
      mismatches,
      workflow: {
        namespace: this.#namespace,
        taskQueue: this.#taskQueue,
        workflowId: context.execution.workflowId,
        runId: context.execution.runId,
        workflowType: context.workflowType,
      },
      workflowTaskAttempt: context.workflowTaskAttempt,
      stickyCache: {
        cachedEventId: context.stickyLastEventId ?? undefined,
        historyLastEventId: context.historyLastEventId ?? undefined,
      },
    }
    const enriched = new WorkflowNondeterminismError(error.message, details)
    enriched.stack = error.stack
    return enriched
  }

  #parseIndexFromHint(hint: string, label: string): number | null {
    const pattern = new RegExp(`${label}=(\\d+)`)
    const match = pattern.exec(hint)
    if (!match) {
      return null
    }
    const value = Number.parseInt(match[1] ?? '', 10)
    return Number.isNaN(value) ? null : value
  }

  #ensureArrayLength(array: number[], index: number): void {
    while (array.length <= index) {
      array.push(Number.NaN)
    }
  }

  #asSignalRecord(value: unknown): WorkflowDeterminismSignalRecord | undefined {
    if (!value || typeof value !== 'object') {
      return undefined
    }
    if ('signalName' in value && 'payloadHash' in value) {
      return value as WorkflowDeterminismSignalRecord
    }
    return undefined
  }

  #asQueryRecord(value: unknown): WorkflowDeterminismQueryRecord | undefined {
    if (!value || typeof value !== 'object') {
      return undefined
    }
    if ('queryName' in value && 'requestHash' in value) {
      return value as WorkflowDeterminismQueryRecord
    }
    return undefined
  }

  static #isStickyCacheInstance(value: unknown): value is StickyCache {
    if (!value || typeof value !== 'object') {
      return false
    }
    const candidate = value as Partial<StickyCache>
    return (
      typeof candidate.upsert === 'function' &&
      typeof candidate.get === 'function' &&
      typeof candidate.remove === 'function'
    )
  }

  async #removeStickyEntry(key: StickyCacheKey): Promise<void> {
    await Effect.runPromise(this.#stickyCache.remove(key))
  }

  async #removeStickyEntriesForWorkflow(workflowId: string): Promise<void> {
    if (!workflowId) return
    await Effect.runPromise(this.#stickyCache.removeByWorkflow({ namespace: this.#namespace, workflowId }))
  }

  async #failWorkflowTask(
    response: PollWorkflowTaskQueueResponse,
    execution: { workflowId: string; runId: string },
    error: unknown,
    cause: WorkflowTaskFailedCause = WorkflowTaskFailedCause.UNSPECIFIED,
  ): Promise<void> {
    const failure = await encodeErrorToFailure(this.#dataConverter, error)
    const encoded = await encodeFailurePayloads(this.#dataConverter, failure)

    const failed = create(RespondWorkflowTaskFailedRequestSchema, {
      taskToken: response.taskToken,
      cause,
      failure: encoded,
      identity: this.#identity,
      namespace: this.#namespace,
      deploymentOptions: this.#rpcDeploymentOptions,
    })

    try {
      await this.#workflowService.respondWorkflowTaskFailed(failed, { timeoutMs: RESPOND_TIMEOUT_MS })
      this.#incrementCounter(this.#metrics.workflowFailures)
    } catch (rpcError) {
      if (this.#isTaskNotFoundError(rpcError)) {
        this.#logWorkflowTaskNotFound('respondWorkflowTaskFailed', execution)
        return
      }
      throw rpcError
    }
  }

  async #runActivityTask(response: PollActivityTaskQueueResponse): Promise<void> {
    const context = {
      kind: 'worker.activityTask' as const,
      namespace: this.#namespace,
      taskQueue: this.#taskQueue,
      identity: this.#identity,
      buildId: this.#deploymentOptions.buildId,
      workflowId: response.workflowExecution?.workflowId ?? undefined,
      runId: response.workflowExecution?.runId ?? undefined,
      attempt: Number(response.attempt ?? 1),
    }
    const effect = runWorkerInterceptors(this.#interceptors, context, () =>
      Effect.tryPromise(() => this.#processActivityTask(response)),
    )
    await Effect.runPromise(effect)
  }

  async #processActivityTask(response: PollActivityTaskQueueResponse): Promise<void> {
    const cancelRequested = isActivityCancelRequested(response)

    if (cancelRequested) {
      await this.#cancelActivityTask(response)
      return
    }

    const taskToken = response.taskToken
    if (!taskToken || taskToken.length === 0) {
      await this.#failActivityTask(response, new Error('Activity task missing token'))
      return
    }

    const activityType = response.activityType?.name
    if (!activityType) {
      await this.#failActivityTask(response, new Error('Activity task missing type'))
      return
    }

    const handler = this.#activities[activityType]
    if (!handler) {
      await this.#failActivityTask(response, new Error(`No handler registered for activity ${activityType}`))
      return
    }

    const args = await decodePayloadsToValues(this.#dataConverter, response.input?.payloads ?? [])
    const heartbeatDetails = await decodePayloadsToValues(
      this.#dataConverter,
      response.heartbeatDetails?.payloads ?? [],
    )
    const { context, abortController } = this.#createActivityContext(response, cancelRequested, heartbeatDetails)

    let heartbeatRegistration: ActivityHeartbeatRegistration | undefined
    try {
      heartbeatRegistration = await Effect.runPromise(
        this.#activityLifecycle.registerHeartbeat({
          context,
          workflowService: this.#workflowService,
          taskToken,
          identity: this.#identity,
          namespace: this.#namespace,
          dataConverter: this.#dataConverter,
          abortController,
        }),
      )
      context.heartbeat = async (...details) => {
        context.info.lastHeartbeatDetails = details
        const registration = heartbeatRegistration
        if (!registration) {
          return
        }
        await Effect.runPromise(registration.heartbeat(details))
      }
    } catch (registrationError) {
      this.#log('warn', 'failed to register heartbeat handler', {
        activityType,
        workflowId: context.info.workflowId,
        runId: context.info.runId,
        error: registrationError instanceof Error ? registrationError.message : String(registrationError),
      })
      context.heartbeat = async (...details) => {
        context.info.lastHeartbeatDetails = details
      }
    }

    const retryPolicy = this.#convertRetryPolicy(response.retryPolicy)
    const retryDeadlineMs = this.#computeRetryDeadline(response)
    let retryState: ActivityRetryState = {
      attempt: context.info.attempt,
      retryCount: 0,
      nextDelayMs: 0,
    }

    try {
      while (true) {
        try {
          const result = await runWithActivityContext(context, async () => await handler(...args))
          const payloads = await encodeValuesToPayloads(this.#dataConverter, result === undefined ? [] : [result])
          const completion = create(RespondActivityTaskCompletedRequestSchema, {
            taskToken: response.taskToken,
            identity: this.#identity,
            namespace: this.#namespace,
            result: payloads && payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
            deploymentOptions: this.#rpcDeploymentOptions,
          })
          await this.#workflowService.respondActivityTaskCompleted(completion, { timeoutMs: RESPOND_TIMEOUT_MS })
          break
        } catch (error) {
          if (isAbortError(error)) {
            await this.#cancelActivityTask(response, context)
            return
          }
          if (!retryPolicy || this.#isNonRetryableActivityError(error, retryPolicy)) {
            await this.#failActivityTask(response, error, context)
            return
          }
          const nextRetry = await Effect.runPromise(this.#activityLifecycle.nextRetryDelay(retryPolicy, retryState))
          if (!nextRetry) {
            markErrorNonRetryable(error)
            await this.#failActivityTask(response, error, context)
            return
          }
          if (retryDeadlineMs !== undefined && Date.now() + nextRetry.nextDelayMs > retryDeadlineMs) {
            markErrorNonRetryable(error)
            await this.#failActivityTask(response, error, context)
            return
          }
          await sleep(nextRetry.nextDelayMs)
          context.throwIfCancelled()
          context.info.attempt = nextRetry.attempt
          retryState = nextRetry
        }
      }
    } finally {
      if (heartbeatRegistration) {
        try {
          await Effect.runPromise(heartbeatRegistration.shutdown)
        } catch (shutdownError) {
          this.#log('warn', 'heartbeat shutdown failed', {
            activityType,
            error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
          })
        }
      }
    }
  }

  async #failActivityTask(
    response: PollActivityTaskQueueResponse,
    error: unknown,
    context?: ActivityContext,
  ): Promise<void> {
    const failure = await encodeErrorToFailure(this.#dataConverter, error)
    const encoded = await encodeFailurePayloads(this.#dataConverter, failure)
    const lastHeartbeatDetails = await this.#encodeHeartbeatPayloads(
      context?.info.lastHeartbeatDetails,
      context?.info.cancellationReason,
    )

    const request = create(RespondActivityTaskFailedRequestSchema, {
      taskToken: response.taskToken,
      identity: this.#identity,
      namespace: this.#namespace,
      failure: encoded,
      lastHeartbeatDetails,
      deploymentOptions: this.#rpcDeploymentOptions,
    })

    await this.#workflowService.respondActivityTaskFailed(request, { timeoutMs: RESPOND_TIMEOUT_MS })
    this.#incrementCounter(this.#metrics.activityFailures)
  }

  async #cancelActivityTask(response: PollActivityTaskQueueResponse, context?: ActivityContext): Promise<void> {
    const details = await this.#encodeHeartbeatPayloads(
      context?.info.lastHeartbeatDetails,
      context?.info.cancellationReason,
    )
    const request = create(RespondActivityTaskCanceledRequestSchema, {
      taskToken: response.taskToken,
      identity: this.#identity,
      namespace: this.#namespace,
      details,
      deploymentOptions: this.#rpcDeploymentOptions,
    })

    await this.#workflowService.respondActivityTaskCanceled(request, { timeoutMs: RESPOND_TIMEOUT_MS })
  }

  async #encodeHeartbeatPayloads(details: unknown[] | undefined, reason?: string): Promise<Payloads | undefined> {
    const finalDetails =
      details && details.length > 0
        ? details
        : reason
          ? [
              {
                cancellationReason: reason,
              },
            ]
          : undefined
    if (!finalDetails) {
      return undefined
    }
    const payloads = await encodeValuesToPayloads(this.#dataConverter, finalDetails)
    return payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined
  }

  #createActivityContext(
    response: PollActivityTaskQueueResponse,
    cancelRequested: boolean,
    lastHeartbeatDetails: unknown[],
  ): { context: ActivityContext; abortController: AbortController } {
    const abortController = new AbortController()
    if (cancelRequested) {
      abortController.abort(createActivityAbortError('Activity cancellation requested by Temporal'))
    }

    const info: ActivityInfo = {
      activityId: response.activityId ?? '',
      activityType: response.activityType?.name ?? '',
      workflowNamespace: response.workflowNamespace ?? this.#namespace,
      workflowType: response.workflowType?.name ?? '',
      workflowId: response.workflowExecution?.workflowId ?? '',
      runId: response.workflowExecution?.runId ?? '',
      taskQueue: this.#taskQueue,
      attempt: Number(response.attempt ?? 1),
      isLocal: false,
      scheduledTime: timestampToDate(response.scheduledTime),
      startedTime: timestampToDate(response.startedTime),
      currentAttemptScheduledTime: timestampToDate(response.currentAttemptScheduledTime),
      heartbeatTimeoutMs: durationToMillis(response.heartbeatTimeout),
      scheduleToCloseTimeoutMs: durationToMillis(response.scheduleToCloseTimeout),
      startToCloseTimeoutMs: durationToMillis(response.startToCloseTimeout),
      lastHeartbeatDetails,
      lastHeartbeatTime: undefined,
      cancellationReason: cancelRequested ? 'poll-cancel-requested' : undefined,
    }

    const context: ActivityContext = {
      info,
      cancellationSignal: abortController.signal,
      get isCancellationRequested() {
        return abortController.signal.aborted
      },
      async heartbeat(...details) {
        info.lastHeartbeatDetails = details
      },
      throwIfCancelled() {
        if (!abortController.signal.aborted) {
          return
        }
        const reason = abortController.signal.reason
        if (reason instanceof Error) {
          throw reason
        }
        const error = createActivityAbortError(
          typeof reason === 'string' && reason.length > 0 ? reason : 'Activity cancelled by Temporal',
        )
        throw error
      },
    }

    return { context, abortController }
  }

  #convertRetryPolicy(policy: RetryPolicy | undefined | null): WorkflowRetryPolicyInput | undefined {
    if (!policy) {
      return undefined
    }
    const initialIntervalMs = durationToMillis(policy.initialInterval)
    const maximumIntervalMs = durationToMillis(policy.maximumInterval)
    const backoffCoefficient = policy.backoffCoefficient !== 0 ? policy.backoffCoefficient : undefined
    const maximumAttempts = policy.maximumAttempts > 0 ? policy.maximumAttempts : undefined
    const nonRetryable = policy.nonRetryableErrorTypes.length > 0 ? [...policy.nonRetryableErrorTypes] : undefined

    if (
      initialIntervalMs === undefined &&
      maximumIntervalMs === undefined &&
      backoffCoefficient === undefined &&
      maximumAttempts === undefined &&
      (nonRetryable === undefined || nonRetryable.length === 0)
    ) {
      return undefined
    }

    return {
      ...(initialIntervalMs !== undefined ? { initialIntervalMs } : {}),
      ...(backoffCoefficient !== undefined ? { backoffCoefficient } : {}),
      ...(maximumIntervalMs !== undefined ? { maximumIntervalMs } : {}),
      ...(maximumAttempts !== undefined ? { maximumAttempts } : {}),
      ...(nonRetryable !== undefined ? { nonRetryableErrorTypes: nonRetryable } : {}),
    }
  }

  #isNonRetryableActivityError(error: unknown, retry: WorkflowRetryPolicyInput): boolean {
    if (error && typeof error === 'object' && (error as { nonRetryable?: boolean }).nonRetryable === true) {
      return true
    }
    const errorName = error instanceof Error ? error.name : undefined
    if (!errorName) {
      return false
    }
    return Boolean(retry.nonRetryableErrorTypes?.includes(errorName))
  }

  #computeRetryDeadline(response: PollActivityTaskQueueResponse): number | undefined {
    const scheduleToClose = durationToMillis(response.scheduleToCloseTimeout)
    const startToClose = durationToMillis(response.startToCloseTimeout)
    const scheduledTime = timestampToDate(response.scheduledTime)
    const startedTime = timestampToDate(response.startedTime) ?? scheduledTime
    const scheduleDeadline = scheduleToClose && scheduledTime ? scheduledTime.getTime() + scheduleToClose : undefined
    const startDeadline = startToClose && startedTime ? startedTime.getTime() + startToClose : undefined
    if (scheduleDeadline && startDeadline) {
      return Math.min(scheduleDeadline, startDeadline)
    }
    return scheduleDeadline ?? startDeadline ?? undefined
  }

  async #flushMetrics(): Promise<void> {
    if (this.#metricsFlushInFlight) {
      return
    }
    this.#metricsFlushInFlight = true
    try {
      await Effect.runPromise(this.#metricsExporter.flush())
    } catch (error) {
      this.#log('warn', 'failed to flush metrics exporter', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.#metricsFlushInFlight = false
    }
  }

  async #decodeWorkflowArgs(events: HistoryEvent[]): Promise<unknown[]> {
    const startEvent = this.#findWorkflowStartedEvent(events)
    if (!startEvent) {
      return []
    }
    const attributes =
      startEvent.attributes?.case === 'workflowExecutionStartedEventAttributes'
        ? startEvent.attributes.value
        : undefined
    if (!attributes) {
      return []
    }
    const inputPayloads = attributes.input?.payloads ?? []
    return await decodePayloadsToValues(this.#dataConverter, inputPayloads)
  }

  #resolveWorkflowType(response: PollWorkflowTaskQueueResponse, events: HistoryEvent[]): string {
    if (response.workflowType?.name) {
      return response.workflowType.name
    }
    const startEvent = this.#findWorkflowStartedEvent(events)
    if (startEvent?.attributes?.case === 'workflowExecutionStartedEventAttributes') {
      const workflowTypeName = startEvent.attributes.value.workflowType?.name
      if (workflowTypeName) {
        return workflowTypeName
      }
    }
    throw new Error('Unable to resolve workflow type from workflow task')
  }

  #resolveWorkflowExecution(response: PollWorkflowTaskQueueResponse): { workflowId: string; runId: string } {
    const workflowId = response.workflowExecution?.workflowId ?? ''
    const runId = response.workflowExecution?.runId ?? ''
    return { workflowId, runId }
  }

  #findWorkflowStartedEvent(events: HistoryEvent[]): HistoryEvent | undefined {
    return events.find(
      (event) =>
        event.eventType === EventType.WORKFLOW_EXECUTION_STARTED &&
        event.attributes?.case === 'workflowExecutionStartedEventAttributes',
    )
  }

  #hasActivities(): boolean {
    return Object.keys(this.#activities).length > 0
  }

  #logWorkflowTaskNotFound(context: string, execution: { workflowId: string; runId: string }): void {
    this.#log('warn', 'workflow task already resolved', {
      context,
      workflowId: execution.workflowId,
      runId: execution.runId,
    })
  }
}

const timestampToDate = (timestamp: Timestamp | undefined | null): Date | undefined => {
  if (!timestamp) {
    return undefined
  }
  const seconds = Number(timestamp.seconds ?? 0n)
  const nanos = timestamp.nanos ?? 0
  return new Date(seconds * 1000 + Math.trunc(nanos / 1_000_000))
}

const createActivityAbortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const markErrorNonRetryable = (error: unknown): void => {
  if (error && typeof error === 'object') {
    ;(error as { nonRetryable?: boolean }).nonRetryable = true
  }
}

const isActivityCancelRequested = (response: PollActivityTaskQueueResponse): boolean =>
  Boolean((response as { cancelRequested?: boolean }).cancelRequested)

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

async function loadWorkflows(
  workflowsPath?: string,
  overrides?: WorkflowDefinitions,
): Promise<WorkflowDefinition<unknown, unknown>[]> {
  if (overrides && overrides.length > 0) {
    return [...overrides] as WorkflowDefinition<unknown, unknown>[]
  }
  if (!workflowsPath) {
    return []
  }

  const moduleUrl = pathToFileURL(workflowsPath)
  const loaded = await import(moduleUrl.href)
  const exported = (loaded.workflows ?? loaded.default) as unknown

  if (Array.isArray(exported)) {
    return exported as WorkflowDefinition<unknown, unknown>[]
  }

  return []
}
