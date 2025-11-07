import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { create } from '@bufbuild/protobuf'
import { Code, ConnectError, createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Effect } from 'effect'

import { buildTransportOptions, normalizeTemporalAddress } from '../client'
import {
  createDefaultDataConverter,
  type DataConverter,
  decodePayloadsToValues,
  encodeValuesToPayloads,
} from '../common/payloads/converter'
import { encodeErrorToFailure, encodeFailurePayloads } from '../common/payloads/failure'
import { loadTemporalConfig, type TemporalConfig } from '../config'
import {
  type Command,
  CommandSchema,
  RecordMarkerCommandAttributesSchema,
} from '../proto/temporal/api/command/v1/message_pb'
import { type Payloads, PayloadsSchema } from '../proto/temporal/api/common/v1/message_pb'
import {
  type WorkerDeploymentOptions,
  WorkerDeploymentOptionsSchema,
} from '../proto/temporal/api/deployment/v1/message_pb'
import { CommandType } from '../proto/temporal/api/enums/v1/command_type_pb'
import { WorkerVersioningMode } from '../proto/temporal/api/enums/v1/deployment_pb'
import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { WorkflowTaskFailedCause } from '../proto/temporal/api/enums/v1/failed_cause_pb'
import { VersioningBehavior } from '../proto/temporal/api/enums/v1/workflow_pb'
import type { HistoryEvent } from '../proto/temporal/api/history/v1/message_pb'
import {
  type StickyExecutionAttributes,
  StickyExecutionAttributesSchema,
  TaskQueueSchema,
} from '../proto/temporal/api/taskqueue/v1/message_pb'
import {
  PollActivityTaskQueueRequestSchema,
  type PollActivityTaskQueueResponse,
  PollWorkflowTaskQueueRequestSchema,
  type PollWorkflowTaskQueueResponse,
  RespondActivityTaskCanceledRequestSchema,
  RespondActivityTaskCompletedRequestSchema,
  RespondActivityTaskFailedRequestSchema,
  RespondWorkflowTaskCompletedRequestSchema,
  RespondWorkflowTaskFailedRequestSchema,
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from '../proto/temporal/api/workflowservice/v1/service_pb'
import { durationFromMillis } from '../workflow/commands'
import type { WorkflowInfo } from '../workflow/context'
import type { WorkflowDefinition, WorkflowDefinitions } from '../workflow/definition'
import type { WorkflowDeterminismState } from '../workflow/determinism'
import { WorkflowNondeterminismError } from '../workflow/errors'
import { WorkflowExecutor } from '../workflow/executor'
import { WorkflowRegistry } from '../workflow/registry'
import { DETERMINISM_MARKER_NAME, encodeDeterminismMarkerDetails, resolveHistoryLastEventId } from '../workflow/replay'
import { type ActivityContext, type ActivityInfo, runWithActivityContext } from './activity-context'
import {
  type ActivityTaskEnvelope,
  makeWorkerScheduler,
  type WorkerScheduler,
  type WorkerSchedulerHooks,
  type WorkflowTaskEnvelope,
} from './concurrency'
import { makeStickyCache, type StickyCache, type StickyCacheEntry, type StickyCacheKey } from './sticky-cache'

type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>

const POLL_TIMEOUT_MS = 60_000
const RESPOND_TIMEOUT_MS = 15_000
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
  concurrency?: WorkerConcurrencyOptions
  stickyCache?: WorkerStickyCacheOptions
  stickyScheduling?: boolean
  deployment?: WorkerDeploymentConfig
  schedulerHooks?: WorkerSchedulerHooks
}

