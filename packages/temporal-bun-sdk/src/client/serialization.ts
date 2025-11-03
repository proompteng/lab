import { createHash, randomBytes } from 'node:crypto'

import { Duration } from '@bufbuild/protobuf'

import type { DataConverter } from '../common/payloads'
import { encodeMapValuesToPayloads, encodeValuesToJson, encodeValuesToPayloads } from '../common/payloads'
import {
  Header,
  Memo,
  type Payload,
  Payloads,
  RetryPolicy,
  SearchAttributes,
  WorkflowExecution,
  WorkflowType,
} from '../proto/temporal/api/common/v1/message_pb'
import { TaskQueue } from '../proto/temporal/api/taskqueue/v1/message_pb'
import {
  GetWorkflowExecutionHistoryRequest,
  QueryWorkflowRequest,
  RequestCancelWorkflowExecutionRequest,
  SignalWithStartWorkflowExecutionRequest,
  SignalWorkflowExecutionRequest,
  StartWorkflowExecutionRequest,
  TerminateWorkflowExecutionRequest,
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import type {
  RetryPolicyOptions,
  SignalWithStartOptions,
  StartWorkflowOptions,
  TerminateWorkflowOptions,
  WorkflowHandle,
} from './types'

const HASH_SEPARATOR = '\u001F'

const msToDuration = (value?: number): Duration | undefined => {
  if (value === undefined) {
    return undefined
  }
  const total = Math.max(0, Math.trunc(value))
  const seconds = Math.trunc(total / 1000)
  const nanos = (total % 1000) * 1_000_000
  return new Duration({ seconds: BigInt(seconds), nanos })
}

const ensureNamespace = (handleNamespace: string | undefined, fallback: string): string => {
  const namespace = (handleNamespace ?? fallback).trim()
  if (namespace.length === 0) {
    throw new Error('Namespace must be provided')
  }
  return namespace
}

const payloadsFromValues = async (
  converter: DataConverter,
  values: unknown[] | undefined,
): Promise<Payloads | undefined> => {
  if (!values || values.length === 0) {
    return undefined
  }
  const payloads = await encodeValuesToPayloads(converter, values)
  if (!payloads || payloads.length === 0) {
    return undefined
  }
  return new Payloads({ payloads })
}

const payloadMapFromRecord = async <T extends { fields: Record<string, Payload> }>(
  converter: DataConverter,
  record: Record<string, unknown> | undefined,
  factory: (fields: Record<string, Payload>) => T,
): Promise<T | undefined> => {
  if (record === undefined) {
    return undefined
  }
  const fields = await encodeMapValuesToPayloads(converter, record)
  if (fields === undefined) {
    return undefined
  }
  return factory(fields)
}

const buildRetryPolicyMessage = (policy: RetryPolicyOptions | undefined): RetryPolicy | undefined => {
  if (!policy) {
    return undefined
  }
  return new RetryPolicy({
    initialInterval: msToDuration(policy.initialIntervalMs),
    maximumInterval: msToDuration(policy.maximumIntervalMs),
    maximumAttempts: policy.maximumAttempts ?? 0,
    backoffCoefficient: policy.backoffCoefficient ?? 0,
    nonRetryableErrorTypes: policy.nonRetryableErrorTypes ?? [],
  })
}

export const buildStartWorkflowExecutionRequest = async (
  params: {
    options: StartWorkflowOptions
    defaults: { namespace: string; identity: string; taskQueue: string }
  },
  converter: DataConverter,
): Promise<StartWorkflowExecutionRequest> => {
  const { options, defaults } = params
  const namespace = (options.namespace ?? defaults.namespace).trim()
  if (!namespace) {
    throw new Error('Workflow namespace must be provided')
  }

  const workflowInput = await payloadsFromValues(converter, Array.isArray(options.args) ? options.args : [])
  const memo = await payloadMapFromRecord(converter, options.memo, (fields) => new Memo({ fields }))
  const headers = await payloadMapFromRecord(converter, options.headers, (fields) => new Header({ fields }))
  const searchAttributes = await payloadMapFromRecord(
    converter,
    options.searchAttributes,
    (fields) => new SearchAttributes({ indexedFields: fields }),
  )

  return new StartWorkflowExecutionRequest({
    namespace,
    workflowId: options.workflowId,
    workflowType: new WorkflowType({ name: options.workflowType }),
    taskQueue: new TaskQueue({ name: options.taskQueue ?? defaults.taskQueue }),
    input: workflowInput,
    identity: options.identity ?? defaults.identity,
    requestId: options.requestId ?? '',
    cronSchedule: options.cronSchedule ?? '',
    memo,
    header: headers,
    searchAttributes,
    workflowExecutionTimeout: msToDuration(options.workflowExecutionTimeoutMs),
    workflowRunTimeout: msToDuration(options.workflowRunTimeoutMs),
    workflowTaskTimeout: msToDuration(options.workflowTaskTimeoutMs),
    retryPolicy: buildRetryPolicyMessage(options.retryPolicy),
  })
}

export const buildSignalWorkflowExecutionRequest = async (
  params: {
    handle: WorkflowHandle
    signalName: string
    args: unknown[]
    identity?: string
    requestId?: string
    namespaceFallback: string
  },
  converter: DataConverter,
): Promise<SignalWorkflowExecutionRequest> => {
  const namespace = ensureNamespace(params.handle.namespace, params.namespaceFallback)
  if (!params.handle.workflowId || params.handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }

  return new SignalWorkflowExecutionRequest({
    namespace,
    workflowExecution: new WorkflowExecution({
      workflowId: params.handle.workflowId,
      runId: params.handle.runId ?? '',
    }),
    signalName: params.signalName,
    identity: params.identity ?? '',
    requestId: params.requestId ?? '',
    input: await payloadsFromValues(converter, params.args),
  })
}

export const buildSignalWithStartWorkflowExecutionRequest = async (
  params: {
    options: SignalWithStartOptions
    defaults: { namespace: string; identity: string; taskQueue: string }
  },
  converter: DataConverter,
): Promise<SignalWithStartWorkflowExecutionRequest> => {
  const startRequest = await buildStartWorkflowExecutionRequest(
    { options: params.options, defaults: params.defaults },
    converter,
  )

  return new SignalWithStartWorkflowExecutionRequest({
    namespace: startRequest.namespace,
    workflowId: startRequest.workflowId,
    workflowType: startRequest.workflowType,
    taskQueue: startRequest.taskQueue,
    input: startRequest.input,
    identity: startRequest.identity,
    requestId: startRequest.requestId,
    workflowExecutionTimeout: startRequest.workflowExecutionTimeout,
    workflowRunTimeout: startRequest.workflowRunTimeout,
    workflowTaskTimeout: startRequest.workflowTaskTimeout,
    workflowIdReusePolicy: startRequest.workflowIdReusePolicy,
    workflowIdConflictPolicy: startRequest.workflowIdConflictPolicy,
    retryPolicy: startRequest.retryPolicy,
    cronSchedule: startRequest.cronSchedule,
    memo: startRequest.memo,
    searchAttributes: startRequest.searchAttributes,
    header: startRequest.header,
    signalName: params.options.signalName,
    signalInput: await payloadsFromValues(
      converter,
      Array.isArray(params.options.signalArgs) ? params.options.signalArgs : [],
    ),
  })
}

export const buildQueryWorkflowRequest = async (
  handle: WorkflowHandle,
  queryName: string,
  args: unknown[],
  namespaceFallback: string,
  converter: DataConverter,
): Promise<QueryWorkflowRequest> => {
  const namespace = ensureNamespace(handle.namespace, namespaceFallback)
  if (!handle.workflowId || handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }
  return new QueryWorkflowRequest({
    namespace,
    workflowExecution: new WorkflowExecution({
      workflowId: handle.workflowId,
      runId: handle.runId ?? '',
    }),
    query: {
      queryType: queryName,
      queryArgs: await payloadsFromValues(converter, args),
    },
  })
}

export const buildTerminateWorkflowExecutionRequest = async (
  handle: WorkflowHandle,
  options: TerminateWorkflowOptions | undefined,
  namespaceFallback: string,
  identity: string,
  converter: DataConverter,
): Promise<TerminateWorkflowExecutionRequest> => {
  const namespace = ensureNamespace(handle.namespace, namespaceFallback)
  if (!handle.workflowId || handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }

  return new TerminateWorkflowExecutionRequest({
    namespace,
    workflowExecution: new WorkflowExecution({
      workflowId: handle.workflowId,
      runId: handle.runId ?? '',
    }),
    identity,
    reason: options?.reason ?? '',
    firstExecutionRunId: options?.firstExecutionRunId ?? '',
    details: await payloadsFromValues(converter, Array.isArray(options?.details) ? options?.details : undefined),
  })
}

export const buildCancelWorkflowExecutionRequest = (
  handle: WorkflowHandle,
  namespaceFallback: string,
  identity: string,
): RequestCancelWorkflowExecutionRequest => {
  const namespace = ensureNamespace(handle.namespace, namespaceFallback)
  if (!handle.workflowId || handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }
  return new RequestCancelWorkflowExecutionRequest({
    namespace,
    workflowExecution: new WorkflowExecution({
      workflowId: handle.workflowId,
      runId: handle.runId ?? '',
    }),
    identity,
  })
}

export const buildGetWorkflowExecutionHistoryRequest = (
  handle: WorkflowHandle,
  namespaceFallback: string,
): GetWorkflowExecutionHistoryRequest => {
  const namespace = ensureNamespace(handle.namespace, namespaceFallback)
  if (!handle.workflowId || handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }
  return new GetWorkflowExecutionHistoryRequest({
    namespace,
    execution: new WorkflowExecution({
      workflowId: handle.workflowId,
      runId: handle.runId ?? '',
    }),
  })
}

const nextEntropy = (): string => {
  const globalCrypto =
    typeof globalThis === 'object' && 'crypto' in globalThis
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID()
  }
  return randomBytes(16).toString('hex')
}

