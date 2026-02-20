import { createHash, randomBytes } from 'node:crypto'

import { create } from '@bufbuild/protobuf'
import { durationFromMs } from '@bufbuild/protobuf/wkt'
import {
  type DataConverter,
  decodePayloadMapToValues,
  decodePayloadsToValues,
  encodeMapValuesToPayloads,
  encodeValuesToPayloads,
} from '../common/payloads'
import { failureToError } from '../common/payloads/failure'
import {
  type Header,
  HeaderSchema,
  type Memo,
  MemoSchema,
  type Payload,
  PayloadSchema,
  type Payloads,
  PayloadsSchema,
  type RetryPolicy,
  RetryPolicySchema,
  type SearchAttributes,
  SearchAttributesSchema,
  type WorkflowExecution,
  WorkflowExecutionSchema,
  type WorkflowType,
  WorkflowTypeSchema,
} from '../proto/temporal/api/common/v1/message_pb'
import { QueryRejectCondition } from '../proto/temporal/api/enums/v1/query_pb'
import { TaskQueueKind } from '../proto/temporal/api/enums/v1/task_queue_pb'
import type { UpdateWorkflowExecutionLifecycleStage } from '../proto/temporal/api/enums/v1/update_pb'
import { VersioningBehavior } from '../proto/temporal/api/enums/v1/workflow_pb'
import { type TaskQueue, TaskQueueSchema } from '../proto/temporal/api/taskqueue/v1/message_pb'
import { type Outcome, WaitPolicySchema } from '../proto/temporal/api/update/v1/message_pb'
import { VersioningOverrideSchema } from '../proto/temporal/api/workflow/v1/message_pb'
import {
  type PollWorkflowExecutionUpdateRequest,
  PollWorkflowExecutionUpdateRequestSchema,
  type QueryWorkflowRequest,
  QueryWorkflowRequestSchema,
  type RequestCancelWorkflowExecutionRequest,
  RequestCancelWorkflowExecutionRequestSchema,
  type SignalWithStartWorkflowExecutionRequest,
  SignalWithStartWorkflowExecutionRequestSchema,
  type SignalWorkflowExecutionRequest,
  SignalWorkflowExecutionRequestSchema,
  type StartWorkflowExecutionRequest,
  StartWorkflowExecutionRequestSchema,
  type TerminateWorkflowExecutionRequest,
  TerminateWorkflowExecutionRequestSchema,
  type UpdateWorkflowExecutionRequest,
  UpdateWorkflowExecutionRequestSchema,
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import type {
  RetryPolicyOptions,
  SignalWithStartOptions,
  StartWorkflowOptions,
  TerminateWorkflowOptions,
  WorkflowHandle,
} from './types'

const HASH_SEPARATOR = '\u001F'

const fallbackRandomHex = (): string => randomBytes(16).toString('hex')

const nextRequestEntropy = (): string => {
  const globalCrypto =
    typeof globalThis === 'object' && 'crypto' in globalThis
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined

  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }

  return fallbackRandomHex()
}

let entropyGenerator: () => string = nextRequestEntropy

export const createSignalRequestEntropy = (): string => entropyGenerator()

export const createUpdateRequestId = (): string => entropyGenerator()

export const __setSignalRequestEntropyGeneratorForTests = (generator?: () => string): void => {
  entropyGenerator = generator ?? nextRequestEntropy
}

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>()

  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input
    }

    const objectInput = input as Record<string, unknown>

    const maybeToJSON = (objectInput as { toJSON?: () => unknown }).toJSON
    if (typeof maybeToJSON === 'function') {
      const jsonValue = maybeToJSON.call(objectInput)
      if (jsonValue !== objectInput) {
        return normalize(jsonValue)
      }
    }

    if (Array.isArray(objectInput)) {
      if (seen.has(objectInput)) {
        throw new TypeError('Cannot stringify circular structures in signal arguments')
      }
      seen.add(objectInput)
      const result = objectInput.map((item) => normalize(item))
      seen.delete(objectInput)
      return result
    }

    if (seen.has(objectInput)) {
      throw new TypeError('Cannot stringify circular structures in signal arguments')
    }

    seen.add(objectInput)
    const entries = Object.entries(objectInput)
      .filter(([, v]) => typeof v !== 'undefined' && typeof v !== 'function' && typeof v !== 'symbol')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

    const normalized: Record<string, unknown> = {}
    for (const [key, rawValue] of entries) {
      const formatted = normalize(rawValue)
      if (typeof formatted !== 'undefined') {
        normalized[key] = formatted
      }
    }

    seen.delete(objectInput)
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
  dataConverter: DataConverter,
  options: { entropy?: string } = {},
): Promise<string> => {
  const hash = createHash('sha256')
  const entropy = (options.entropy ?? createSignalRequestEntropy()).trim()
  const encodedArgs = await encodeValuesToPayloads(dataConverter, Array.isArray(input.args) ? input.args : [])

  const segments = [
    input.namespace.trim(),
    input.workflowId.trim(),
    (input.runId ?? '').trim(),
    (input.firstExecutionRunId ?? '').trim(),
    input.signalName.trim(),
    (input.identity ?? '').trim(),
    stableStringify(encodedArgs ?? []),
    entropy,
  ]

  for (const segment of segments) {
    hash.update(segment)
    hash.update(HASH_SEPARATOR)
  }

  const digest = hash.digest('hex')
  return formatDigestAsUuid(digest)
}

