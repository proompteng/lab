import { Buffer } from 'node:buffer'

import { CancelledFailure, defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common'
import { coresdk, type google, type temporal } from '@temporalio/proto'
import type Long from 'long'

import { loadTemporalConfig, type TemporalConfig, type TLSConfig } from '../config'
import {
  NativeBridgeError,
  type NativeClient,
  type Runtime as NativeRuntime,
  type NativeWorker,
  native,
} from '../internal/core-bridge/native'
import { type WorkflowActivationResult, WorkflowEngine } from '../workflow/runtime'
import { type ActivityContext, type ActivityInfo, runWithActivityContext } from './activity-context'

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'

const shouldUseZigWorkerBridge = (): boolean => process.env.TEMPORAL_BUN_SDK_USE_ZIG === '1'

export interface WorkerRuntimeOptions {
  workflowsPath: string
  activities?: Record<string, ActivityHandler>
  taskQueue?: string
  namespace?: string
  concurrency?: { workflow?: number; activity?: number }
}

export interface NativeWorkerOptions {
  runtime: NativeRuntime
  client: NativeClient
  namespace?: string
  taskQueue?: string
  identity?: string
}

export const isZigWorkerBridgeEnabled = (): boolean => shouldUseZigWorkerBridge() && native.bridgeVariant === 'zig'

export const maybeCreateNativeWorker = (options: NativeWorkerOptions): NativeWorker | null => {
  if (!shouldUseZigWorkerBridge()) {
    return null
  }

  if (native.bridgeVariant !== 'zig') {
    throw new NativeBridgeError({
      code: 2,
      message: 'TEMPORAL_BUN_SDK_USE_ZIG=1 requires the Zig bridge, but a different native bridge variant was loaded.',
      details: { bridgeVariant: native.bridgeVariant },
    })
  }

  const namespace = (options.namespace ?? DEFAULT_NAMESPACE).trim()
  if (namespace.length === 0) {
    throw new NativeBridgeError({
      code: 3,
      message: 'Worker namespace must be a non-empty string when TEMPORAL_BUN_SDK_USE_ZIG=1',
    })
  }

  const taskQueue = options.taskQueue?.trim()
  if (!taskQueue) {
    throw new NativeBridgeError({
      code: 3,
      message: 'Worker taskQueue is required when TEMPORAL_BUN_SDK_USE_ZIG=1',
    })
  }

  const identity = options.identity?.trim().length
    ? options.identity.trim()
    : `${DEFAULT_IDENTITY_PREFIX}-${process.pid}`

  try {
    return native.createWorker(options.runtime, options.client, {
      namespace,
      taskQueue,
      identity,
    })
  } catch (error) {
    if (error instanceof NativeBridgeError) {
      throw error
    }
    throw new NativeBridgeError({
      code: 2,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export const destroyNativeWorker = (worker: NativeWorker | null | undefined): void => {
  if (!worker) {
    return
  }
  native.destroyWorker(worker)
}

const formatTemporalAddress = (address: string, useTls: boolean): string => {
  if (/^https?:\/\//i.test(address)) {
    return address
  }
  return `${useTls ? 'https' : 'http'}://${address}`
}

const serializeTlsConfig = (tls?: TLSConfig): Record<string, unknown> | undefined => {
  if (!tls) return undefined

  const payload: Record<string, unknown> = {}
  const encode = (buffer?: Buffer) => buffer?.toString('base64')

  const caCertificate = encode(tls.serverRootCACertificate)
  if (caCertificate) {
    payload.serverRootCACertificate = caCertificate
    payload.server_root_ca_cert = caCertificate
  }

  const clientCert = encode(tls.clientCertPair?.crt)
  const clientKey = encode(tls.clientCertPair?.key)
  if (clientCert && clientKey) {
    const pair = { crt: clientCert, key: clientKey }
    payload.clientCertPair = pair
    payload.client_cert_pair = pair
    payload.client_cert = clientCert
    payload.client_private_key = clientKey
  }

  if (tls.serverNameOverride) {
    payload.serverNameOverride = tls.serverNameOverride
    payload.server_name_override = tls.serverNameOverride
  }

  return Object.keys(payload).length === 0 ? undefined : payload
}

type WorkerRuntimeState = 'idle' | 'running' | 'stopping' | 'stopped'

interface WorkerHandles {
  runtime: NativeRuntime
  client: NativeClient
  worker: NativeWorker
}

interface WorkerRuntimeContext {
  namespace: string
  identity: string
  taskQueue: string
  config: TemporalConfig
}

type ActivityHandler = (...args: unknown[]) => unknown | Promise<unknown>

export class WorkerRuntime {
  #handles: WorkerHandles
  #context: WorkerRuntimeContext
  #workflowEngine: WorkflowEngine
  #activityHandlers: Record<string, ActivityHandler>
  #state: WorkerRuntimeState = 'idle'
  #abortController: AbortController | null = null
  #runPromise: Promise<void> | null = null
  #shutdownPromise: Promise<void> | null = null
  #resolveShutdown?: () => void
  #rejectShutdown?: (error: unknown) => void
  #nativeShutdownRequested = false
  #disposed = false
  #activities = new Map<string, ActivityExecution>()
  #pendingActivityRuns = new Set<Promise<void>>()

  private constructor(
    readonly options: WorkerRuntimeOptions,
    handles: WorkerHandles,
    context: WorkerRuntimeContext,
    workflowEngine: WorkflowEngine,
  ) {
    this.#handles = handles
    this.#context = context
    this.#workflowEngine = workflowEngine
    this.#activityHandlers = { ...(options.activities ?? {}) }
  }

  static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
    if (!isZigWorkerBridgeEnabled()) {
      throw new NativeBridgeError({
        code: 2,
        message: 'WorkerRuntime.create requires TEMPORAL_BUN_SDK_USE_ZIG=1 and the Zig bridge.',
        details: { bridgeVariant: native.bridgeVariant },
      })
    }

    const config = await loadTemporalConfig()
    if (config.allowInsecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }

    const namespace = (options.namespace ?? config.namespace ?? DEFAULT_NAMESPACE).trim()
    if (namespace.length === 0) {
      throw new NativeBridgeError({
        code: 3,
        message: 'Worker namespace must be configured when using the Zig bridge.',
      })
    }

    const taskQueue = (options.taskQueue ?? config.taskQueue ?? '').trim()
    if (taskQueue.length === 0) {
      throw new NativeBridgeError({
        code: 3,
        message: 'Worker taskQueue must be configured when using the Zig bridge.',
      })
    }

    const identity = config.workerIdentity?.trim().length
      ? config.workerIdentity.trim()
      : `${DEFAULT_IDENTITY_PREFIX}-${process.pid}`

    const runtime = native.createRuntime({})
    let client: NativeClient | null = null

    try {
      const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)

      const nativeConfig: Record<string, unknown> = {
        address: formatTemporalAddress(config.address, shouldUseTls),
        namespace,
        identity,
      }

      if (config.apiKey) {
        nativeConfig.apiKey = config.apiKey
      }

      const tlsPayload = serializeTlsConfig(config.tls)
      if (tlsPayload) {
        nativeConfig.tls = tlsPayload
      }

      if (config.allowInsecureTls) {
        nativeConfig.allowInsecure = true
      }

      client = await native.createClient(runtime, nativeConfig)

      const workerHandle = maybeCreateNativeWorker({
        runtime,
        client,
        namespace,
        taskQueue,
        identity,
      })

      if (!workerHandle) {
        throw new NativeBridgeError({
          code: 2,
          message: 'Zig worker bridge is disabled; set TEMPORAL_BUN_SDK_USE_ZIG=1 to enable WorkerRuntime.',
        })
      }

      const workflowEngine = new WorkflowEngine({
        workflowsPath: options.workflowsPath,
        activities: options.activities,
        showStackTraceSources: config.showStackTraceSources ?? false,
      })

      return new WorkerRuntime(
        options,
        { runtime, client, worker: workerHandle },
        { namespace, identity, taskQueue, config },
        workflowEngine,
      )
    } catch (error) {
      if (client) {
        native.clientShutdown(client)
      }
      native.runtimeShutdown(runtime)
      throw error
    }
  }

  async run(): Promise<void> {
    if (this.#state === 'stopped') {
      throw new Error('WorkerRuntime has already been shut down')
    }

    if (this.#state === 'running' || this.#state === 'stopping') {
      return this.#shutdownPromise ?? Promise.resolve()
    }

    this.#state = 'running'
    this.#nativeShutdownRequested = false
    this.#abortController = new AbortController()
    this.#shutdownPromise = new Promise<void>((resolve, reject) => {
      this.#resolveShutdown = resolve
      this.#rejectShutdown = reject
    })

    const signal = this.#abortController.signal
    const workflowLoopPromise = this.#workflowLoop(signal)
    const activityLoopPromise = this.#activityLoop(signal)
    const loopPromise = Promise.all([workflowLoopPromise, activityLoopPromise])

    this.#runPromise = loopPromise
      .then(() => this.#finalizeRun())
      .catch((error) =>
        this.#finalizeRun(error).then(() => {
          throw error
        }),
      )
      .finally(() => {
        this.#resolveShutdown = undefined
        this.#rejectShutdown = undefined
        this.#shutdownPromise = null
      })

    return this.#shutdownPromise
  }

  async shutdown(_gracefulTimeoutMs?: number): Promise<void> {
    void _gracefulTimeoutMs

    if (this.#state === 'stopped') {
      return
    }

    if (this.#state === 'idle') {
      this.#cancelAllActivities('Worker runtime shut down before start')
      this.#disposeHandles()
      this.#state = 'stopped'
      return
    }

    if (this.#state === 'running' || this.#state === 'stopping') {
      this.#state = 'stopping'
      this.#abortController?.abort()
      this.#cancelAllActivities('Worker runtime shutting down')
      this.#requestNativeShutdown()
      if (this.#runPromise) {
        await this.#runPromise.catch((error) => {
          throw error
        })
      }
    }
  }

  #requestNativeShutdown(): void {
    if (this.#disposed || this.#nativeShutdownRequested) {
      return
    }

    if (!this.#handles.worker.handle) {
      this.#nativeShutdownRequested = true
      return
    }

    this.#nativeShutdownRequested = true

    try {
      destroyNativeWorker(this.#handles.worker)
    } catch (error) {
      this.#nativeShutdownRequested = false
      throw error
    }
  }

  async #workflowLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let payload: Uint8Array
      try {
        payload = await native.worker.pollWorkflowTask(this.#handles.worker)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        throw error
      }

      if (signal.aborted) {
        break
      }

      if (payload.byteLength === 0) {
        continue
      }

      await this.#processWorkflowActivation(payload)
    }
  }

  async #activityLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let payload: Uint8Array | null
      try {
        payload = await native.worker.pollActivityTask(this.#handles.worker)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        throw error
      }

      if (signal.aborted) {
        break
      }

      if (payload === null || payload.byteLength === 0) {
        continue
      }

      await this.#processActivityTask(payload)
    }
  }

  async #processWorkflowActivation(bytes: Uint8Array): Promise<void> {
    let activation: coresdk.workflow_activation.WorkflowActivation
    try {
      activation = coresdk.workflow_activation.WorkflowActivation.decode(bytes)
    } catch (error) {
      await this.#respondWorkflowFailure(undefined, error)
      throw new Error(`Failed to decode workflow activation: ${(error as Error).message}`)
    }

    let result: WorkflowActivationResult
    try {
      result = await this.#workflowEngine.processWorkflowActivation(activation, {
        namespace: this.#context.namespace,
        taskQueue: this.#context.taskQueue,
      })
    } catch (error) {
      await this.#respondWorkflowFailure(activation.runId, error)
      throw error
    }

    const payload = coresdk.workflow_completion.WorkflowActivationCompletion.encode(result.completion).finish()
    native.worker.completeWorkflowTask(this.#handles.worker, payload)
  }

  async #processActivityTask(bytes: Uint8Array): Promise<void> {
    let task: coresdk.activity_task.ActivityTask
    try {
      task = coresdk.activity_task.ActivityTask.decode(bytes)
    } catch (error) {
      throw new Error(`Failed to decode activity task: ${(error as Error).message}`)
    }

    if (!task.taskToken || task.taskToken.length === 0) {
      throw new Error('Received activity task without a task token')
    }

    const taskToken = new Uint8Array(task.taskToken)
    const tokenKey = activityTokenToKey(taskToken)

    if (task.start) {
      await this.#handleActivityStart(tokenKey, taskToken, task.start)
      return
    }

    if (task.cancel) {
      await this.#handleActivityCancel(tokenKey, taskToken, task.cancel)
      return
    }

    throw new Error('Received activity task without start or cancel payloads')
  }

  async #handleActivityStart(
    tokenKey: string,
    taskToken: Uint8Array,
    start: coresdk.activity_task.IStart,
  ): Promise<void> {
    const activityType = start.activityType ?? ''
    if (!activityType) {
      await this.#completeActivityFailure(taskToken, new Error('Activity type was not provided'))
      return
    }

    const handler = this.#activityHandlers[activityType]
    if (!handler) {
      await this.#completeActivityFailure(
        taskToken,
        new Error(`Activity handler not registered for type "${activityType}"`),
      )
      return
    }

    if (this.#activities.has(tokenKey)) {
      await this.#completeActivityFailure(
        taskToken,
        new Error(`Duplicate activity start received for token "${tokenKey}"`),
      )
      return
    }

    const args = decodePayloads(start.input)
    const info: ActivityInfo = {
      activityId: start.activityId ?? '',
      activityType,
      workflowNamespace: start.workflowNamespace ?? this.#context.namespace,
      workflowType: start.workflowType ?? '',
      workflowId: start.workflowExecution?.workflowId ?? '',
      runId: start.workflowExecution?.runId ?? '',
      taskQueue: this.#context.taskQueue,
      attempt: start.attempt ?? 1,
      isLocal: Boolean(start.isLocal),
      heartbeatTimeoutMs: durationToMs(start.heartbeatTimeout),
      scheduleToCloseTimeoutMs: durationToMs(start.scheduleToCloseTimeout),
      startToCloseTimeoutMs: durationToMs(start.startToCloseTimeout),
      scheduledTime: timestampToDate(start.scheduledTime),
      startedTime: timestampToDate(start.startedTime),
      currentAttemptScheduledTime: timestampToDate(start.currentAttemptScheduledTime),
      lastHeartbeatDetails: decodePayloads(start.heartbeatDetails),
    }

    const context = new ActivityContextImpl(info, (details) => this.#recordActivityHeartbeat(taskToken, details))

    const execution = new ActivityExecution({
      tokenKey,
      taskToken,
      handler,
      args,
      context,
      onSuccess: async (value) => {
        await this.#completeActivitySuccess(taskToken, value)
      },
      onFailure: async (error) => {
        await this.#completeActivityFailure(taskToken, error)
      },
      onCancelled: async (failure) => {
        await this.#completeActivityCancelled(taskToken, failure)
      },
      onFinished: () => {
        this.#onActivityFinished(tokenKey)
      },
    })

    this.#activities.set(tokenKey, execution)
    const runPromise = execution.start()
    this.#pendingActivityRuns.add(runPromise)
    runPromise.finally(() => {
      this.#pendingActivityRuns.delete(runPromise)
    })
  }

  async #handleActivityCancel(
    tokenKey: string,
    taskToken: Uint8Array,
    cancel: coresdk.activity_task.ICancel,
  ): Promise<void> {
    const execution = this.#activities.get(tokenKey)
    const failure = new CancelledFailure(
      formatActivityCancelReason(cancel.reason),
      describeCancellationDetails(cancel.details) ?? [],
    )

    if (execution) {
      execution.requestCancel(failure)
      return
    }

    await this.#completeActivityCancelled(taskToken, failure)
  }

  async #respondWorkflowFailure(runId: string | undefined, error: unknown): Promise<void> {
    const failure = defaultFailureConverter.errorToFailure(normalizeError(error), defaultPayloadConverter)
    const completion = coresdk.workflow_completion.WorkflowActivationCompletion.create({
      runId: runId ?? '',
      failed: coresdk.workflow_completion.Failure.create({ failure }),
    })
    const payload = coresdk.workflow_completion.WorkflowActivationCompletion.encode(completion).finish()
    native.worker.completeWorkflowTask(this.#handles.worker, payload)
  }

  #recordActivityHeartbeat(taskToken: Uint8Array, details?: unknown[]): void {
    const payloads = encodePayloads(details ?? [])
    const heartbeat = coresdk.ActivityHeartbeat.create({
      taskToken,
      ...(payloads.length > 0 ? { details: payloads } : {}),
    })
    const buffer = coresdk.ActivityHeartbeat.encode(heartbeat).finish()
    native.worker.recordActivityHeartbeat(this.#handles.worker, buffer)
  }

  async #completeActivitySuccess(taskToken: Uint8Array, result: unknown): Promise<void> {
    const payload = result === undefined ? undefined : defaultPayloadConverter.toPayload(result)
    const completed = coresdk.activity_result.Success.create(payload ? { result: payload } : {})
    const executionResult = coresdk.activity_result.ActivityExecutionResult.create({ completed })
    const completion = coresdk.ActivityTaskCompletion.create({
      taskToken,
      result: executionResult,
    })
    const buffer = coresdk.ActivityTaskCompletion.encode(completion).finish()
    native.worker.completeActivityTask(this.#handles.worker, buffer)
  }

  async #completeActivityFailure(taskToken: Uint8Array, error: unknown): Promise<void> {
    const failure = defaultFailureConverter.errorToFailure(normalizeError(error), defaultPayloadConverter)
    const failed = coresdk.activity_result.Failure.create({ failure })
    const executionResult = coresdk.activity_result.ActivityExecutionResult.create({ failed })
    const completion = coresdk.ActivityTaskCompletion.create({
      taskToken,
      result: executionResult,
    })
    const buffer = coresdk.ActivityTaskCompletion.encode(completion).finish()
    native.worker.completeActivityTask(this.#handles.worker, buffer)
  }

  async #completeActivityCancelled(taskToken: Uint8Array, failure: CancelledFailure): Promise<void> {
    const failurePayload = defaultFailureConverter.errorToFailure(failure, defaultPayloadConverter)
    const cancelled = coresdk.activity_result.Cancellation.create({ failure: failurePayload })
    const executionResult = coresdk.activity_result.ActivityExecutionResult.create({ cancelled })
    const completion = coresdk.ActivityTaskCompletion.create({
      taskToken,
      result: executionResult,
    })
    const buffer = coresdk.ActivityTaskCompletion.encode(completion).finish()
    native.worker.completeActivityTask(this.#handles.worker, buffer)
  }

  #onActivityFinished(tokenKey: string): void {
    this.#activities.delete(tokenKey)
  }

  async #awaitOpenActivities(): Promise<void> {
    while (this.#pendingActivityRuns.size > 0) {
      const pending = Array.from(this.#pendingActivityRuns)
      await Promise.allSettled(pending)
    }
  }

  #cancelAllActivities(reason: string): void {
    for (const execution of this.#activities.values()) {
      execution.requestCancel(new CancelledFailure(reason))
    }
  }

  async #finalizeRun(error?: unknown): Promise<void> {
    try {
      await this.#awaitOpenActivities()
    } finally {
      this.#disposeHandles()
      this.#state = 'stopped'
      if (error === undefined) {
        this.#resolveShutdown?.()
      } else {
        this.#rejectShutdown?.(error)
      }
    }
  }

  #disposeHandles(): void {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    this.#nativeShutdownRequested = true

    this.#cancelAllActivities('Worker runtime disposed')
    this.#workflowEngine.shutdown()
    if (this.#handles.worker.handle) {
      destroyNativeWorker(this.#handles.worker)
    }
    native.clientShutdown(this.#handles.client)
    native.runtimeShutdown(this.#handles.runtime)
  }
}

class ActivityExecution {
  readonly tokenKey: string
  readonly taskToken: Uint8Array
  #handler: ActivityHandler
  #args: unknown[]
  #context: ActivityContextImpl
  #runPromise: Promise<void> | null = null
  #onSuccess: (value: unknown) => Promise<void>
  #onFailure: (error: unknown) => Promise<void>
  #onCancelled: (failure: CancelledFailure) => Promise<void>
  #onFinished: () => void

  constructor(params: {
    tokenKey: string
    taskToken: Uint8Array
    handler: ActivityHandler
    args: unknown[]
    context: ActivityContextImpl
    onSuccess: (value: unknown) => Promise<void>
    onFailure: (error: unknown) => Promise<void>
    onCancelled: (failure: CancelledFailure) => Promise<void>
    onFinished: () => void
  }) {
    this.tokenKey = params.tokenKey
    this.taskToken = params.taskToken
    this.#handler = params.handler
    this.#args = params.args
    this.#context = params.context
    this.#onSuccess = params.onSuccess
    this.#onFailure = params.onFailure
    this.#onCancelled = params.onCancelled
    this.#onFinished = params.onFinished
  }

  start(): Promise<void> {
    if (!this.#runPromise) {
      this.#runPromise = this.#run()
    }
    return this.#runPromise
  }

  requestCancel(failure: CancelledFailure): void {
    this.#context.requestCancel(failure)
  }

  async #run(): Promise<void> {
    try {
      const result = await this.#runWithCancellation()
      if (this.#context.isCancellationRequested) {
        const failure = this.#context.cancellationFailure ?? new CancelledFailure('Activity cancelled')
        await this.#onCancelled(failure)
      } else {
        await this.#onSuccess(result)
      }
    } catch (error) {
      const err = normalizeError(error)
      if (err instanceof CancelledFailure) {
        await this.#onCancelled(err)
      } else {
        await this.#onFailure(err)
      }
    } finally {
      this.#onFinished()
      this.#context.close()
    }
  }

  async #runWithCancellation(): Promise<unknown> {
    const activityPromise = runWithActivityContext(this.#context, async () => {
      return await this.#handler(...this.#args)
    })
    const cancellationPromise = this.#context.waitForCancellation().then((failure) => {
      throw failure
    })
    return await Promise.race([activityPromise, cancellationPromise])
  }
}

