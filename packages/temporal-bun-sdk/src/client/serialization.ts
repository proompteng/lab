import { createHash, randomBytes } from 'node:crypto'

import { type DataConverter, encodeMapToJson, encodeValuesToJson } from '../common/payloads'
import type {
  RetryPolicyOptions,
  SignalWithStartOptions,
  StartWorkflowOptions,
  TerminateWorkflowOptions,
  WorkflowHandle,
} from './types'

const ensureWorkflowNamespace = (handle: WorkflowHandle): string => {
  if (!handle.namespace || handle.namespace.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty namespace')
  }
  return handle.namespace
}

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
      .filter(([, value]) => typeof value !== 'undefined' && typeof value !== 'function' && typeof value !== 'symbol')
      .sort(([left], [right]) => {
        if (left < right) return -1
        if (left > right) return 1
        return 0
      })

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
  const encodedArgs = await encodeValuesToJson(dataConverter, Array.isArray(input.args) ? input.args : [])

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

export const buildSignalRequest = async (
  params: {
    handle: WorkflowHandle
    signalName: string
    args: unknown[]
    identity?: string
    requestId?: string
  },
  dataConverter: DataConverter,
): Promise<Record<string, unknown>> => {
  const { handle, signalName, args, identity, requestId } = params

  if (!handle.workflowId || handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }

  if (typeof signalName !== 'string' || signalName.trim().length === 0) {
    throw new Error('Workflow signal name must be a non-empty string')
  }

  const namespace = ensureWorkflowNamespace(handle)
  const payload: Record<string, unknown> = {
    namespace,
    workflow_id: handle.workflowId,
    signal_name: signalName,
    args: await encodeValuesToJson(dataConverter, Array.isArray(args) ? args : []),
  }

  if (handle.runId) {
    payload.run_id = handle.runId
  }

  if (handle.firstExecutionRunId) {
    payload.first_execution_run_id = handle.firstExecutionRunId
  }

  if (identity && identity.trim().length > 0) {
    payload.identity = identity
  }

  if (requestId && requestId.trim().length > 0) {
    payload.request_id = requestId
  }

  return payload
}

export const buildQueryRequest = async (
  handle: WorkflowHandle,
  queryName: string,
  args: unknown[],
  dataConverter: DataConverter,
): Promise<Record<string, unknown>> => {
  if (!handle.workflowId || handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }

  if (typeof queryName !== 'string' || queryName.trim().length === 0) {
    throw new Error('Workflow query name must be a non-empty string')
  }

  const namespace = ensureWorkflowNamespace(handle)
  const payload: Record<string, unknown> = {
    namespace,
    workflow_id: handle.workflowId,
    query_name: queryName,
    args: await encodeValuesToJson(dataConverter, Array.isArray(args) ? args : []),
  }

  if (handle.runId) {
    payload.run_id = handle.runId
  }

  if (handle.firstExecutionRunId) {
    payload.first_execution_run_id = handle.firstExecutionRunId
  }

  return payload
}

export const buildTerminateRequest = async (
  handle: WorkflowHandle,
  options: TerminateWorkflowOptions = {},
  dataConverter: DataConverter,
): Promise<Record<string, unknown>> => {
  const payload: Record<string, unknown> = {
    namespace: handle.namespace,
    workflow_id: handle.workflowId,
  }

  const runId = options.runId ?? handle.runId
  if (runId) {
    payload.run_id = runId
  }

  const firstExecutionRunId = options.firstExecutionRunId ?? handle.firstExecutionRunId
  if (firstExecutionRunId) {
    payload.first_execution_run_id = firstExecutionRunId
  }

  if (options.reason !== undefined) {
    payload.reason = options.reason
  }

  if (options.details !== undefined) {
    payload.details = await encodeValuesToJson(dataConverter, Array.isArray(options.details) ? options.details : [])
  }

  return payload
}