let entropyGenerator: () => string = nextEntropy

export const createSignalRequestEntropy = (): string => entropyGenerator()

export const __setSignalRequestEntropyGeneratorForTests = (generator?: () => string): void => {
  entropyGenerator = generator ?? nextEntropy
}

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>()

  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input
    }
    const obj = input as Record<string, unknown>
    const maybeToJSON = (obj as { toJSON?: () => unknown }).toJSON
    if (typeof maybeToJSON === 'function') {
      const jsonValue = maybeToJSON.call(obj)
      if (jsonValue !== obj) {
        return normalize(jsonValue)
      }
    }
    if (Array.isArray(obj)) {
      if (seen.has(obj)) {
        throw new TypeError('Cannot stringify circular structures in signal arguments')
      }
      seen.add(obj)
      const result = obj.map((item) => normalize(item))
      seen.delete(obj)
      return result
    }
    if (seen.has(obj)) {
      throw new TypeError('Cannot stringify circular structures in signal arguments')
    }
    seen.add(obj)
    const entries = Object.entries(obj)
      .filter(([, v]) => typeof v !== 'undefined' && typeof v !== 'function' && typeof v !== 'symbol')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const normalized: Record<string, unknown> = {}
    for (const [key, rawValue] of entries) {
      const formatted = normalize(rawValue)
      if (typeof formatted !== 'undefined') {
        normalized[key] = formatted
      }
    }
    seen.delete(obj)
    return normalized
  }

  return JSON.stringify(normalize(value))
}

export const computeSignalRequestId = async (
  input: {
    namespace: string
    workflowId: string
    runId?: string
    firstExecutionRunId?: string
    signalName: string
    identity?: string
    args: unknown[]
  },
  converter: DataConverter,
  options: { entropy?: string } = {},
): Promise<string> => {
  const hash = createHash('sha256')
  const entropy = (options.entropy ?? createSignalRequestEntropy()).trim()
  const encodedArgs = await encodeValuesToJson(converter, Array.isArray(input.args) ? input.args : [])

  const segments = [
    input.namespace.trim(),
    input.workflowId.trim(),
    (input.runId ?? '').trim(),
    (input.firstExecutionRunId ?? '').trim(),
    input.signalName.trim(),
    (input.identity ?? '').trim(),
    stableStringify(encodedArgs),
    entropy,
  ]

  for (const segment of segments) {
    hash.update(segment)
    hash.update(HASH_SEPARATOR)
  }

  return hash.digest('hex')
}