class ActivityContextImpl implements ActivityContext {
  readonly info: ActivityInfo
  #recordHeartbeat: (details: unknown[]) => void
  #abortController = new AbortController()
  #cancelled = false
  #cancelFailure: CancelledFailure | null = null
  #cancelHandlers = new Set<(failure: CancelledFailure) => void>()
  #resolveCancel?: (failure: CancelledFailure) => void
  #cancelPromise: Promise<CancelledFailure>

  constructor(info: ActivityInfo, recordHeartbeat: (details: unknown[]) => void) {
    this.info = info
    this.#recordHeartbeat = recordHeartbeat
    this.#cancelPromise = new Promise<CancelledFailure>((resolve) => {
      this.#resolveCancel = (failure) => {
        if (this.#cancelled) {
          return
        }
        this.#cancelled = true
        this.#cancelFailure = failure
        this.#abortController.abort()
        for (const handler of this.#cancelHandlers) {
          try {
            handler(failure)
          } catch {
            // ignore handler errors
          }
        }
        resolve(failure)
      }
    })
  }

  get cancellationSignal(): AbortSignal {
    return this.#abortController.signal
  }

  get isCancellationRequested(): boolean {
    return this.#cancelled
  }

  get cancellationFailure(): CancelledFailure | null {
    return this.#cancelFailure
  }

  heartbeat(...details: unknown[]): void {
    this.#recordHeartbeat(details)
  }

  throwIfCancelled(): void {
    if (this.#cancelFailure) {
      throw this.#cancelFailure
    }
  }

  waitForCancellation(): Promise<CancelledFailure> {
    return this.#cancelPromise
  }

  requestCancel(failure: CancelledFailure): void {
    this.#resolveCancel?.(failure)
  }

  close(): void {
    this.#cancelHandlers.clear()
  }
}

