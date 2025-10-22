import type {
  RetryPolicyOptions,
  SignalWithStartOptions,
  StartWorkflowOptions,
  TerminateWorkflowOptions,
  WorkflowHandle,
} from './types'

const DOCS_ROOT = 'packages/temporal-bun-sdk/docs'
const FFI_SURFACE_DOC = `${DOCS_ROOT}/ffi-surface.md`
const _CLIENT_RUNTIME_DOC = `${DOCS_ROOT}/client-runtime.md`

const notImplemented = (feature: string, docPath: string): never => {
  throw new Error(`${feature} is not implemented yet. See ${docPath} for the step-by-step plan.`)
}

const ensureWorkflowNamespace = (handle: WorkflowHandle): string => {
  if (!handle.namespace || handle.namespace.trim().length === 0) {
    throw new Error('Workflow handle must include a non-empty namespace')
  }
  return handle.namespace
}

export const buildSignalRequest = (
  handle: WorkflowHandle,
  signalName: string,
  args: unknown[],
): Record<string, unknown> => {
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
    args: Array.isArray(args) ? [...args] : [],
  }

  if (handle.runId) {
    payload.run_id = handle.runId
  }

  if (handle.firstExecutionRunId) {
    payload.first_execution_run_id = handle.firstExecutionRunId
  }

  return payload
}

export const buildQueryRequest = (
  handle: WorkflowHandle,
  queryName: string,
  args: unknown[],
): Record<string, unknown> => {
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
    args: Array.isArray(args) ? [...args] : [],
  }

  if (handle.runId) {
    payload.run_id = handle.runId
  }

  if (handle.firstExecutionRunId) {
    payload.first_execution_run_id = handle.firstExecutionRunId
  }

  return payload
}

export const buildTerminateRequest = (
  handle: WorkflowHandle,
  options: TerminateWorkflowOptions = {},
): Record<string, unknown> => {
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
    payload.details = options.details
  }

  return payload
}

export const buildCancelRequest = (handle: WorkflowHandle): Record<string, unknown> => {
  void handle
  // TODO(codex): Emit cancellation payloads for `temporal_bun_client_cancel_workflow` per ${FFI_SURFACE_DOC}.
  return notImplemented('Workflow cancel serialization', FFI_SURFACE_DOC)
}

export const buildSignalWithStartRequest = ({
  options,
  defaults,
}: {
  options: SignalWithStartOptions
  defaults: { namespace: string; identity: string; taskQueue: string }
}): Record<string, unknown> => {
  const payload = buildStartWorkflowRequest({ options, defaults })
  return {
    ...payload,
    signal_name: options.signalName,
    signal_args: options.signalArgs ?? [],
  }
}

export const buildStartWorkflowRequest = ({
  options,
  defaults,
}: {
  options: StartWorkflowOptions
  defaults: { namespace: string; identity: string; taskQueue: string }
}): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    namespace: options.namespace ?? defaults.namespace,
    workflow_id: options.workflowId,
    workflow_type: options.workflowType,
    task_queue: options.taskQueue ?? defaults.taskQueue,
    identity: options.identity ?? defaults.identity,
    args: options.args ?? [],
  }

  if (options.cronSchedule) {
    payload.cron_schedule = options.cronSchedule
  }

  if (options.memo) {
    payload.memo = options.memo
  }

  if (options.headers) {
    payload.headers = options.headers
  }

  if (options.searchAttributes) {
    payload.search_attributes = options.searchAttributes
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