const formatDigestAsUuid = (hex: string): string => {
  const cleaned = hex.replace(/[^a-f0-9]/gi, '').padEnd(32, '0')
  const normalized = cleaned.slice(0, 32).toLowerCase()
  const segments = [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ]
  return segments.join('-')
}

export const buildStartWorkflowRequest = async (
  params: {
    options: StartWorkflowOptions
    defaults: { namespace: string; identity: string; taskQueue: string }
  },
  dataConverter: DataConverter,
): Promise<StartWorkflowExecutionRequest> => {
  const { options, defaults } = params
  const namespace = ensureNamespace(options.namespace, defaults.namespace)
  const workflowType = serializeWorkflowType(options.workflowType)
  const taskQueue = ensureTaskQueue(options.taskQueue, defaults.taskQueue)
  const identity = ensureIdentity(options.identity, defaults.identity)

  const input = await serializeValues(dataConverter, options.args ?? [])
  const memo = await encodeMemoAttributes(dataConverter, options.memo)
  const headers = await serializeHeader(dataConverter, options.headers)
  const searchAttributes = await encodeSearchAttributes(dataConverter, options.searchAttributes)
  const retryPolicy = serializeRetryPolicy(options.retryPolicy)
  const versioningOverride =
    options.versioningBehavior === undefined || options.versioningBehavior === VersioningBehavior.UNSPECIFIED
      ? undefined
      : create(VersioningOverrideSchema, {
          behavior: options.versioningBehavior,
        })

  return create(StartWorkflowExecutionRequestSchema, {
    namespace,
    workflowId: options.workflowId,
    workflowType,
    taskQueue,
    identity,
    versioningOverride,
    requestId: options.requestId ?? '',
    input,
    cronSchedule: options.cronSchedule ?? '',
    memo,
    header: headers,
    searchAttributes,
    workflowExecutionTimeout: toDuration(options.workflowExecutionTimeoutMs),
    workflowRunTimeout: toDuration(options.workflowRunTimeoutMs),
    workflowTaskTimeout: toDuration(options.workflowTaskTimeoutMs),
    retryPolicy,
  })
}

export const buildSignalWithStartRequest = async (
  params: {
    options: SignalWithStartOptions
    defaults: { namespace: string; identity: string; taskQueue: string }
  },
  dataConverter: DataConverter,
): Promise<SignalWithStartWorkflowExecutionRequest> => {
  const base = await buildStartWorkflowRequest(params, dataConverter)
  const signalInput = await serializeValues(dataConverter, params.options.signalArgs ?? [])

  const { $typeName: _ignored, $unknown: _unknownFields, ...startFields } = base as Record<string, unknown>

  return create(SignalWithStartWorkflowExecutionRequestSchema, {
    ...(startFields as Record<string, unknown>),
    signalName: params.options.signalName,
    signalInput,
  })
}

export const buildSignalRequest = async (
  params: {
    handle: WorkflowHandle
    signalName: string
    args: unknown[]
    identity?: string
    requestId?: string
  },
  dataConverter: DataConverter,
): Promise<SignalWorkflowExecutionRequest> => {
  const namespace = ensureNamespace(params.handle.namespace, '')
  const execution = serializeWorkflowExecution(params.handle)
  const input = await serializeValues(dataConverter, params.args ?? [])

  return create(SignalWorkflowExecutionRequestSchema, {
    namespace,
    workflowExecution: execution,
    signalName: params.signalName,
    identity: params.identity ?? '',
    requestId: params.requestId ?? '',
    input,
  })
}

export const buildQueryRequest = async (
  handle: WorkflowHandle,
  queryName: string,
  args: unknown[],
  dataConverter: DataConverter,
  options?: { rejectCondition?: QueryRejectCondition },
): Promise<QueryWorkflowRequest> => {
  const namespace = ensureNamespace(handle.namespace, '')
  const execution = serializeWorkflowExecution(handle)
  const queryArgs = await serializeValues(dataConverter, args ?? [])

  return create(QueryWorkflowRequestSchema, {
    namespace,
    execution,
    query: {
      queryType: queryName,
      queryArgs,
      header: undefined,
    },
    queryRejectCondition: options?.rejectCondition ?? QueryRejectCondition.NONE,
  })
}

