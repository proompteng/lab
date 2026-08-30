export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

import type { DeterminismMismatch } from './replay'

export interface WorkflowNondeterminismDetails {
  readonly expected?: unknown
  readonly received?: unknown
  readonly hint?: string
  readonly mismatches?: DeterminismMismatch[]
  readonly workflow?: {
    readonly namespace: string
    readonly taskQueue: string
    readonly workflowId: string
    readonly runId: string
    readonly workflowType?: string
  }
  readonly workflowTaskAttempt?: number
  readonly stickyCache?: {
    readonly cachedEventId?: string | null
    readonly historyLastEventId?: string | null
  }
}

export class WorkflowNondeterminismError extends WorkflowError {
  readonly details?: WorkflowNondeterminismDetails

  constructor(message: string, details?: WorkflowNondeterminismDetails) {
    super(message)
    this.name = 'WorkflowNondeterminismError'
    this.details = details
  }
}

export class WorkflowBlockedError extends WorkflowError {
  readonly reason: string

  constructor(reason: string) {
    super(`Workflow blocked: ${reason}`)
    this.name = 'WorkflowBlockedError'
    this.reason = reason
  }
}

export class WorkflowDeterminismGuardError extends WorkflowError {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowDeterminismGuardError'
  }
}

export class ContinueAsNewWorkflowError extends WorkflowError {
  constructor() {
    super('Workflow requested continue-as-new')
    this.name = 'ContinueAsNewWorkflowError'
  }
}

export class WorkflowQueryHandlerMissingError extends WorkflowError {
  constructor(queryName: string) {
    super(`Workflow query handler not registered for "${queryName}"`)
    this.name = 'WorkflowQueryHandlerMissingError'
  }
}

export class WorkflowQueryViolationError extends WorkflowError {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowQueryViolationError'
  }
}
