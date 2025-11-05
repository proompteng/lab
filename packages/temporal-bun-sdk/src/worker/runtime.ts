import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { create } from '@bufbuild/protobuf'
import { createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { buildTransportOptions, normalizeTemporalAddress } from '../client'
import {
  createDefaultDataConverter,
  type DataConverter,
  decodePayloadsToValues,
  encodeValuesToPayloads,
} from '../common/payloads/converter'
import { encodeErrorToFailure, encodeFailurePayloads } from '../common/payloads/failure'
import { loadTemporalConfig, type TemporalConfig } from '../config'
import { PayloadsSchema } from '../proto/temporal/api/common/v1/message_pb'
import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { WorkflowTaskFailedCause } from '../proto/temporal/api/enums/v1/failed_cause_pb'
import type { HistoryEvent } from '../proto/temporal/api/history/v1/message_pb'
import { TaskQueueSchema } from '../proto/temporal/api/taskqueue/v1/message_pb'
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
import type { WorkflowDefinition, WorkflowDefinitions } from '../workflow/definition'
import { WorkflowExecutor } from '../workflow/executor'
import { WorkflowRegistry } from '../workflow/registry'
import { type ActivityContext, type ActivityInfo, runWithActivityContext } from './activity-context'

type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>

const POLL_TIMEOUT_MS = 60_000
const RESPOND_TIMEOUT_MS = 15_000

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
}

export class WorkerRuntime {
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
    const executor = new WorkflowExecutor({ registry, dataConverter })

    let workflowService: WorkflowServiceClient
    if (options.workflowService) {
      workflowService = options.workflowService
    } else {
      const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
      const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
      const transport = createGrpcTransport(buildTransportOptions(baseUrl, config))
      workflowService = createClient(WorkflowService, transport)
    }

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
  #running = false
  #abortController: AbortController | null = null
  #runPromise: Promise<void> | null = null

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
  }

  async run(): Promise<void> {
    if (this.#running) {
      return this.#runPromise ?? Promise.resolve()
    }
    this.#running = true
    this.#abortController = new AbortController()
    const signal = this.#abortController.signal

    this.#runPromise = Promise.all([this.#workflowLoop(signal), this.#activityLoop(signal)]).then(() => undefined)

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

    try {
      const commands = await this.#executor.execute({ workflowType, arguments: args })
      const completion = create(RespondWorkflowTaskCompletedRequestSchema, {
        taskToken: response.taskToken,
        commands,
        identity: this.#identity,
        namespace: this.#namespace,
      })
      await this.#workflowService.respondWorkflowTaskCompleted(completion, { timeoutMs: RESPOND_TIMEOUT_MS })
    } catch (error) {
      await this.#failWorkflowTask(response, error)
    }
  }

  async #failWorkflowTask(response: PollWorkflowTaskQueueResponse, error: unknown): Promise<void> {
    const failure = await encodeErrorToFailure(this.#dataConverter, error)
    const encoded = await encodeFailurePayloads(this.#dataConverter, failure)

    const failed = create(RespondWorkflowTaskFailedRequestSchema, {
      taskToken: response.taskToken,
      cause: WorkflowTaskFailedCause.UNSPECIFIED,
      failure: encoded,
      identity: this.#identity,
      namespace: this.#namespace,
    })

    await this.#workflowService.respondWorkflowTaskFailed(failed, { timeoutMs: RESPOND_TIMEOUT_MS })
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