export class WorkerRuntime {
  // TODO(TBS-010): Refactor WorkerRuntime to consume Effect Layers (Config, Logger, Metrics,
  // WorkflowService, StickyCache, Scheduler) instead of manual promise orchestration.
  static async create(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
    const config = options.config ?? (await loadTemporalConfig())
    const dataConverter = options.dataConverter ?? createDefaultDataConverter()

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

    const registry = new WorkflowRegistry()
    registry.registerMany(workflows)
    const executor = new WorkflowExecutor({
      registry,
      dataConverter,
      bypassDeterministicContext: config.workflowContextBypass,
    })

    const activities = options.activities ?? {}
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

    const scheduler = await Effect.runPromise(
      makeWorkerScheduler({
        workflowConcurrency,
        activityConcurrency,
        hooks: options.schedulerHooks,
      }),
    )

    const stickyCacheSize = options.stickyCache?.size ?? config.workerStickyCacheSize
    const stickyCacheTtlMs = options.stickyCache?.ttlMs ?? config.workerStickyTtlMs
    const stickyCache = await Effect.runPromise(
      makeStickyCache({
        maxEntries: stickyCacheSize,
        ttlMs: stickyCacheTtlMs,
      }),
    )

    const stickyQueue = WorkerRuntime.#buildStickyQueueName(taskQueue, identity)
    const stickyScheduleToStartTimeoutMs = stickyCacheTtlMs
    const stickySchedulingEnabled = options.stickyScheduling ?? stickyCacheSize > 0

    const deploymentName =
      options.deployment?.name ?? config.workerDeploymentName ?? WorkerRuntime.#defaultDeploymentName(taskQueue)
    const buildId = options.deployment?.buildId ?? config.workerBuildId ?? identity
    const workerVersioningMode = options.deployment?.versioningMode ?? WorkerVersioningMode.VERSIONED
    const versioningBehavior =
      workerVersioningMode === WorkerVersioningMode.VERSIONED
        ? (options.deployment?.versioningBehavior ?? VersioningBehavior.PINNED)
        : null
    const deploymentOptions = create(WorkerDeploymentOptionsSchema, {
      deploymentName,
      buildId,
      workerVersioningMode,
    })

    return new WorkerRuntime({
      config,
      workflowService,
      dataConverter,
      registry,
      executor,
      activities,
      namespace,
      taskQueue,
      identity,
      scheduler,
      stickyCache,
      stickyQueue,
      stickyScheduleToStartTimeoutMs,
      deploymentOptions,
      versioningBehavior,
      stickySchedulingEnabled,
    })
  }

  readonly #config: TemporalConfig
  readonly #workflowService: ReturnType<typeof createClient<typeof WorkflowService>>
  readonly #dataConverter: DataConverter
  readonly #registry: WorkflowRegistry
  readonly #executor: WorkflowExecutor
  readonly #activities: Record<string, ActivityHandler>
  readonly #namespace: string
  readonly #taskQueue: string
  readonly #identity: string
  readonly #scheduler: WorkerScheduler
  readonly #stickyCache: StickyCache
  readonly #stickyQueue: string
  readonly #stickySchedulingEnabled: boolean
  readonly #stickyAttributes: StickyExecutionAttributes
  readonly #deploymentOptions: WorkerDeploymentOptions
  readonly #versioningBehavior: VersioningBehavior | null
  #running = false
  #abortController: AbortController | null = null
  #runPromise: Promise<void> | null = null
  #schedulerStarted = false
  #schedulerStopPromise: Promise<void> | null = null

