export interface BridgeClientConfig {
  address: string
  namespace: string
  identity?: string
  taskQueue?: string
  clientName?: string
  clientVersion?: string
  apiKey?: string
}

export interface BridgeStartWorkflowOptions {
  workflowId: string
  workflowType: string
  taskQueue?: string
  args?: unknown[]
  namespace?: string
  identity?: string
}

export interface BridgeStartWorkflowResult {
  runId: string
  workflowId: string
  namespace: string
}

export interface BridgeClient {
  startWorkflow(options: BridgeStartWorkflowOptions): Promise<BridgeStartWorkflowResult>
  close(): Promise<void>
}

export interface BridgeWorkerOptions {
  address: string
  namespace: string
  taskQueue: string
  workflowsPath: string
  activities: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>
  identity?: string
}

export interface BridgeWorker {
  run(): Promise<void>
  shutdown(): Promise<void>
}
