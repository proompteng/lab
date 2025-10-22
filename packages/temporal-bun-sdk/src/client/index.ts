// Client implementation for @proompteng/temporal-bun-sdk
export interface TemporalClientConfig {
  address?: string
  namespace?: string
  apiKey?: string
  tls?: {
    caPath?: string
    certPath?: string
    keyPath?: string
    serverName?: string
  }
}

export interface WorkflowStartOptions {
  workflowId: string
  workflowType: string
  taskQueue: string
  args?: unknown[]
  namespace?: string
  identity?: string
  memo?: Record<string, unknown>
  headers?: Record<string, unknown>
  cronSchedule?: string
  workflowExecutionTimeout?: string
  workflowRunTimeout?: string
  workflowTaskTimeout?: string
  retryPolicy?: {
    initialInterval?: string
    backoffCoefficient?: number
    maximumInterval?: string
    maximumAttempts?: number
  }
}

export interface WorkflowHandle {
  workflowId: string
  runId: string
  firstExecutionRunId?: string
  namespace: string
}

export class TemporalClient {
  private config: TemporalClientConfig

  constructor(config: TemporalClientConfig = {}) {
    this.config = {
      address: 'http://127.0.0.1:7233',
      namespace: 'default',
      ...config,
    }
  }

  async describeNamespace(namespace: string = this.config.namespace || 'default'): Promise<{ name: string }> {
    // Mock implementation
    return { name: namespace }
  }

  async startWorkflow(options: WorkflowStartOptions): Promise<WorkflowHandle> {
    // Mock implementation
    return {
      workflowId: options.workflowId,
      runId: `run_${Date.now()}`,
      firstExecutionRunId: `run_${Date.now()}`,
      namespace: options.namespace || this.config.namespace || 'default',
    }
  }

  async close(): Promise<void> {
    // Mock implementation
  }
}

export async function createTemporalClient(config: TemporalClientConfig = {}): Promise<{ client: TemporalClient }> {
  const client = new TemporalClient(config)
  return { client }
}