export const buildTerminateRequest = async (
  handle: WorkflowHandle,
  options: TerminateWorkflowOptions,
  dataConverter: DataConverter,
  identity: string,
): Promise<TerminateWorkflowExecutionRequest> => {
  const namespace = ensureNamespace(handle.namespace, '')
  const execution = serializeWorkflowExecution(handle)
  const details = await serializeValues(dataConverter, options.details ?? [])

  return create(TerminateWorkflowExecutionRequestSchema, {
    namespace,
    workflowExecution: execution,
    reason: options.reason ?? '',
    identity,
    firstExecutionRunId: options.firstExecutionRunId ?? handle.firstExecutionRunId ?? '',
    details,
  })
}

export const buildCancelRequest = (handle: WorkflowHandle, identity: string): RequestCancelWorkflowExecutionRequest => {
  const namespace = ensureNamespace(handle.namespace, '')
  const execution = serializeWorkflowExecution(handle)

  return create(RequestCancelWorkflowExecutionRequestSchema, {
    namespace,
    workflowExecution: execution,
    identity,
    requestId: '',
    firstExecutionRunId: handle.firstExecutionRunId ?? '',
    reason: '',
  })
}

interface BuildUpdateWorkflowRequestParams {
  handle: WorkflowHandle
  namespace: string
  identity: string
  updateId: string
  updateName: string
  args: unknown[]
  headers?: Record<string, unknown>
  waitStage: UpdateWorkflowExecutionLifecycleStage
  firstExecutionRunId?: string
}

export const buildUpdateWorkflowRequest = async (
  params: BuildUpdateWorkflowRequestParams,
  dataConverter: DataConverter,
): Promise<UpdateWorkflowExecutionRequest> => {
  const namespace = ensureNamespace(params.handle.namespace, params.namespace)
  const execution = serializeWorkflowExecution(params.handle)
  const header = await serializeHeader(dataConverter, params.headers)
  const args = await serializeValues(dataConverter, params.args ?? [])

  return create(UpdateWorkflowExecutionRequestSchema, {
    namespace,
    workflowExecution: execution,
    firstExecutionRunId: params.firstExecutionRunId ?? params.handle.firstExecutionRunId ?? '',
    waitPolicy: create(WaitPolicySchema, { lifecycleStage: params.waitStage }),
    request: {
      meta: {
        updateId: params.updateId,
        identity: params.identity,
      },
      input: {
        name: params.updateName,
        args,
        header,
      },
    },
  })
}

interface BuildPollWorkflowUpdateRequestParams {
  handle: WorkflowHandle
  namespace: string
  identity: string
  updateId: string
  waitStage: UpdateWorkflowExecutionLifecycleStage
}

export const buildPollWorkflowUpdateRequest = (
  params: BuildPollWorkflowUpdateRequestParams,
): PollWorkflowExecutionUpdateRequest => {
  const namespace = ensureNamespace(params.handle.namespace, params.namespace)
  const execution = serializeWorkflowExecution(params.handle)

  return create(PollWorkflowExecutionUpdateRequestSchema, {
    namespace,
    updateRef: {
      workflowExecution: execution,
      updateId: params.updateId,
    },
    identity: params.identity,
    waitPolicy: create(WaitPolicySchema, { lifecycleStage: params.waitStage }),
  })
}

export const decodeUpdateOutcome = async (
  dataConverter: DataConverter,
  outcome?: Outcome | null,
): Promise<{ status: 'success' | 'failure'; result?: unknown; error?: Error } | undefined> => {
  if (!outcome || !outcome.value || outcome.value.case === undefined) {
    return undefined
  }
  if (outcome.value.case === 'success') {
    const payloads = outcome.value.value?.payloads ?? []
    const values = (await decodePayloadsToValues(dataConverter, payloads)) ?? []
    return {
      status: 'success',
      result: values.length > 0 ? values[0] : undefined,
    }
  }
  if (outcome.value.case === 'failure') {
    const error = (await failureToError(dataConverter, outcome.value.value)) ?? new Error('Workflow update failed')
    return {
      status: 'failure',
      error,
    }
  }
  return undefined
}

const serializeRetryPolicy = (policy?: RetryPolicyOptions): RetryPolicy | undefined => {
  if (!policy) return undefined

  return create(RetryPolicySchema, {
    initialInterval: toDuration(policy.initialIntervalMs),
    backoffCoefficient: policy.backoffCoefficient ?? 0,
    maximumInterval: toDuration(policy.maximumIntervalMs),
    maximumAttempts: policy.maximumAttempts ?? 0,
    nonRetryableErrorTypes: policy.nonRetryableErrorTypes ?? [],
  })
}