const encodePayloads = (values: unknown[]): temporal.api.common.v1.IPayload[] => {
  const payloads: temporal.api.common.v1.IPayload[] = []
  for (const value of values) {
    const payload = defaultPayloadConverter.toPayload(value)
    if (payload) {
      payloads.push(payload)
    }
  }
  return payloads
}

const decodePayloads = (payloads: temporal.api.common.v1.IPayload[] | null | undefined): unknown[] => {
  if (!payloads || payloads.length === 0) {
    return []
  }
  return payloads.map((payload) => defaultPayloadConverter.fromPayload(payload))
}

const describeCancellationDetails = (
  details: coresdk.activity_task.IActivityCancellationDetails | null | undefined,
): unknown[] | undefined => {
  if (!details) {
    return undefined
  }
  const flags: Record<string, boolean> = {}
  if (details.isNotFound) flags.isNotFound = true
  if (details.isCancelled) flags.isCancelled = true
  if (details.isPaused) flags.isPaused = true
  if (details.isTimedOut) flags.isTimedOut = true
  if (details.isWorkerShutdown) flags.isWorkerShutdown = true
  if (details.isReset) flags.isReset = true
  return Object.keys(flags).length > 0 ? [flags] : undefined
}

const formatActivityCancelReason = (reason: coresdk.activity_task.ActivityCancelReason | null | undefined): string => {
  switch (reason) {
    case coresdk.activity_task.ActivityCancelReason.NOT_FOUND:
      return 'Activity not found'
    case coresdk.activity_task.ActivityCancelReason.TIMED_OUT:
      return 'Activity timed out'
    case coresdk.activity_task.ActivityCancelReason.WORKER_SHUTDOWN:
      return 'Worker shutdown'
    case coresdk.activity_task.ActivityCancelReason.PAUSED:
      return 'Activity paused'
    case coresdk.activity_task.ActivityCancelReason.RESET:
      return 'Workflow reset'
    default:
      return 'Activity cancelled'
  }
}

const activityTokenToKey = (token: Uint8Array): string => Buffer.from(token).toString('base64')

const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }
  return new Error(typeof error === 'string' ? error : JSON.stringify(error))
}

const timestampToDate = (timestamp: google.protobuf.ITimestamp | null | undefined): Date | undefined => {
  if (!timestamp) {
    return undefined
  }
  const seconds = toNumber(timestamp.seconds)
  const millis = seconds * 1000 + Math.floor((timestamp.nanos ?? 0) / 1_000_000)
  return new Date(millis)
}

const durationToMs = (duration: google.protobuf.IDuration | null | undefined): number | undefined => {
  if (!duration) {
    return undefined
  }
  const seconds = toNumber(duration.seconds)
  return seconds * 1000 + Math.floor((duration.nanos ?? 0) / 1_000_000)
}

const toNumber = (value: Long | number | string | null | undefined): number => {
  if (value === null || value === undefined) {
    return 0
  }
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    return Number(value)
  }
  return value.toNumber()
}

export const __testing = {
  ActivityContextImpl,
  ActivityExecution,
  activityTokenToKey,
  formatActivityCancelReason,
  describeCancellationDetails,
}