  private constructor(params: {
    config: TemporalConfig
    workflowService: ReturnType<typeof createClient<typeof WorkflowService>>
    dataConverter: DataConverter
    registry: WorkflowRegistry
    executor: WorkflowExecutor
    activities: Record<string, ActivityHandler>
    namespace: string
    taskQueue: string
    identity: string
    scheduler: WorkerScheduler
    stickyCache: StickyCache
    stickyQueue: string
    stickyScheduleToStartTimeoutMs: number
    deploymentOptions: WorkerDeploymentOptions
    versioningBehavior: VersioningBehavior | null
    stickySchedulingEnabled: boolean
  }) {
    this.#config = params.config
    this.#workflowService = params.workflowService
    this.#dataConverter = params.dataConverter
    this.#registry = params.registry
    this.#executor = params.executor
    this.#activities = params.activities
    this.#namespace = params.namespace
    this.#taskQueue = params.taskQueue
    this.#identity = params.identity
    this.#scheduler = params.scheduler
    this.#stickyCache = params.stickyCache
    this.#stickyQueue = params.stickyQueue
    this.#stickySchedulingEnabled = params.stickySchedulingEnabled
    this.#deploymentOptions = params.deploymentOptions
    this.#versioningBehavior = params.versioningBehavior
    this.#stickyAttributes = create(StickyExecutionAttributesSchema, {
      workerTaskQueue: create(TaskQueueSchema, { name: this.#stickyQueue }),
      scheduleToStartTimeout: durationFromMillis(params.stickyScheduleToStartTimeoutMs),
    })
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

  async run(): Promise<void> {
    if (this.#running) {
      return this.#runPromise ?? Promise.resolve()
    }
    this.#running = true
    this.#abortController = new AbortController()
    const signal = this.#abortController.signal

    try {
      await this.#startScheduler()
    } catch (error) {
      this.#running = false
      this.#abortController = null
      throw error
    }

    const execution = (async () => {
      try {
        await Promise.all([this.#workflowLoop(signal), this.#activityLoop(signal)])
      } finally {
        await this.#stopScheduler()
        this.#abortController = null
        this.#running = false
      }
    })()

    this.#runPromise = execution

    await this.#runPromise
  }

  async shutdown(): Promise<void> {
    if (!this.#running) {
      await this.#stopScheduler()
      return
    }
    this.#abortController?.abort()
    if (this.#runPromise) {
      try {
        await this.#runPromise
      } catch {
        // ignore failures during shutdown; polling loops log errors before exiting
      }
    } else {
      await this.#stopScheduler()
    }
  }

  async #startScheduler(): Promise<void> {
    if (this.#schedulerStarted) {
      return
    }
    await Effect.runPromise(this.#scheduler.start)
    this.#schedulerStarted = true
  }

  async #stopScheduler(): Promise<void> {
    if (!this.#schedulerStarted) {
      return
    }
    if (!this.#schedulerStopPromise) {
      this.#schedulerStopPromise = Effect.runPromise(this.#scheduler.stop).finally(() => {
        this.#schedulerStarted = false
        this.#schedulerStopPromise = null
      })
    }
    await this.#schedulerStopPromise
  }

