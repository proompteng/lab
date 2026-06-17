import { Data } from 'effect'

export type AgentRunStorageOperation =
  | 'open-store'
  | 'store-ready'
  | 'close-store'
  | 'list-runs'
  | 'read-delivery-id'
  | 'read-idempotency-key'
  | 'reserve-idempotency-key'
  | 'delete-idempotency-key'
  | 'assign-idempotency-key'
  | 'create-agent-run'
  | 'create-audit-event'

export type AgentRunKubeOperation =
  | 'create-client'
  | 'get-existing-run'
  | 'get-idempotent-run'
  | 'get-agent'
  | 'get-agent-provider'
  | 'get-implementation-spec'
  | 'get-vcs-provider'
  | 'evaluate-admission-limits'
  | 'apply-agent-run'

export class AgentRunInvalidPayloadError extends Data.TaggedError('AgentRunInvalidPayloadError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AgentRunStorageError extends Data.TaggedError('AgentRunStorageError')<{
  readonly operation: AgentRunStorageOperation
  readonly cause: unknown
}> {}

export class AgentRunKubeError extends Data.TaggedError('AgentRunKubeError')<{
  readonly operation: AgentRunKubeOperation
  readonly resource: string
  readonly namespace: string
  readonly cause: unknown
}> {}

export class AgentRunNotFoundError extends Data.TaggedError('AgentRunNotFoundError')<{
  readonly resource: string
  readonly name: string
  readonly namespace: string
}> {}

export class AgentRunPolicyDeniedError extends Data.TaggedError('AgentRunPolicyDeniedError')<{
  readonly subject: { kind: string; name: string; namespace?: string }
  readonly cause: unknown
}> {}

export class AgentRunAdmissionRejectedError extends Data.TaggedError('AgentRunAdmissionRejectedError')<{
  readonly message: string
  readonly status: number
  readonly details?: Record<string, unknown>
}> {}

export class AgentRunConflictError extends Data.TaggedError('AgentRunConflictError')<{
  readonly message: string
  readonly details?: Record<string, unknown>
}> {}

export class AgentRunForbiddenError extends Data.TaggedError('AgentRunForbiddenError')<{
  readonly message: string
}> {}

export type AgentRunSubmitError =
  | AgentRunInvalidPayloadError
  | AgentRunStorageError
  | AgentRunKubeError
  | AgentRunNotFoundError
  | AgentRunPolicyDeniedError
  | AgentRunAdmissionRejectedError
  | AgentRunConflictError
  | AgentRunForbiddenError

export type AgentRunSubmitSuccess = {
  status: number
  body: Record<string, unknown>
}

export const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const describeAgentRunSubmitError = (error: unknown) => {
  if (error instanceof AgentRunInvalidPayloadError) return error.message
  if (error instanceof AgentRunNotFoundError) {
    return `${error.resource} ${error.name} not found in namespace ${error.namespace}`
  }
  if (error instanceof AgentRunForbiddenError) return error.message
  if (error instanceof AgentRunConflictError) return error.message
  if (error instanceof AgentRunAdmissionRejectedError) return error.message
  if (error instanceof AgentRunPolicyDeniedError) {
    return `policy denied for ${error.subject.kind} ${error.subject.namespace}/${error.subject.name}: ${toErrorMessage(
      error.cause,
    )}`
  }
  if (error instanceof AgentRunStorageError) {
    return `agent run storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof AgentRunKubeError) {
    return `kubernetes ${error.operation} failed for ${error.resource} in namespace ${error.namespace}: ${toErrorMessage(
      error.cause,
    )}`
  }
  return toErrorMessage(error)
}

export const agentRunSubmitStatus = (error: unknown) => {
  if (error instanceof AgentRunInvalidPayloadError) return 400
  if (error instanceof AgentRunNotFoundError) return 404
  if (error instanceof AgentRunPolicyDeniedError || error instanceof AgentRunForbiddenError) return 403
  if (error instanceof AgentRunConflictError) return 409
  if (error instanceof AgentRunAdmissionRejectedError) return error.status
  if (error instanceof AgentRunKubeError) return 502
  if (error instanceof AgentRunStorageError) return 503
  return 500
}

export const agentRunSubmitDetails = (error: unknown) => {
  if (error instanceof AgentRunConflictError || error instanceof AgentRunAdmissionRejectedError) {
    return error.details
  }
  return undefined
}
