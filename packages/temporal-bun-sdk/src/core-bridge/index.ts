// Core bridge implementation for @proompteng/temporal-bun-sdk
export * from '../internal/core-bridge/native'

export interface RuntimeOptions {
  telemetry?: {
    prometheus?: {
      bindAddress?: string
    }
    otlp?: {
      endpoint?: string
    }
  }
  logging?: {
    level?: string
    forwardTo?: (level: string, message: string) => void
  }
  metrics?: {
    prometheus?: {
      bindAddress?: string
    }
    otlp?: {
      endpoint?: string
    }
  }
}

export interface ClientConfig {
  address: string
  namespace: string
  apiKey?: string
  tls?: {
    caPath?: string
    certPath?: string
    keyPath?: string
    serverName?: string
  }
}

export interface WorkerConfig {
  taskQueue: string
  namespace: string
  workflowsPath?: string
  activities?: Record<string, (...args: unknown[]) => unknown>
  concurrency?: {
    workflow?: number
    activity?: number
  }
}

export class CoreRuntime {
  private readonly handle: number

  constructor(options: RuntimeOptions = {}) {
    this.handle = require('../internal/core-bridge/native').createRuntime(options)
  }

  async shutdown(): Promise<void> {
    require('../internal/core-bridge/native').freeRuntime(this.handle)
  }

  getHandle(): number {
    return this.handle
  }

  async configureTelemetry(options: RuntimeOptions['telemetry']): Promise<void> {
    const result = require('../internal/core-bridge/native').updateTelemetry(this.handle, options)
    if (result !== 0) {
      throw new Error(`Failed to configure telemetry: ${result}`)
    }
  }

  async installLogger(_logger: (level: string, message: string) => void): Promise<void> {
    // Store logger reference for native bridge to use
    const loggerPtr = 1 // Mock pointer
    const result = require('../internal/core-bridge/native').setLogger(this.handle, loggerPtr)
    if (result !== 0) {
      throw new Error(`Failed to install logger: ${result}`)
    }
  }
}

export class CoreClient {
  private readonly handle: number

  private constructor(handle: number) {
    this.handle = handle
  }

  static async create(runtime: CoreRuntime, config: ClientConfig): Promise<CoreClient> {
    const handle = await require('../internal/core-bridge/native').createClient(runtime.getHandle(), config)
    return new CoreClient(handle)
  }

  async shutdown(): Promise<void> {
    require('../internal/core-bridge/native').freeClient(this.handle)
  }

  getHandle(): number {
    return this.handle
  }

  async describeNamespace(namespace: string): Promise<{ name: string }> {
    return require('../internal/core-bridge/native').describeNamespace(this.handle, namespace)
  }

  async startWorkflow(options: {
    workflowId: string
    workflowType: string
    taskQueue: string
    args: unknown[]
  }): Promise<{ workflowId: string; runId: string; namespace: string }> {
    return require('../internal/core-bridge/native').startWorkflow(this.handle, options)
  }

  async signalWorkflow(options: {
    workflowId: string
    runId?: string
    signalName: string
    args: unknown[]
    namespace?: string
  }): Promise<{ success: boolean }> {
    return require('../internal/core-bridge/native').signalWorkflow(this.handle, options)
  }

  async queryWorkflow(options: {
    workflowId: string
    runId?: string
    queryName: string
    args: unknown[]
    namespace?: string
  }): Promise<{ result: unknown }> {
    return require('../internal/core-bridge/native').queryWorkflow(this.handle, options)
  }

  async terminateWorkflow(options: {
    workflowId: string
    runId?: string
    reason?: string
    namespace?: string
  }): Promise<{ success: boolean }> {
    return require('../internal/core-bridge/native').terminateWorkflow(this.handle, options)
  }

  async cancelWorkflow(options: {
    workflowId: string
    runId?: string
    namespace?: string
  }): Promise<{ success: boolean }> {
    return require('../internal/core-bridge/native').cancelWorkflow(this.handle, options)
  }

  async signalWithStart(options: {
    workflowId: string
    workflowType: string
    taskQueue: string
    signalName: string
    signalArgs: unknown[]
    workflowArgs: unknown[]
    namespace?: string
  }): Promise<{ workflowId: string; runId: string; namespace: string }> {
    return require('../internal/core-bridge/native').signalWithStart(this.handle, options)
  }
}

export class CoreWorker {
  private handle: number

  constructor(runtime: CoreRuntime, client: CoreClient, config: WorkerConfig) {
    this.handle = require('../internal/core-bridge/native').createWorker(
      runtime.getHandle(),
      client.getHandle(),
      config,
    )
  }

  async shutdown(): Promise<void> {
    require('../internal/core-bridge/native').freeWorker(this.handle)
  }

  getHandle(): number {
    return this.handle
  }

  async pollWorkflowTask(): Promise<unknown | null> {
    return require('../internal/core-bridge/native').pollWorkflowTask(this.handle)
  }

  async completeWorkflowTask(payload: unknown): Promise<void> {
    const result = require('../internal/core-bridge/native').completeWorkflowTask(this.handle, payload)
    if (result !== 0) {
      throw new Error(`Failed to complete workflow task: ${result}`)
    }
  }

  async pollActivityTask(): Promise<unknown | null> {
    return require('../internal/core-bridge/native').pollActivityTask(this.handle)
  }

  async completeActivityTask(payload: unknown): Promise<void> {
    const result = require('../internal/core-bridge/native').completeActivityTask(this.handle, payload)
    if (result !== 0) {
      throw new Error(`Failed to complete activity task: ${result}`)
    }
  }

  async recordActivityHeartbeat(payload: unknown): Promise<void> {
    const result = require('../internal/core-bridge/native').recordActivityHeartbeat(this.handle, payload)
    if (result !== 0) {
      throw new Error(`Failed to record activity heartbeat: ${result}`)
    }
  }

  async initiateShutdown(): Promise<void> {
    const result = require('../internal/core-bridge/native').initiateShutdown(this.handle)
    if (result !== 0) {
      throw new Error(`Failed to initiate shutdown: ${result}`)
    }
  }

  async finalizeShutdown(): Promise<void> {
    const result = require('../internal/core-bridge/native').finalizeShutdown(this.handle)
    if (result !== 0) {
      throw new Error(`Failed to finalize shutdown: ${result}`)
    }
  }
}