  async #workflowLoop(signal: AbortSignal): Promise<void> {
    const request = create(PollWorkflowTaskQueueRequestSchema, {
      namespace: this.#namespace,
      taskQueue: create(TaskQueueSchema, { name: this.#taskQueue }),
      identity: this.#identity,
      deploymentOptions: this.#deploymentOptions,
    })

    while (!signal.aborted) {
      try {
        const response = await this.#workflowService.pollWorkflowTaskQueue(request, {
          timeoutMs: POLL_TIMEOUT_MS,
          signal,
        })
        if (!response.taskToken || response.taskToken.length === 0) {
          continue
        }
        await this.#enqueueWorkflowTask(response)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        console.error('[temporal-bun-sdk] workflow polling failed', error)
        await delay(250)
      }
    }
  }

  async #enqueueWorkflowTask(response: PollWorkflowTaskQueueResponse): Promise<void> {
    const taskToken = response.taskToken ?? new Uint8Array()
    const envelope: WorkflowTaskEnvelope = {
      taskToken,
      execute: () =>
        Effect.promise(async () => {
          await this.#handleWorkflowTask(response)
        }),
    }
    await Effect.runPromise(this.#scheduler.enqueueWorkflow(envelope))
  }

  async #activityLoop(signal: AbortSignal): Promise<void> {
    if (!this.#hasActivities()) {
      return
    }

    const request = create(PollActivityTaskQueueRequestSchema, {
      namespace: this.#namespace,
      taskQueue: create(TaskQueueSchema, { name: this.#taskQueue }),
      identity: this.#identity,
      deploymentOptions: this.#deploymentOptions,
    })

    while (!signal.aborted) {
      try {
        const response = await this.#workflowService.pollActivityTaskQueue(request, {
          timeoutMs: POLL_TIMEOUT_MS,
          signal,
        })
        if (!response.taskToken || response.taskToken.length === 0) {
          continue
        }
        await this.#enqueueActivityTask(response)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        console.error('[temporal-bun-sdk] activity polling failed', error)
        await delay(250)
      }
    }
  }

  async #enqueueActivityTask(response: PollActivityTaskQueueResponse): Promise<void> {
    const taskToken = response.taskToken ?? new Uint8Array()
    const envelope: ActivityTaskEnvelope = {
      taskToken,
      handler: () => this.#processActivityTask(response),
      args: [],
    }
    await Effect.runPromise(this.#scheduler.enqueueActivity(envelope))
  }

  async #handleWorkflowTask(response: PollWorkflowTaskQueueResponse): Promise<void> {
    const workflowType = this.#resolveWorkflowType(response)
    const args = await this.#decodeWorkflowArgs(response)
    const execution = this.#resolveWorkflowExecution(response)
    const workflowInfo = this.#buildWorkflowInfo(workflowType, execution)
    const stickyKey = this.#buildStickyKey(execution.workflowId, execution.runId)
    const stickyEntry = stickyKey ? await this.#getStickyEntry(stickyKey) : undefined
    const previousState = stickyEntry?.determinismState

    try {
      const output = await this.#executor.execute({
        workflowType,
        workflowId: execution.workflowId,
        runId: execution.runId,
        namespace: this.#namespace,
        taskQueue: this.#taskQueue,
        arguments: args,
        determinismState: previousState,
      })

      const lastEventId = this.#resolveWorkflowHistoryLastEventId(response)
      const markerDetails = await Effect.runPromise(
        encodeDeterminismMarkerDetails(this.#dataConverter, {
          info: workflowInfo,
          determinismState: output.determinismState,
          lastEventId,
        }),
      )
      const markerCommand = this.#buildDeterminismMarkerCommand(markerDetails)
      const commandsWithMarker = this.#injectDeterminismMarker(output.commands, markerCommand)

      if (stickyKey) {
        if (output.completion === 'pending') {
          await this.#upsertStickyEntry(stickyKey, output.determinismState, lastEventId)
        } else {
          await this.#removeStickyEntry(stickyKey)
        }
      }

      const completion = create(RespondWorkflowTaskCompletedRequestSchema, {
        taskToken: response.taskToken,
        commands: commandsWithMarker,
        identity: this.#identity,
        namespace: this.#namespace,
        deploymentOptions: this.#deploymentOptions,
        ...(this.#stickySchedulingEnabled ? { stickyAttributes: this.#stickyAttributes } : {}),
        ...(this.#versioningBehavior !== null ? { versioningBehavior: this.#versioningBehavior } : {}),
      })
      await this.#workflowService.respondWorkflowTaskCompleted(completion, { timeoutMs: RESPOND_TIMEOUT_MS })
    } catch (error) {
      if (stickyKey) {
        await this.#removeStickyEntry(stickyKey)
      }
      if (this.#isTaskNotFoundError(error)) {
        return
      }
      if (error instanceof WorkflowNondeterminismError) {
        await this.#failWorkflowTask(response, error, WorkflowTaskFailedCause.NON_DETERMINISTIC_ERROR)
        return
      }
      await this.#failWorkflowTask(response, error)
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
  ): Promise<void> {
    const entry: StickyCacheEntry = {
      key,
      determinismState: state,
      lastEventId,
      lastAccessed: Date.now(),
    }
    await Effect.runPromise(this.#stickyCache.upsert(entry))
  }

  #resolveWorkflowHistoryLastEventId(response: PollWorkflowTaskQueueResponse): string | null {
    return resolveHistoryLastEventId(response.history?.events ?? [])
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
    const next = [...commands]
    const existingIndex = next.findIndex((command) => this.#isDeterminismMarkerCommand(command))
    if (existingIndex !== -1) {
      next.splice(existingIndex, 1)
    }
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

  async #removeStickyEntry(key: StickyCacheKey): Promise<void> {
    await Effect.runPromise(this.#stickyCache.remove(key))
  }

  async #failWorkflowTask(
    response: PollWorkflowTaskQueueResponse,
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
      deploymentOptions: this.#deploymentOptions,
    })

    try {
      await this.#workflowService.respondWorkflowTaskFailed(failed, { timeoutMs: RESPOND_TIMEOUT_MS })
    } catch (rpcError) {
      if (this.#isTaskNotFoundError(rpcError)) {
        return
      }
      throw rpcError
    }
  }

  async #processActivityTask(response: PollActivityTaskQueueResponse): Promise<void> {
    const cancelRequested = isActivityCancelRequested(response)

    if (cancelRequested) {
      await this.#cancelActivityTask(response)
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
    const context = this.#createActivityContext(response, cancelRequested)

    try {
      const result = await runWithActivityContext(context, async () => await handler(...args))
      const payloads = await encodeValuesToPayloads(this.#dataConverter, result === undefined ? [] : [result])
      const completion = create(RespondActivityTaskCompletedRequestSchema, {
        taskToken: response.taskToken,
        identity: this.#identity,
        namespace: this.#namespace,
        result: payloads && payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
        deploymentOptions: this.#deploymentOptions,
      })
      await this.#workflowService.respondActivityTaskCompleted(completion, { timeoutMs: RESPOND_TIMEOUT_MS })
    } catch (error) {
      if (isAbortError(error)) {
        await this.#cancelActivityTask(response)
        return
      }
      await this.#failActivityTask(response, error)
    }
  }

  async #failActivityTask(response: PollActivityTaskQueueResponse, error: unknown): Promise<void> {
    const failure = await encodeErrorToFailure(this.#dataConverter, error)
    const encoded = await encodeFailurePayloads(this.#dataConverter, failure)

    const request = create(RespondActivityTaskFailedRequestSchema, {
      taskToken: response.taskToken,
      identity: this.#identity,
      namespace: this.#namespace,
      failure: encoded,
      deploymentOptions: this.#deploymentOptions,
    })

    await this.#workflowService.respondActivityTaskFailed(request, { timeoutMs: RESPOND_TIMEOUT_MS })
  }

  async #cancelActivityTask(response: PollActivityTaskQueueResponse): Promise<void> {
    const request = create(RespondActivityTaskCanceledRequestSchema, {
      taskToken: response.taskToken,
      identity: this.#identity,
      namespace: this.#namespace,
      deploymentOptions: this.#deploymentOptions,
    })

    await this.#workflowService.respondActivityTaskCanceled(request, { timeoutMs: RESPOND_TIMEOUT_MS })
  }

  #createActivityContext(response: PollActivityTaskQueueResponse, cancelRequested: boolean): ActivityContext {
    const abortController = new AbortController()
    if (cancelRequested) {
      abortController.abort()
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
      scheduledTime: response.scheduledTime ? new Date(Number(response.scheduledTime.seconds) * 1000) : undefined,
      startedTime: response.startedTime ? new Date(Number(response.startedTime.seconds) * 1000) : undefined,
      currentAttemptScheduledTime: response.currentAttemptScheduledTime
        ? new Date(Number(response.currentAttemptScheduledTime.seconds) * 1000)
        : undefined,
      heartbeatTimeoutMs: undefined,
      scheduleToCloseTimeoutMs: undefined,
      startToCloseTimeoutMs: undefined,
      lastHeartbeatDetails: [],
    }

    return {
      info,
      cancellationSignal: abortController.signal,
      get isCancellationRequested() {
        return abortController.signal.aborted
      },
      async heartbeat() {
        // Heartbeats are not yet implemented in the pure TypeScript runtime.
      },
      throwIfCancelled() {
        if (abortController.signal.aborted) {
          const error = new Error('Activity cancelled')
          error.name = 'AbortError'
          throw error
        }
      },
    }
  }

  async #decodeWorkflowArgs(response: PollWorkflowTaskQueueResponse): Promise<unknown[]> {
    const startEvent = this.#findWorkflowStartedEvent(response.history?.events ?? [])
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

  #resolveWorkflowType(response: PollWorkflowTaskQueueResponse): string {
    if (response.workflowType?.name) {
      return response.workflowType.name
    }
    const startEvent = this.#findWorkflowStartedEvent(response.history?.events ?? [])
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