export const buildCancelRequest = (handle: WorkflowHandle): Record<string, unknown> => {
  if (!handle.workflowId || handle.workflowId.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty workflowId')
  }

  const namespace = ensureWorkflowNamespace(handle)
  const payload: Record<string, unknown> = {
    namespace,
    workflow_id: handle.workflowId,
  }

  if (handle.runId && handle.runId.trim().length > 0) {
    payload.run_id = handle.runId
  }

  if (handle.firstExecutionRunId && handle.firstExecutionRunId.trim().length > 0) {
    payload.first_execution_run_id = handle.firstExecutionRunId
  }

  return payload
}

export const buildSignalWithStartRequest = async (
  params: {
    options: SignalWithStartOptions
    defaults: { namespace: string; identity: string; taskQueue: string }
  },
  dataConverter: DataConverter,
): Promise<Record<string, unknown>> => {
  const payload = await buildStartWorkflowRequest(params, dataConverter)
  payload.signal_name = params.options.signalName
  payload.signal_args = await encodeValuesToJson(
    dataConverter,
    Array.isArray(params.options.signalArgs) ? params.options.signalArgs : [],
  )
  return payload
}

export const buildStartWorkflowRequest = async (
  params: {
    options: StartWorkflowOptions
    defaults: { namespace: string; identity: string; taskQueue: string }
  },
  dataConverter: DataConverter,
): Promise<Record<string, unknown>> => {
  const { options, defaults } = params
  const payload: Record<string, unknown> = {
    namespace: options.namespace ?? defaults.namespace,
    workflow_id: options.workflowId,
    workflow_type: options.workflowType,
    task_queue: options.taskQueue ?? defaults.taskQueue,
    identity: options.identity ?? defaults.identity,
    args: await encodeValuesToJson(dataConverter, Array.isArray(options.args) ? options.args : []),
  }

  if (options.cronSchedule) {
    payload.cron_schedule = options.cronSchedule
  }

  if (options.memo !== undefined) {
    const memoPayload = await encodeMapToJson(dataConverter, options.memo)
    if (memoPayload !== undefined) {
      payload.memo = memoPayload
    }
  }

  if (options.headers !== undefined) {
    const headersPayload = await encodeMapToJson(dataConverter, options.headers)
    if (headersPayload !== undefined) {
      payload.headers = headersPayload
    }
  }

  if (options.searchAttributes !== undefined) {
    const searchAttributesPayload = await encodeMapToJson(dataConverter, options.searchAttributes)
    if (searchAttributesPayload !== undefined) {
      payload.search_attributes = searchAttributesPayload
    }
  }

  if (options.requestId) {
    payload.request_id = options.requestId
  }

  if (options.workflowExecutionTimeoutMs !== undefined) {
    payload.workflow_execution_timeout_ms = options.workflowExecutionTimeoutMs
  }

  if (options.workflowRunTimeoutMs !== undefined) {
    payload.workflow_run_timeout_ms = options.workflowRunTimeoutMs
  }

  if (options.workflowTaskTimeoutMs !== undefined) {
    payload.workflow_task_timeout_ms = options.workflowTaskTimeoutMs
  }

  if (options.retryPolicy) {
    const retryPolicyPayload = buildRetryPolicyPayload(options.retryPolicy)
    if (Object.keys(retryPolicyPayload).length > 0) {
      payload.retry_policy = retryPolicyPayload
    }
  }

  return payload
}

const buildRetryPolicyPayload = (policy: RetryPolicyOptions): Record<string, unknown> => {
  const payload: Record<string, unknown> = {}
  if (policy.initialIntervalMs !== undefined) {
    payload.initial_interval_ms = policy.initialIntervalMs
  }
  if (policy.maximumIntervalMs !== undefined) {
    payload.maximum_interval_ms = policy.maximumIntervalMs
  }
  if (policy.maximumAttempts !== undefined) {
    payload.maximum_attempts = policy.maximumAttempts
  }
  if (policy.backoffCoefficient !== undefined) {
    payload.backoff_coefficient = policy.backoffCoefficient
  }
  if (policy.nonRetryableErrorTypes?.length) {
    payload.non_retryable_error_types = policy.nonRetryableErrorTypes
  }
  return payload
}
