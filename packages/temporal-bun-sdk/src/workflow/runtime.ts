// Workflow runtime for @proompteng/temporal-bun-sdk
export interface WorkflowActivation {
  workflowId: string
  runId: string
  workflowType: string
  input?: unknown
  history?: unknown[]
  signals?: unknown[]
  queries?: unknown[]
  patches?: unknown[]
}

export interface WorkflowCompletion {
  success: boolean
  result?: unknown
  error?: string
  commands?: unknown[]
}

export class WorkflowRuntime {
  private workflowFn: (...args: unknown[]) => unknown
  private context: Record<string, unknown> = {}

  constructor(workflowFn: (...args: unknown[]) => unknown) {
    this.workflowFn = workflowFn
  }

  async execute(activation: WorkflowActivation): Promise<WorkflowCompletion> {
    try {
      // Set up workflow context
      this.context = {
        workflowId: activation.workflowId,
        runId: activation.runId,
        workflowType: activation.workflowType,
        input: activation.input,
        history: activation.history || [],
        signals: activation.signals || [],
        queries: activation.queries || [],
        patches: activation.patches || [],
      }

      // Execute workflow function
      const result = await this.workflowFn(activation.input)

      return {
        success: true,
        result: result,
        commands: [],
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        commands: [],
      }
    }
  }

  // Workflow context helpers
  getWorkflowId(): string {
    return this.context.workflowId
  }

  getRunId(): string {
    return this.context.runId
  }

  getWorkflowType(): string {
    return this.context.workflowType
  }

  getInput(): unknown {
    return this.context.input
  }

  getHistory(): unknown[] {
    return this.context.history as unknown[]
  }

  getSignals(): unknown[] {
    return this.context.signals as unknown[]
  }

  getQueries(): unknown[] {
    return this.context.queries as unknown[]
  }

  getPatches(): unknown[] {
    return this.context.patches as unknown[]
  }
}

// Workflow context for use in workflow functions
export function createWorkflowContext(activation: WorkflowActivation) {
  return {
    workflowId: activation.workflowId,
    runId: activation.runId,
    workflowType: activation.workflowType,
    input: activation.input,
    history: activation.history || [],
    signals: activation.signals || [],
    queries: activation.queries || [],
    patches: activation.patches || [],
  }
}

// Helper functions for workflow execution
export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

export function now(): Date {
  return new Date()
}

export function uuid(): string {
  return `workflow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}
