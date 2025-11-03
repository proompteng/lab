import { Buffer } from 'node:buffer'

import { historyFromJSON } from '@temporalio/common/lib/proto-utils'
import { coresdk, temporal } from '@temporalio/proto'

import { createDefaultDataConverter, type DataConverter, failureToError } from '../../common/payloads'
import { createRuntime, type Runtime } from '../../core-bridge/runtime'
import {
  NativeBridgeError,
  type NativeReplayWorker,
  type Runtime as NativeRuntime,
  native,
} from '../../internal/core-bridge/native'
import { WorkflowEngine, type WorkflowEngineOptions, type WorkflowTaskContext } from './engine'

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'temporal-bun-replay'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-replay'

type HistoryRecord = Record<string, unknown>

type HistoryLike =
  | temporal.api.history.v1.History
  | temporal.api.history.v1.IHistory
  | HistoryRecord
  | string
  | Buffer
  | Uint8Array

export interface ReplayHistoryInput {
  history: HistoryLike
  workflowId?: string
  runId?: string
  namespace?: string
  taskQueue?: string
}

export interface ReplayOptions
  extends Pick<WorkflowEngineOptions, 'workflowsPath' | 'showStackTraceSources' | 'interceptors'> {
  runtime?: Runtime
  dataConverter?: DataConverter
  namespace?: string
  taskQueue?: string
  identity?: string
}

export type ReplayHistoryIterable = Iterable<ReplayHistoryInput> | AsyncIterable<ReplayHistoryInput>

interface NormalizedHistory {
  buffer: Buffer
  workflowId: string
  runId?: string
  taskQueue?: string
}

export const runReplayHistory = async (options: ReplayOptions & ReplayHistoryInput): Promise<void> => {
  const { history, workflowId, runId, namespace, taskQueue, ...rest } = options
  await runReplayHistories(rest, [
    {
      history,
      workflowId,
      runId,
      namespace,
      taskQueue,
    },
  ])
}

export const runReplayHistories = async (options: ReplayOptions, histories: ReplayHistoryIterable): Promise<void> => {
  if (!options.workflowsPath) {
    throw new Error('Replay requires a workflowsPath that points to the workflow bundle entry point')
  }

  if (native.bridgeVariant !== 'zig') {
    throw new NativeBridgeError(
      'Deterministic replay requires the Zig bridge. Build it with "pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig" and set TEMPORAL_BUN_SDK_USE_ZIG=1.',
    )
  }

  const runtime = options.runtime ?? createRuntime()
  const ownsRuntime = options.runtime == null
  const nativeRuntime = runtime.nativeHandle as NativeRuntime
  const identity = buildIdentity(options.identity)
  const historiesIterator = toAsyncIterable(histories)

  try {
    for await (const item of historiesIterator) {
      await replaySingleHistory({
        options,
        runtime: nativeRuntime,
        identity,
        history: item,
      })
    }
  } finally {
    if (ownsRuntime) {
      await runtime.shutdown()
    }
  }
}

const replaySingleHistory = async ({
  options,
  runtime,
  identity,
  history,
}: {
  options: ReplayOptions
  runtime: NativeRuntime
  identity: string
  history: ReplayHistoryInput
}): Promise<void> => {
  const normalized = normalizeHistory(history)

  const namespace = (history.namespace ?? options.namespace ?? DEFAULT_NAMESPACE).trim()
  if (!namespace) {
    throw new NativeBridgeError('Replay namespace must be a non-empty string')
  }

  const taskQueue = (history.taskQueue ?? options.taskQueue ?? normalized.taskQueue ?? DEFAULT_TASK_QUEUE).trim()
  if (!taskQueue) {
    throw new NativeBridgeError('Replay taskQueue must be provided either via options or embedded history metadata')
  }

  const workflowId = (history.workflowId ?? normalized.workflowId).trim()
  if (!workflowId) {
    throw new NativeBridgeError('Workflow history is missing a workflowId; provide one via options.workflowId')
  }

  const dataConverter = options.dataConverter ?? createDefaultDataConverter()
  const engine = new WorkflowEngine({
    workflowsPath: options.workflowsPath,
    showStackTraceSources: options.showStackTraceSources,
    interceptors: options.interceptors,
    dataConverter,
  })

  const replayWorker = native.createReplayWorker(runtime, {
    namespace,
    taskQueue,
    identity,
  })

  try {
    const pollers: Promise<Uint8Array>[] = [
      native.worker.pollWorkflowTask(replayWorker.worker),
      native.worker.pollWorkflowTask(replayWorker.worker),
    ]

    native.pushReplayHistory(replayWorker, workflowId, normalized.buffer)

    await drainReplay({
      engine,
      replayWorker,
      context: {
        namespace,
        taskQueue,
      },
      dataConverter,
      pollers,
    })
  } finally {
    engine.shutdown()
    native.destroyReplayWorker(replayWorker)
  }
}

