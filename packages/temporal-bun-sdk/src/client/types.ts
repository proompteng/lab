import type { VersioningBehavior } from '../proto/temporal/api/enums/v1/workflow_pb'

export interface WorkflowHandle {
  workflowId: string
  namespace?: string
  runId?: string
  firstExecutionRunId?: string
}

export interface WorkflowHandleMetadata {
  workflowId: string
  runId: string
  namespace: string
  firstExecutionRunId?: string
}

export interface StartWorkflowResult extends WorkflowHandleMetadata {
  handle: WorkflowHandle
}

export const createWorkflowHandle = (metadata: WorkflowHandleMetadata): WorkflowHandle => ({
  workflowId: metadata.workflowId,
  runId: metadata.runId,
  firstExecutionRunId: metadata.firstExecutionRunId,
  namespace: metadata.namespace,
})

export interface RetryPolicyOptions {
  initialIntervalMs?: number
  maximumIntervalMs?: number
  maximumAttempts?: number
  backoffCoefficient?: number
  nonRetryableErrorTypes?: string[]
}

export interface StartWorkflowOptions {
  workflowId: string
  workflowType: string
  args?: unknown[]
  taskQueue?: string
  namespace?: string
  identity?: string
  versioningBehavior?: VersioningBehavior
  cronSchedule?: string
  memo?: Record<string, unknown>
  headers?: Record<string, unknown>
  searchAttributes?: Record<string, unknown>
  requestId?: string
  workflowExecutionTimeoutMs?: number
  workflowRunTimeoutMs?: number
  workflowTaskTimeoutMs?: number
  retryPolicy?: RetryPolicyOptions
}

export interface TerminateWorkflowOptions {
  reason?: string
  details?: unknown[]
  firstExecutionRunId?: string
  runId?: string
}

export interface SignalWithStartOptions extends StartWorkflowOptions {
  signalName: string
  signalArgs?: unknown[]
}

export type WorkflowUpdateStage = 'unspecified' | 'admitted' | 'accepted' | 'completed'

export interface WorkflowUpdateOptions {
  updateName: string
  args?: unknown[]
  headers?: Record<string, unknown>
  updateId?: string
  waitForStage?: WorkflowUpdateStage
  firstExecutionRunId?: string
}

export interface WorkflowUpdateHandle extends WorkflowHandle {
  updateId: string
}

export interface WorkflowUpdateOutcome<T = unknown> {
  status: 'success' | 'failure'
  result?: T
  error?: Error
}

export interface WorkflowUpdateResult<T = unknown> {
  handle: WorkflowUpdateHandle
  stage: WorkflowUpdateStage
  outcome?: WorkflowUpdateOutcome<T>
}

export interface WorkflowUpdateAwaitOptions {
  waitForStage?: WorkflowUpdateStage
  firstExecutionRunId?: string
}