const serializeWorkflowType = (name: string): WorkflowType =>
  create(WorkflowTypeSchema, {
    name,
  })

const serializeWorkflowExecution = (handle: WorkflowHandle): WorkflowExecution =>
  create(WorkflowExecutionSchema, {
    workflowId: handle.workflowId,
    runId: handle.runId ?? '',
  })

const serializeValues = async (converter: DataConverter, values: unknown[]): Promise<Payloads | undefined> => {
  const payloads = (await encodeValuesToPayloads(converter, Array.isArray(values) ? values : [])) ?? []
  return serializePayloads(payloads as RawPayload[])
}

export const encodeMemoAttributes = async (
  converter: DataConverter,
  map: Record<string, unknown> | undefined,
): Promise<Memo | undefined> => {
  const payloadMap = await encodeMapValuesToPayloads(converter, map)
  if (payloadMap === undefined) {
    return undefined
  }
  return create(MemoSchema, {
    fields: serializePayloadMap(payloadMap as Record<string, RawPayload>),
  })
}

const serializeHeader = async (
  converter: DataConverter,
  map: Record<string, unknown> | undefined,
): Promise<Header | undefined> => {
  const payloadMap = await encodeMapValuesToPayloads(converter, map)
  if (payloadMap === undefined) {
    return undefined
  }
  return create(HeaderSchema, {
    fields: serializePayloadMap(payloadMap as Record<string, RawPayload>),
  })
}

export const encodeSearchAttributes = async (
  converter: DataConverter,
  map: Record<string, unknown> | undefined,
): Promise<SearchAttributes | undefined> => {
  const payloadMap = await encodeMapValuesToPayloads(converter, map)
  if (payloadMap === undefined) {
    return undefined
  }
  return create(SearchAttributesSchema, {
    indexedFields: serializePayloadMap(payloadMap as Record<string, RawPayload>),
  })
}

const materializePayloadMap = (
  map?: Map<string, Payload> | Record<string, Payload>,
): Record<string, Payload> | undefined => {
  if (!map) {
    return undefined
  }
  if (map instanceof Map) {
    return Object.fromEntries(map.entries())
  }
  return { ...map }
}

export const decodeMemoAttributes = async (
  converter: DataConverter,
  memo: Memo | null | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const map = materializePayloadMap(memo?.fields)
  if (!map) {
    return undefined
  }
  return decodePayloadMapToValues(converter, map)
}

export const decodeSearchAttributes = async (
  converter: DataConverter,
  attributes: SearchAttributes | null | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const map = materializePayloadMap(attributes?.indexedFields)
  if (!map) {
    return undefined
  }
  return decodePayloadMapToValues(converter, map)
}

type RawPayload = {
  metadata?: Record<string, ArrayBuffer | ArrayBufferView | Uint8Array | undefined>
  data?: ArrayBuffer | ArrayBufferView | Uint8Array
}

const serializePayloads = (payloads: RawPayload[]): Payloads | undefined => {
  if (!payloads.length) {
    return undefined
  }
  return create(PayloadsSchema, {
    payloads: payloads.map(serializePayload),
  })
}

const serializePayloadMap = (map: Record<string, RawPayload>): Record<string, Payload> => {
  const entries = Object.entries(map)
  if (!entries.length) {
    return {}
  }
  return Object.fromEntries(entries.map(([key, payload]) => [key, serializePayload(payload)]))
}

const serializePayload = (payload: RawPayload): Payload =>
  create(PayloadSchema, {
    metadata: Object.fromEntries(
      Object.entries(payload.metadata ?? {}).map(([key, value]) => [key, toUint8Array(value ?? new Uint8Array(0))]),
    ),
    data: toUint8Array(payload.data ?? new Uint8Array(0)),
  })

const toUint8Array = (value: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

const ensureNamespace = (namespace: string | undefined, fallback: string): string => {
  const value = (namespace ?? fallback).trim()
  if (!value) {
    throw new Error('Namespace must be a non-empty string')
  }
  return value
}

const ensureTaskQueue = (taskQueue: string | undefined, fallback: string): TaskQueue => {
  const name = (taskQueue ?? fallback).trim()
  if (!name) {
    throw new Error('Task queue must be a non-empty string')
  }
  return create(TaskQueueSchema, {
    name,
    kind: TaskQueueKind.NORMAL,
    normalName: '',
  })
}

const ensureIdentity = (identity: string | undefined, fallback: string): string => {
  const value = (identity ?? fallback).trim()
  if (!value) {
    throw new Error('Identity must be a non-empty string')
  }
  return value
}

const toDuration = (value?: number): ReturnType<typeof durationFromMs> | undefined => {
  if (value === undefined) return undefined
  return durationFromMs(value)
}