const drainReplay = async ({
  engine,
  replayWorker,
  context,
  dataConverter,
  pollers,
}: {
  engine: WorkflowEngine
  replayWorker: NativeReplayWorker
  context: WorkflowTaskContext
  dataConverter: DataConverter
  pollers: Promise<Uint8Array>[]
}): Promise<void> => {
  if (pollers.length < 2) {
    pollers.push(native.worker.pollWorkflowTask(replayWorker.worker))
  }

  let activeIndex = 0

  for (;;) {
    let payload: Uint8Array
    const currentIndex = activeIndex
    try {
      payload = await pollers[currentIndex]
    } catch (error) {
      throw augmentReplayError(error)
    }

    activeIndex = (currentIndex + 1) % pollers.length

    if (!payload || payload.length === 0) {
      break
    }

    let activation: coresdk.workflow_activation.WorkflowActivation
    try {
      activation = coresdk.workflow_activation.WorkflowActivation.decode(payload)
    } catch (error) {
      throw new Error(`Failed to decode workflow activation during replay: ${(error as Error).message}`)
    }

    let completionBytes: Uint8Array | null = null
    let failureError: Error | undefined
    const shouldStopAfterCompletion = hasRemoveFromCacheJob(activation)
    try {
      const result = await engine.processWorkflowActivation(activation, context)
      completionBytes = coresdk.workflow_completion.WorkflowActivationCompletion.encode(result.completion).finish()

      if (result.completion.failed?.failure) {
        failureError =
          (await failureToError(dataConverter, result.completion.failed.failure)) ??
          new Error('Workflow replay failed with a nondeterministic result')
      }
    } catch (error) {
      // Convert thrown application error into failure response and send to core to keep the worker consistent.
      const failureCompletion = coresdk.workflow_completion.WorkflowActivationCompletion.create({
        runId: activation.runId,
        failed: coresdk.workflow_completion.Failure.create({
          failure: temporal.api.failure.v1.Failure.create({
            message: error instanceof Error ? error.message : String(error),
          }),
        }),
      })
      const failureBytes = coresdk.workflow_completion.WorkflowActivationCompletion.encode(failureCompletion).finish()
      native.worker.completeWorkflowTask(replayWorker.worker, failureBytes)
      throw error
    }

    if (!completionBytes) {
      throw new Error('Replay worker did not produce a workflow completion payload')
    }

    native.worker.completeWorkflowTask(replayWorker.worker, completionBytes)

    if (failureError) {
      throw failureError
    }

    if (shouldStopAfterCompletion) {
      break
    }

    pollers[currentIndex] = native.worker.pollWorkflowTask(replayWorker.worker)
  }

  // Let any outstanding polls settle to avoid dangling rejections.
  for (const poll of pollers) {
    poll.catch(() => undefined)
  }
}

