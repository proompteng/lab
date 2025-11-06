export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

export interface WorkflowNondeterminismDetails {
  readonly expected?: unknown
  readonly received?: unknown
  readonly hint?: string
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
