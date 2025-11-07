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
import { type Payloads, PayloadsSchema, WorkflowExecutionSchema } from '../proto/temporal/api/common/v1/message_pb'
import { CommandType } from '../proto/temporal/api/enums/v1/command_type_pb'
import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { WorkflowTaskFailedCause } from '../proto/temporal/api/enums/v1/failed_cause_pb'
import { HistoryEventFilterType } from '../proto/temporal/api/enums/v1/workflow_pb'
import type { HistoryEvent } from '../proto/temporal/api/history/v1/message_pb'
import { StickyExecutionAttributesSchema, TaskQueueSchema } from '../proto/temporal/api/taskqueue/v1/message_pb'
import {
  GetWorkflowExecutionHistoryRequestSchema,
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
import type { WorkflowCommandIntent } from '../workflow/commands'
import { durationFromMillis } from '../workflow/commands'
import type { WorkflowInfo } from '../workflow/context'
import type { WorkflowDefinition, WorkflowDefinitions } from '../workflow/definition'
import type { WorkflowDeterminismState } from '../workflow/determinism'
import { WorkflowNondeterminismError } from '../workflow/errors'
import { WorkflowExecutor } from '../workflow/executor'
import { WorkflowRegistry } from '../workflow/registry'
import type { DeterminismMismatch } from '../workflow/replay'
import {
  DETERMINISM_MARKER_NAME,
  diffDeterminismState,
  encodeDeterminismMarkerDetails,
  ingestWorkflowHistory,
} from '../workflow/replay'
import { type ActivityContext, type ActivityInfo, runWithActivityContext } from './activity-context'
import { makeStickyCache, type StickyCache, type StickyCacheEntry, type StickyCacheKey } from './sticky-cache'

type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>

const POLL_TIMEOUT_MS = 60_000
const RESPOND_TIMEOUT_MS = 15_000
const HISTORY_FETCH_TIMEOUT_MS = 60_000
const COMPLETION_COMMAND_TYPES = new Set<CommandType>([
  CommandType.COMPLETE_WORKFLOW_EXECUTION,
  CommandType.FAIL_WORKFLOW_EXECUTION,
  CommandType.CONTINUE_AS_NEW_WORKFLOW_EXECUTION,
])

export type { WorkflowServiceClient }

export type ActivityHandler = (...args: unknown[]) => unknown | Promise<unknown>

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
  stickyCache?: StickyCache
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

    let workflowService: WorkflowServiceClient
    if (options.workflowService) {
      workflowService = options.workflowService
    } else {
      const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
      const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
      const transport = createGrpcTransport(buildTransportOptions(baseUrl, config))
      workflowService = createClient(WorkflowService, transport)
    }

    const stickyCache =
      options.stickyCache ??
      (await Effect.runPromise(makeStickyCache({ maxEntries: config.stickyCacheSize, ttlMs: config.stickyCacheTtlMs })))

    return new WorkerRuntime({
      config,
      workflowService,
      dataConverter,
      registry,
      executor,
      activities: options.activities ?? {},
      namespace,
      taskQueue,
      identity,
      stickyCache,
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
  readonly #stickyCache: StickyCache
  readonly #stickyTaskQueue: string
  #running = false
  #abortController: AbortController | null = null
  #runPromise: Promise<void> | null = null

  #isStickyExecutionEnabled(): boolean {
    return this.#config.stickyCacheSize > 0
  }

  #isValidDeterminismSnapshot(state: WorkflowDeterminismState): boolean {
    return state.commandHistory.length > 0 || state.randomValues.length > 0 || state.timeValues.length > 0
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
    stickyCache: StickyCache
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
    this.#stickyCache = params.stickyCache
    this.#stickyTaskQueue = `${this.#taskQueue}::sticky::${this.#identity}`
  }

  async run(): Promise<void> {
    if (this.#running) {
      return this.#runPromise ?? Promise.resolve()
    }
    this.#running = true
    this.#abortController = new AbortController()
    const signal = this.#abortController.signal

    const loops: Array<Promise<void>> = [this.#workflowLoop(signal), this.#activityLoop(signal)]
    if (this.#isStickyExecutionEnabled()) {
      loops.unshift(this.#stickyWorkflowLoop(signal))
    }
    this.#runPromise = Promise.all(loops).then(() => undefined)

    await this.#runPromise
  }

  async shutdown(): Promise<void> {
    if (!this.#running) {
      return
    }
    this.#running = false
    this.#abortController?.abort()
    if (this.#runPromise) {
      await this.#runPromise
    }
  }

  async #workflowLoop(signal: AbortSignal): Promise<void> {
    const request = create(PollWorkflowTaskQueueRequestSchema, {
      namespace: this.#namespace,
      taskQueue: create(TaskQueueSchema, { name: this.#taskQueue }),
      identity: this.#identity,
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
        await this.#processWorkflowTask(response)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        console.error('[temporal-bun-sdk] workflow polling failed', error)
        await delay(250)
      }
    }
  }

  async #stickyWorkflowLoop(signal: AbortSignal): Promise<void> {
    if (!this.#isStickyExecutionEnabled()) {
      return
    }

    const request = create(PollWorkflowTaskQueueRequestSchema, {
      namespace: this.#namespace,
      taskQueue: create(TaskQueueSchema, { name: this.#stickyTaskQueue }),
      identity: this.#identity,
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
        await this.#processWorkflowTask(response)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        console.error('[temporal-bun-sdk] sticky workflow polling failed', error)
        await delay(250)
      }
    }
  }

  async #activityLoop(signal: AbortSignal): Promise<void> {
    if (!this.#hasActivities()) {
      return
    }

    const request = create(PollActivityTaskQueueRequestSchema, {
      namespace: this.#namespace,
      taskQueue: create(TaskQueueSchema, { name: this.#taskQueue }),
      identity: this.#identity,
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
        await this.#processActivityTask(response)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        console.error('[temporal-bun-sdk] activity polling failed', error)
        await delay(250)
      }
    }
  }

  async #processWorkflowTask(response: PollWorkflowTaskQueueResponse): Promise<void> {
    const workflowType = this.#resolveWorkflowType(response)
    const args = await this.#decodeWorkflowArgs(response)
    const execution = this.#resolveWorkflowExecution(response)
    const workflowInfo: WorkflowInfo = {
      namespace: this.#namespace,
      taskQueue: this.#taskQueue,
      workflowId: execution.workflowId,
      runId: execution.runId,
      workflowType,
    }
    const stickyExecutionEnabled = this.#isStickyExecutionEnabled()
    const stickyKey = stickyExecutionEnabled ? this.#buildStickyKey(execution.workflowId, execution.runId) : null
    const historyEvents = await this.#collectWorkflowHistory(response, execution)

    const replay = await Effect.runPromise(
      ingestWorkflowHistory({
        info: workflowInfo,
        history: historyEvents,
        dataConverter: this.#dataConverter,
      }),
    )

    let determinismState: WorkflowDeterminismState | undefined
    let cachedEntry: StickyCacheEntry | undefined

    if (stickyExecutionEnabled && stickyKey) {
      cachedEntry = await Effect.runPromise(this.#stickyCache.get(stickyKey))
      if (cachedEntry) {
        const historyBaselineEventId = this.#resolvePreviousHistoryEventId(response) ?? replay.lastEventId ?? null
        const cacheMatchesHistory = (cachedEntry.lastEventId ?? null) === historyBaselineEventId

        if (cacheMatchesHistory) {
          determinismState = cachedEntry.determinismState
        } else {
          // If the cache diverges from history prefer the history snapshot and allow the diff
          // to surface additional diagnostics to the operator.
          const diff = await Effect.runPromise(
            diffDeterminismState(cachedEntry.determinismState, replay.determinismState),
          )
          if (diff.mismatches.length > 0) {
            console.warn('[temporal-bun-sdk] sticky cache determinism snapshot drift detected', diff.mismatches)
          }
          if (this.#isValidDeterminismSnapshot(replay.determinismState)) {
            determinismState = replay.determinismState
          } else {
            determinismState = undefined
          }
        }
      }
    }

    if (!determinismState && this.#isValidDeterminismSnapshot(replay.determinismState)) {
      determinismState = replay.determinismState
    }

    const expectedDeterminismState = determinismState

    try {
      const output = await this.#executor.execute({
        workflowType,
        workflowId: execution.workflowId,
        runId: execution.runId,
        namespace: this.#namespace,
        taskQueue: this.#taskQueue,
        arguments: args,
        determinismState,
      })

      const markerDetails = await Effect.runPromise(
        encodeDeterminismMarkerDetails(this.#dataConverter, {
          info: workflowInfo,
          determinismState: output.determinismState,
          lastEventId: replay.lastEventId,
        }),
      )
      const markerCommand = this.#buildDeterminismMarkerCommand(markerDetails)
      const commandsWithMarker = this.#injectDeterminismMarker(output.commands, markerCommand)

      const stickyAttributes = stickyExecutionEnabled ? this.#buildStickyAttributes() : undefined
      const completion = create(RespondWorkflowTaskCompletedRequestSchema, {
        taskToken: response.taskToken,
        commands: commandsWithMarker,
        identity: this.#identity,
        namespace: this.#namespace,
        ...(stickyAttributes ? { stickyAttributes } : {}),
      })
      let taskTokenInvalid = false
      try {
        await this.#workflowService.respondWorkflowTaskCompleted(completion, { timeoutMs: RESPOND_TIMEOUT_MS })
      } catch (error) {
        if (this.#isWorkflowTaskNotFoundError(error)) {
          taskTokenInvalid = true
          this.#logWorkflowTaskNotFound('respondWorkflowTaskCompleted', execution)
        } else {
          throw error
        }
      }

      const cacheBaselineEventId = this.#resolveCurrentStartedEventId(response) ?? replay.lastEventId ?? null

      if (stickyExecutionEnabled && stickyKey) {
        const shouldEvict =
          taskTokenInvalid ||
          output.completion === 'completed' ||
          output.completion === 'failed' ||
          output.completion === 'continued-as-new'

        if (shouldEvict) {
          await Effect.runPromise(this.#stickyCache.remove(stickyKey))
        } else {
          await Effect.runPromise(
            this.#stickyCache.upsert({
              key: stickyKey,
              determinismState: output.determinismState,
              lastEventId: cacheBaselineEventId,
              lastAccessed: Date.now(),
            }),
          )
        }
      }

      if (taskTokenInvalid) {
        return
      }
    } catch (error) {
      if (stickyExecutionEnabled && stickyKey) {
        await Effect.runPromise(this.#stickyCache.remove(stickyKey))
      }
      if (error instanceof WorkflowNondeterminismError) {
        const mismatches = await this.#computeNondeterminismMismatches(error, expectedDeterminismState)
        const enriched = this.#augmentNondeterminismError(error, mismatches)
        await this.#failWorkflowTask(response, execution, enriched, WorkflowTaskFailedCause.NON_DETERMINISTIC_ERROR)
        return
      }
      await this.#failWorkflowTask(response, execution, error)
    }
  }

  async #collectWorkflowHistory(
    response: PollWorkflowTaskQueueResponse,
    execution: { workflowId: string; runId: string },
  ): Promise<HistoryEvent[]> {
    const events: HistoryEvent[] = [...(response.history?.events ?? [])]
    let token = response.nextPageToken ?? new Uint8Array()

    if (!token || token.length === 0) {
      return events
    }

    while (token.length > 0) {
      const historyRequest = create(GetWorkflowExecutionHistoryRequestSchema, {
        namespace: this.#namespace,
        execution: create(WorkflowExecutionSchema, {
          workflowId: execution.workflowId,
          runId: execution.runId,
        }),
        maximumPageSize: 0,
        nextPageToken: token,
        waitNewEvent: false,
        historyEventFilterType: HistoryEventFilterType.ALL_EVENT,
        skipArchival: true,
      })

      const historyResponse = await this.#workflowService.getWorkflowExecutionHistory(historyRequest, {
        timeoutMs: HISTORY_FETCH_TIMEOUT_MS,
      })

      if (historyResponse.history?.events) {
        events.push(...historyResponse.history.events)
      }

      token = historyResponse.nextPageToken ?? new Uint8Array()
    }

    return events
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
    })

    try {
      await this.#workflowService.respondWorkflowTaskFailed(failed, { timeoutMs: RESPOND_TIMEOUT_MS })
    } catch (respondError) {
      if (this.#isWorkflowTaskNotFoundError(respondError)) {
        this.#logWorkflowTaskNotFound('respondWorkflowTaskFailed', execution)
        return
      }
      throw respondError
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
    })

    await this.#workflowService.respondActivityTaskFailed(request, { timeoutMs: RESPOND_TIMEOUT_MS })
  }

  async #cancelActivityTask(response: PollActivityTaskQueueResponse): Promise<void> {
    const request = create(RespondActivityTaskCanceledRequestSchema, {
      taskToken: response.taskToken,
      identity: this.#identity,
      namespace: this.#namespace,
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

  #buildStickyAttributes() {
    return create(StickyExecutionAttributesSchema, {
      workerTaskQueue: create(TaskQueueSchema, { name: this.#stickyTaskQueue }),
      scheduleToStartTimeout: durationFromMillis(this.#config.stickyQueueTimeoutMs),
    })
  }

  async #computeNondeterminismMismatches(
    error: WorkflowNondeterminismError,
    expectedState: WorkflowDeterminismState | undefined,
  ): Promise<DeterminismMismatch[]> {
    const baseline: WorkflowDeterminismState = expectedState ?? { commandHistory: [], randomValues: [], timeValues: [] }
    const hint = error.details?.hint
    if (!hint) {
      return []
    }

    const commandIndex = this.#parseIndexFromHint(hint, 'commandIndex')
    const randomIndex = this.#parseIndexFromHint(hint, 'randomIndex')
    const timeIndex = this.#parseIndexFromHint(hint, 'timeIndex')

    const mutableActual: {
      commandHistory: { intent: WorkflowCommandIntent }[]
      randomValues: number[]
      timeValues: number[]
    } = {
      commandHistory: baseline.commandHistory.map((entry) => ({ intent: entry.intent })),
      randomValues: [...baseline.randomValues],
      timeValues: [...baseline.timeValues],
    }
    let mutated = false

    if (commandIndex !== null) {
      const received = error.details?.received as WorkflowCommandIntent | undefined
      if (received) {
        if (commandIndex < mutableActual.commandHistory.length) {
          mutableActual.commandHistory = mutableActual.commandHistory.map((entry, idx) =>
            idx === commandIndex ? { intent: received } : entry,
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

    if (!mutated) {
      return []
    }

    const actualState: WorkflowDeterminismState = {
      commandHistory: mutableActual.commandHistory,
      randomValues: mutableActual.randomValues,
      timeValues: mutableActual.timeValues,
    }

    const diff = await Effect.runPromise(diffDeterminismState(baseline, actualState))
    return diff.mismatches
  }

  #augmentNondeterminismError(
    error: WorkflowNondeterminismError,
    mismatches: DeterminismMismatch[],
  ): WorkflowNondeterminismError {
    if (mismatches.length === 0) {
      return error
    }
    const details = {
      ...(error.details ?? {}),
      mismatches,
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

  #isWorkflowTaskNotFoundError(error: unknown): boolean {
    return error instanceof ConnectError && error.code === Code.NotFound
  }

  #logWorkflowTaskNotFound(context: string, execution: { workflowId: string; runId: string }): void {
    console.warn('[temporal-bun-sdk] workflow task already resolved', {
      context,
      workflowId: execution.workflowId,
      runId: execution.runId,
    })
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