const normalizeHistory = (input: ReplayHistoryInput): NormalizedHistory => {
  const inputMetadata = deriveMetadataFromInput(input.history)
  const historyMessage = toHistoryMessage(input.history)
  const encoded = temporal.api.history.v1.History.encode(historyMessage).finish()
  const historyRecord = historyMessageToRecord(historyMessage)
  const started = findWorkflowExecutionStartedRecord(historyRecord)

  const workflowIdCandidate =
    input.workflowId ??
    inputMetadata.workflowId ??
    toOptionalString((started?.workflowExecution as HistoryRecord | undefined)?.workflowId) ??
    toOptionalString(started?.workflowId) ??
    toOptionalString((historyRecord.workflowExecution as HistoryRecord | undefined)?.workflowId)

  const workflowId = workflowIdCandidate?.trim()
  if (!workflowId) {
    throw new NativeBridgeError(
      'Unable to determine workflowId from replay history; provide one via options.workflowId',
    )
  }

  const runIdCandidate =
    input.runId ??
    inputMetadata.runId ??
    toOptionalString(started?.originalExecutionRunId) ??
    toOptionalString((started?.workflowExecution as HistoryRecord | undefined)?.runId) ??
    toOptionalString((historyRecord.workflowExecution as HistoryRecord | undefined)?.runId)

  const taskQueueCandidate = input.taskQueue ?? inputMetadata.taskQueue ?? extractTaskQueueRecord(started)

  return {
    buffer: Buffer.from(encoded),
    workflowId,
    runId: runIdCandidate?.trim(),
    taskQueue: taskQueueCandidate?.trim(),
  }
}

const toHistoryMessage = (history: HistoryLike): temporal.api.history.v1.History => {
  if (typeof history === 'string') {
    return historyFromJsonString(history)
  }

  if (Buffer.isBuffer(history) || history instanceof Uint8Array) {
    return historyFromBuffer(Buffer.isBuffer(history) ? history : Buffer.from(history))
  }

  if (isHistoryProtoObject(history)) {
    return temporal.api.history.v1.History.fromObject(history)
  }

  if (typeof history === 'object' && history !== null && 'events' in history) {
    return historyFromJsonObject(history)
  }

  throw new TypeError('Unsupported history input. Provide Temporal history JSON, binary, or a history object.')
}

const historyFromJsonString = (json: string): temporal.api.history.v1.History => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`Workflow history must be valid JSON: ${(error as Error).message}`)
  }
  return historyFromJsonObject(parsed)
}

const historyFromJsonObject = (value: unknown): temporal.api.history.v1.History => {
  if (isHistoryProtoObject(value)) {
    return temporal.api.history.v1.History.fromObject(value)
  }
  if (value && typeof value === 'object' && 'events' in value) {
    try {
      return temporal.api.history.v1.History.fromObject(value as temporal.api.history.v1.IHistory)
    } catch {
      // fall back to canonical JSON normalization below
    }
  }
  const normalized = historyFromJSON(value)
  return temporal.api.history.v1.History.fromObject(normalized)
}

const historyFromBuffer = (buffer: Buffer): temporal.api.history.v1.History => {
  const text = buffer.toString('utf8')
  try {
    return historyFromJsonString(text)
  } catch {
    try {
      return temporal.api.history.v1.History.decodeDelimited(buffer)
    } catch {
      try {
        return temporal.api.history.v1.History.decode(buffer)
      } catch (binaryError) {
        const message =
          binaryError instanceof Error ? binaryError.message : 'Unable to decode Temporal history binary payload'
        throw new Error(`Workflow history must be valid Temporal history data: ${message}`)
      }
    }
  }
}

const isHistoryProtoObject = (
  value: unknown,
): value is temporal.api.history.v1.History | temporal.api.history.v1.IHistory => {
  if (!value || typeof value !== 'object' || !('events' in value)) {
    return false
  }
  const events = (value as { events?: unknown[] }).events
  if (!Array.isArray(events) || events.length === 0) {
    return true
  }
  const first = events[0] as Record<string, unknown>
  const eventId = first?.eventId
  return typeof eventId !== 'string'
}

const historyMessageToRecord = (message: temporal.api.history.v1.History): HistoryRecord => {
  return temporal.api.history.v1.History.toObject(message, {
    defaults: false,
    enums: String,
    longs: String,
  }) as HistoryRecord
}

