import { Buffer } from 'node:buffer'

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

type HistoryLike = temporal.api.history.v1.IHistory | HistoryRecord | string | Buffer | Uint8Array

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
    native.pushReplayHistory(replayWorker, workflowId, normalized.buffer)
    await drainReplay({
      engine,
      replayWorker,
      context: {
        namespace,
        taskQueue,
      },
      dataConverter,
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
}: {
  engine: WorkflowEngine
  replayWorker: NativeReplayWorker
  context: WorkflowTaskContext
  dataConverter: DataConverter
}): Promise<void> => {
  for (;;) {
    let payload: Uint8Array
    try {
      payload = await native.worker.pollWorkflowTask(replayWorker.worker)
    } catch (error) {
      throw augmentReplayError(error)
    }

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

    if (hasRemoveFromCacheJob(activation)) {
      break
    }
  }
}

const normalizeHistory = (input: ReplayHistoryInput): NormalizedHistory => {
  const bufferAndJson = toHistoryJson(input.history)
  const { json, buffer } = bufferAndJson
  const historyRecord = json as HistoryRecord

  const started = findWorkflowExecutionStarted(historyRecord)

  const workflowId =
    input.workflowId ??
    (started?.workflowExecution as HistoryRecord | undefined)?.workflowId?.toString() ??
    (started?.workflowId as string | undefined) ??
    (historyRecord.workflowExecution as HistoryRecord | undefined)?.workflowId?.toString()

  if (!workflowId || workflowId.length === 0) {
    throw new NativeBridgeError(
      'Unable to determine workflowId from replay history; provide one via options.workflowId',
    )
  }

  const runId =
    input.runId ??
    (started?.originalExecutionRunId as string | undefined) ??
    (started?.workflowExecution as HistoryRecord | undefined)?.runId?.toString() ??
    (historyRecord.workflowExecution as HistoryRecord | undefined)?.runId?.toString()

  const taskQueue = input.taskQueue ?? extractTaskQueue(started)

  return {
    buffer,
    workflowId,
    runId,
    taskQueue,
  }
}

const toHistoryJson = (history: HistoryLike): { json: HistoryRecord; buffer: Buffer } => {
  if (typeof history === 'string') {
    const buffer = Buffer.from(history, 'utf8')
    return { json: parseHistoryJson(buffer), buffer }
  }

  if (Buffer.isBuffer(history) || history instanceof Uint8Array) {
    const buffer = Buffer.isBuffer(history) ? history : Buffer.from(history)
    return { json: parseHistoryJson(buffer), buffer }
  }

  if (typeof history === 'object' && history !== null && 'events' in history) {
    const jsonString = JSON.stringify(history)
    const buffer = Buffer.from(jsonString, 'utf8')
    return { json: JSON.parse(jsonString) as HistoryRecord, buffer }
  }

  throw new TypeError('Unsupported history input. Provide a JSON string, Uint8Array, Buffer, or history object.')
}

const parseHistoryJson = (buffer: Buffer): HistoryRecord => {
  try {
    return JSON.parse(buffer.toString('utf8')) as HistoryRecord
  } catch (error) {
    throw new Error(`Workflow history must be valid JSON: ${(error as Error).message}`)
  }
}

const findWorkflowExecutionStarted = (history: HistoryRecord): HistoryRecord | undefined => {
  const events = (history.events as HistoryRecord[] | undefined) ?? []
  for (const event of events) {
    const attrs = event.workflowExecutionStartedEventAttributes as HistoryRecord | undefined
    if (attrs) {
      return attrs
    }
  }
  return undefined
}

const extractTaskQueue = (attrs: HistoryRecord | undefined): string | undefined => {
  const taskQueue = attrs?.taskQueue as HistoryRecord | string | undefined
  if (!taskQueue) {
    return undefined
  }
  if (typeof taskQueue === 'string') {
    return taskQueue
  }
  if (typeof taskQueue === 'object') {
    const record = taskQueue as HistoryRecord
    const name = record.name ?? record.taskQueue
    return typeof name === 'string' ? name : undefined
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