const deriveMetadataFromInput = (
  history: HistoryLike,
): Partial<{ workflowId: string; runId: string; taskQueue: string }> => {
  const record = tryConvertHistoryLikeToRecord(history)
  if (!record) {
    return {}
  }
  const started = findWorkflowExecutionStartedRecord(record)
  const workflowId =
    toOptionalString((record.workflowExecution as HistoryRecord | undefined)?.workflowId) ??
    toOptionalString((started?.workflowExecution as HistoryRecord | undefined)?.workflowId) ??
    toOptionalString(started?.workflowId)

  const runId =
    toOptionalString((record.workflowExecution as HistoryRecord | undefined)?.runId) ??
    toOptionalString((started?.workflowExecution as HistoryRecord | undefined)?.runId) ??
    toOptionalString(started?.originalExecutionRunId)

  const taskQueue = extractTaskQueueRecord(started)

  return {
    workflowId: workflowId?.trim(),
    runId: runId?.trim(),
    taskQueue: taskQueue?.trim(),
  }
}

const tryConvertHistoryLikeToRecord = (history: HistoryLike): HistoryRecord | undefined => {
  if (typeof history === 'string') {
    try {
      return JSON.parse(history) as HistoryRecord
    } catch {
      return undefined
    }
  }
  if (Buffer.isBuffer(history) || history instanceof Uint8Array) {
    try {
      return JSON.parse((Buffer.isBuffer(history) ? history : Buffer.from(history)).toString('utf8')) as HistoryRecord
    } catch {
      return undefined
    }
  }
  if (isHistoryProtoObject(history)) {
    const message = temporal.api.history.v1.History.fromObject(history)
    return historyMessageToRecord(message)
  }
  if (history && typeof history === 'object' && 'events' in history) {
    return history as HistoryRecord
  }
  return undefined
}

const findWorkflowExecutionStartedRecord = (history: HistoryRecord): HistoryRecord | undefined => {
  const events = (history.events as HistoryRecord[] | undefined) ?? []
  for (const event of events) {
    const attrs = event.workflowExecutionStartedEventAttributes as HistoryRecord | undefined
    if (attrs) {
      return attrs
    }
  }
  return undefined
}

const extractTaskQueueRecord = (attrs: HistoryRecord | undefined): string | undefined => {
  const taskQueue = attrs?.taskQueue as HistoryRecord | string | undefined
  if (!taskQueue) {
    return undefined
  }
  if (typeof taskQueue === 'string') {
    return taskQueue
  }
  if (typeof taskQueue === 'object') {
    const name = (taskQueue.name ?? (taskQueue as { taskQueue?: unknown }).taskQueue) as unknown
    if (typeof name === 'string') {
      return name
    }
  }
  return undefined
}

const toOptionalString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString()
  }
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    const result = (value as { toString(): unknown }).toString()
    return typeof result === 'string' ? result : undefined
  }
  return undefined
}

const hasRemoveFromCacheJob = (activation: coresdk.workflow_activation.WorkflowActivation): boolean => {
  return Boolean(activation.jobs?.some((job) => job.removeFromCache != null))
}

const toAsyncIterable = <T>(input: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> => {
  if (Symbol.asyncIterator in input) {
    return input as AsyncIterable<T>
  }

  const iterable = input as Iterable<T>
  return (async function* () {
    for (const item of iterable) {
      yield item
    }
  })()
}

const buildIdentity = (identity?: string): string => {
  const base = identity?.trim() ?? ''
  if (base.length > 0) {
    return base
  }
  return `${DEFAULT_IDENTITY_PREFIX}-${process.pid}`
}

const augmentReplayError = (error: unknown): unknown => {
  if (error instanceof NativeBridgeError) {
    return new NativeBridgeError({
      code: error.code,
      message: `Workflow replay failed: ${error.message}`,
      details: error.details,
      raw: error.raw,
    })
  }
  return error
}
